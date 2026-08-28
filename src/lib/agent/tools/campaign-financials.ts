import { z } from "zod";
import { campaignRepository } from "@/repositories/campaignRepository";
import { calculateDerivedCampaignFinancials } from "@/lib/campaign-financials";
import type { AgentTool, ToolResult } from "./types";
import { missingParam, notFound, ok, queryFailed } from "./types";
// Data 타입은 런타임-프리 모듈로 이동됐다(청사진 §2-1/§3-1, 번들 안전). 기존 import 경로
// (`./campaign-financials`) 호환을 위해 여기서 type re-export한다 — 런타임 코드는 변경 없음
// (diff는 타입 이동뿐, 금전 인접 로직 무변경).
import type { GetCampaignFinancialsData } from "./data-types";

export type { GetCampaignFinancialsData };

const inputSchema = z.object({
  campaignId: z.string().min(1, "campaignId는 필수입니다").describe("조회할 SalesCampaign의 id (필수)"),
});

export type GetCampaignFinancialsInput = z.infer<typeof inputSchema>;

async function execute(input: GetCampaignFinancialsInput): Promise<ToolResult<GetCampaignFinancialsData>> {
  const { campaignId } = input;

  if (!campaignId || campaignId.trim() === "") {
    return missingParam("campaignId가 필요합니다. 어느 캠페인의 재무 정보를 조회할지 알려주세요.");
  }

  try {
    const campaign = await campaignRepository.findById(campaignId);

    if (!campaign) {
      return notFound(
        `campaignId=${campaignId}에 해당하는 캠페인을 찾을 수 없습니다.`,
        ["SalesCampaign"],
        { campaignId }
      );
    }

    const c = campaign as any;

    const derived = calculateDerivedCampaignFinancials({
      actualSales: Number(c.actualSales ?? 0),
      operatingExpense: Number(c.operatingExpense ?? 0),
      miscExpense: Number(c.miscExpense ?? 0),
      totalMarginRate: Number(c.totalMarginRate ?? 0),
      sellerMarginRate: Number(c.sellerMarginRate ?? 0),
      sellerTaxType: c.sellerTaxType ?? null,
      sellerCompanyBusinessNumber: c.seller?.agency?.businessNumber ?? null,
      isManualSettlementSales: c.isManualSettlementSales ?? false,
      isManualSellerExpense: c.isManualSellerExpense ?? false,
      isManualTaxExpense: c.isManualTaxExpense ?? false,
      manualSettlementSales: c.settlementSales != null ? Number(c.settlementSales) : null,
      manualSellerExpense: c.sellerExpense != null ? Number(c.sellerExpense) : null,
      manualTaxExpense: c.taxExpense != null ? Number(c.taxExpense) : null,
    });

    return ok(
      {
        campaignId: c.id,
        dealName: c.deal?.dealName ?? "",
        sellerName: c.seller?.name ?? "",
        status: c.status,
        actualSales: Number(c.actualSales ?? 0),
        derived,
        isDepositReceived: c.isDepositReceived ?? false,
        isPayoutCompleted: c.isPayoutCompleted ?? false,
      },
      ["SalesCampaign", "Deal", "Seller"],
      { campaignId }
    );
  } catch (err) {
    return queryFailed(
      err instanceof Error ? err.message : "캠페인 재무 정보 조회 중 오류가 발생했습니다.",
      ["SalesCampaign"],
      { campaignId }
    );
  }
}

export const getCampaignFinancialsTool: AgentTool<GetCampaignFinancialsInput, GetCampaignFinancialsData> = {
  name: "get_campaign_financials",
  description:
    "특정 캠페인(campaignId 필수)의 재무 파생값(정산매출/셀러비용/세금/영업이익)을 계산해 반환합니다. 이 값은 계산된 파생치이며 정산 확정치가 아닙니다 — isDepositReceived/isPayoutCompleted로 실제 입금/지급 여부를 함께 확인하십시오.",
  inputSchema,
  execute,
};
