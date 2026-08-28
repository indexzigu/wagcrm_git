import { z } from "zod";
import { dealRepository } from "@/repositories/dealRepository";
import { containsSearch } from "@/lib/prisma-search";
import type { AgentTool, ToolResult } from "./types";
import { notFound, ok, queryFailed } from "./types";
// Data 타입(+구성 타입)은 런타임-프리 모듈로 이동됐다(청사진 §2-1/§3-1, 번들 안전).
// 기존 import 경로(`./search-deals`) 호환을 위해 여기서 type re-export한다 —
// 런타임 코드는 변경 없음(diff는 타입 이동뿐).
import type { DealSearchResultItem, SearchDealsData } from "./data-types";

export type { DealSearchResultItem, SearchDealsData };

const DEAL_STATUSES = ["SOURCING", "NEGOTIATING", "CONFIRMED", "SAMPLE_TESTING", "ARCHIVED", "DROPPED"] as const;

const inputSchema = z.object({
  keyword: z.string().optional().describe("딜 이름/브랜드명 검색 키워드 (부분 일치)"),
  status: z.enum(DEAL_STATUSES).optional().describe("딜 상태 필터"),
  partnerName: z.string().optional().describe("거래처(파트너) 이름 필터 (부분 일치)"),
});

export type SearchDealsInput = z.infer<typeof inputSchema>;

const TAKE_LIMIT = 20;

async function execute(input: SearchDealsInput): Promise<ToolResult<SearchDealsData>> {
  const { keyword, status, partnerName } = input;

  try {
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (keyword) {
      where.OR = [{ dealName: containsSearch(keyword) }, { brandName: containsSearch(keyword) }];
    }
    if (partnerName) {
      where.partner = { name: containsSearch(partnerName) };
    }

    const deals = await dealRepository.findMany({
      where,
      include: { partner: true },
      orderBy: { updatedAt: "desc" },
      take: TAKE_LIMIT + 1,
    });

    if (deals.length === 0) {
      return notFound("검색 조건에 맞는 딜이 없습니다.", ["Deal"], { keyword, status, partnerName });
    }

    const truncated = deals.length > TAKE_LIMIT;
    const items: DealSearchResultItem[] = deals.slice(0, TAKE_LIMIT).map((d: any) => ({
      id: d.id,
      dealName: d.dealName,
      brandName: d.brandName ?? null,
      status: d.status,
      sellingPrice: Number(d.sellingPrice ?? 0),
      costPrice: Number(d.costPrice ?? 0),
      partnerName: d.partner?.name ?? null,
      updatedAt: d.updatedAt.toISOString(),
    }));

    return ok(
      { items, count: items.length, truncated },
      ["Deal", "Partner"],
      { keyword, status, partnerName }
    );
  } catch (err) {
    return queryFailed(
      err instanceof Error ? err.message : "딜 검색 중 오류가 발생했습니다.",
      ["Deal"],
      { keyword, status, partnerName }
    );
  }
}

export const searchDealsTool: AgentTool<SearchDealsInput, SearchDealsData> = {
  name: "search_deals",
  description:
    "딜(판매 조건) 목록을 키워드/상태/거래처명으로 검색합니다. 최대 20건을 반환하며, 그 이상은 truncated=true로 표시합니다.",
  inputSchema,
  execute,
};
