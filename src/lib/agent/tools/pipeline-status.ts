import { z } from "zod";
import { campaignRepository } from "@/repositories/campaignRepository";
import type { AgentTool, ToolResult } from "./types";
import { notFound, ok, queryFailed } from "./types";
// Data 타입(+구성 타입)은 런타임-프리 모듈로 이동됐다(청사진 §2-1/§3-1, 번들 안전).
// 기존 import 경로(`./pipeline-status`) 호환을 위해 여기서 type re-export한다 —
// 런타임 코드는 변경 없음(diff는 타입 이동뿐).
import type { PipelineStatusCount, PipelineCampaignSummary, GetPipelineStatusData } from "./data-types";

export type { PipelineStatusCount, PipelineCampaignSummary, GetPipelineStatusData };

// campaign-checklist.ts의 campaignChecklistStatusSchema와 동일한 상태값 집합.
const CAMPAIGN_STATUSES = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
  "DROPPED",
] as const;

const inputSchema = z.object({
  sellerName: z.string().optional().describe("셀러 이름으로 필터링 (부분 일치)"),
  status: z.enum(CAMPAIGN_STATUSES).optional().describe("특정 상태만 조회 (미지정 시 전체 상태 집계)"),
});

export type GetPipelineStatusInput = z.infer<typeof inputSchema>;

const DETAIL_TAKE_LIMIT = 20;

async function execute(input: GetPipelineStatusInput): Promise<ToolResult<GetPipelineStatusData>> {
  const { sellerName, status } = input;

  try {
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (sellerName) {
      where.seller = { name: { contains: sellerName } };
    }

    // TODO(m1): 전체 캠페인 row를 findMany로 끌어와 애플리케이션 레벨에서 집계(countMap)한다.
    // v1 데이터 규모(캠페인 수 적음)에서는 문제없지만, 데이터가 커지면 Prisma groupBy(status)로
    // 이관해 DB에서 집계하도록 바꿔야 한다 (리뷰 지적 m1 — 이번 라운드는 규모상 스킵, 후순위).
    const campaigns = await campaignRepository.findMany({
      where,
      include: { deal: true, seller: true },
      orderBy: { updatedAt: "desc" },
    });

    if (campaigns.length === 0) {
      return notFound(
        "조건에 맞는 캠페인이 없습니다.",
        ["SalesCampaign"],
        { sellerName, status }
      );
    }

    const countMap = new Map<string, number>();
    for (const c of campaigns as any[]) {
      countMap.set(c.status, (countMap.get(c.status) ?? 0) + 1);
    }
    const statusCounts: PipelineStatusCount[] = Array.from(countMap.entries()).map(([s, count]) => ({
      status: s,
      count,
    }));

    const detailSource = status ? (campaigns as any[]) : [];
    const campaignSummaries: PipelineCampaignSummary[] = detailSource.slice(0, DETAIL_TAKE_LIMIT).map((c) => ({
      id: c.id,
      dealName: c.deal?.dealName ?? "",
      sellerName: c.seller?.name ?? "",
      status: c.status,
      startDate: c.startDate.toISOString().split("T")[0],
      endDate: c.endDate.toISOString().split("T")[0],
    }));

    return ok(
      {
        statusCounts,
        totalCount: campaigns.length,
        campaigns: campaignSummaries,
      },
      ["SalesCampaign", "Deal", "Seller"],
      { sellerName, status }
    );
  } catch (err) {
    return queryFailed(
      err instanceof Error ? err.message : "파이프라인 상태 조회 중 오류가 발생했습니다.",
      ["SalesCampaign"],
      { sellerName, status }
    );
  }
}

export const getPipelineStatusTool: AgentTool<GetPipelineStatusInput, GetPipelineStatusData> = {
  name: "get_pipeline_status",
  description:
    "판매 캠페인 파이프라인 현황을 상태별로 집계합니다(PROPOSAL/PREPARATION/ACTIVE/CLOSED/SETTLEMENT_WAIT/SETTLEMENT_IN_PROGRESS/COMPLETED/DROPPED). 특정 status를 지정하면 해당 상태의 캠페인 목록(최대 20건)도 함께 반환합니다.",
  inputSchema,
  execute,
};
