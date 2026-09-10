import { z } from "zod";
import { PartnerRepository } from "@/repositories/partnerRepository";
import { AgentJobPartnerTypeSchema } from "@/lib/agent-worker/contracts";
import { containsSearch } from "@/lib/prisma-search";
import type { AgentTool, ToolResult } from "./types";
import { notFound, ok, queryFailed } from "./types";
// Data 타입은 search-deals.ts와 같은 자리(런타임-프리 모듈)에 둔다 — 클라이언트 리치
// 렌더가 나중에 붙어도 prisma 런타임이 번들로 딸려오지 않는다.
import type { PartnerSearchResultItem, SearchPartnersData } from "./data-types";

export type { PartnerSearchResultItem, SearchPartnersData };

/**
 * 거래처 구분 목록은 계약(`@/lib/agent-worker/contracts`)이 내보낸 열거형을 그대로
 * 부른다 — 여기서 다시 적으면 워커 경로와 웹 경로가 서로 다른 목록을 갖게 된다.
 */
const inputSchema = z
  .object({
    name: z.string().optional().describe("거래처 상호 검색 키워드 (부분 일치)"),
    type: AgentJobPartnerTypeSchema.optional().describe("거래처 구분 필터 (BRAND/VENDOR/AGENCY/AGENT/SELLER)"),
  })
  .strict();

export type SearchPartnersInput = z.infer<typeof inputSchema>;

const TAKE_LIMIT = 20;

/**
 * Partner 한 테이블만 본다 — 딜과 조인하지 않는다. 딜이 아직 하나도 없는 거래처가
 * 결과에서 빠지면 「거래처 먼저 등록 → 그 거래처에 단가표」 갈래가 다시 막힌다
 * (이 도구가 생기기 전의 구멍, 2026-09-10).
 */
async function execute(input: SearchPartnersInput): Promise<ToolResult<SearchPartnersData>> {
  const { name, type } = input;

  try {
    const partners = await PartnerRepository.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(name ? { name: containsSearch(name) } : {}),
      },
      select: { id: true, name: true, type: true, businessNumber: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: TAKE_LIMIT + 1,
    });

    if (partners.length === 0) {
      return notFound("검색 조건에 맞는 거래처가 없습니다.", ["Partner"], { name, type });
    }

    const truncated = partners.length > TAKE_LIMIT;
    const items: PartnerSearchResultItem[] = partners.slice(0, TAKE_LIMIT).map((partner) => ({
      id: partner.id,
      name: partner.name,
      type: partner.type,
      businessNumber: partner.businessNumber ?? null,
      updatedAt: partner.updatedAt.toISOString(),
    }));

    return ok({ items, count: items.length, truncated }, ["Partner"], { name, type });
  } catch (err) {
    return queryFailed(
      err instanceof Error ? err.message : "거래처 검색 중 오류가 발생했습니다.",
      ["Partner"],
      { name, type }
    );
  }
}

export const searchPartnersTool: AgentTool<SearchPartnersInput, SearchPartnersData> = {
  name: "search_partners",
  description:
    "거래처(브랜드/벤더/대행사/에이전트/셀러사)를 상호·구분으로 검색해 각 거래처의 내부 id를 " +
    "반환합니다. 이미 등록된 거래처에 딜을 붙일 때(create_deal의 partnerId) 필요한 id를 얻는 " +
    "유일한 조회 도구입니다. 딜이 아직 하나도 없는 거래처도 결과에 나옵니다. " +
    "같은 이름의 거래처가 여러 건일 수 있으므로 사업자번호를 함께 보여주고 사용자가 고르게 " +
    "하십시오. 최대 20건을 반환하며, 그 이상은 truncated=true로 표시합니다.",
  inputSchema,
  execute,
};
