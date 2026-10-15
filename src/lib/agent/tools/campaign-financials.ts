import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { isPermissionDeniedError } from "@/lib/db-permission-denied";
import { computeOperatingProfit } from "@/lib/campaign-financials";
import { SETTLEMENT_AMOUNT_FIELD_LABELS, type SettlementAmountField } from "@/lib/settlement-amount-fields";
import type { AgentTool, ToolResult } from "./types";
import { missingParam, notFound, ok, queryFailed } from "./types";
// Data 타입은 런타임-프리 모듈에 있다(청사진 §2-1/§3-1, 번들 안전). 옛 `derived`(재계산) 모양
// `GetCampaignFinancialsData` 는 결재함 카드가 옛 기록을 그리려고 남겨 둔 타입이다 — 이 도구는 더 내지 않는다.
import type { GetCampaignFinancialsStoredData } from "./data-types";

export type { GetCampaignFinancialsStoredData };

const inputSchema = z.object({
  campaignId: z.string().min(1, "campaignId는 필수입니다").describe("조회할 SalesCampaign의 id (필수)"),
});

export type GetCampaignFinancialsInput = z.infer<typeof inputSchema>;

/** 정산 금액 수정 기안이 고칠 수 있는 칸 = 이 조회가 저장값으로 내는 칸(같은 목록). */
const STORED_AMOUNT_FIELDS = Object.keys(SETTLEMENT_AMOUNT_FIELD_LABELS) as SettlementAmountField[];

/**
 * 조회 칸 — 봇(Agent Worker)도 이 도구를 그대로 부르므로 워커 role(`wag_agent_worker`)의 GRANT
 * 범위(SalesCampaign·Deal·Seller 테이블 SELECT) 안에 있어야 한다. CampaignDeal·Partner(agency)를
 * 넣지 말 것 — 워커 role 에 권한이 없다(`executor.test.ts` 가 이 모양을 그대로 고정한다).
 */
const CAMPAIGN_FINANCIALS_SELECT = {
  id: true,
  status: true,
  actualSales: true,
  settlementSales: true,
  sellerExpense: true,
  taxExpense: true,
  operatingExpense: true,
  miscExpense: true,
  settlementSupplyCost: true,
  settlementGoodsCost: true,
  operatingProfit: true,
  isManualSettlementSales: true,
  isManualSellerExpense: true,
  isManualTaxExpense: true,
  sellerFeeBasisOverride: true,
  isDepositReceived: true,
  isPayoutCompleted: true,
  deal: { select: { dealName: true } },
  seller: { select: { name: true } },
} as const;

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * 캠페인 손익 조회 — **저장된 금액을 그대로** 돌려준다(재계산하지 않는다). 봇(`agent-worker/executor.ts`
 * `campaignFinancials`)이 `runTool` 로 이 도구를 부르므로 웹·봇이 같은 칸·같은 값을 본다.
 *
 * ⛔ 여기서 `calculateDerivedCampaignFinancials` 로 다시 계산하지 말 것. 그 함수는 캠페인 단위
 * 요율(`totalMarginRate`·`sellerMarginRate`) 하나로 곱하는데, 품목(CampaignDeal)마다 요율이 다른
 * 캠페인은 writer(캠페인 저장·주문 동기화·실매출 입력)가 **품목 루프로** 확정한 값을 저장한다.
 * 그래서 다품목 캠페인에서 「총 거래액 × 캠페인 요율」이 재무 카드의 저장값과 다른 숫자로 나갔다.
 * 봇이 그 숫자를 `update_settlement_amount` 의 `expectedCurrentKrw` 로 쓰면 승인 시점 대조
 * (저장값 = 기대값)에서 막히거나, 틀린 「지금 값」으로 기안이 올라간다. 품목 요율을 읽어 재계산을
 * 맞추는 길은 워커 role 에 CampaignDeal 권한이 없어 막혀 있다(최소권한 유지).
 * → 재무 카드(`campaign-side-panel.tsx`)가 보여 주는 저장값을 1차 수치로 낸다. 금액 칸 목록은
 *   `SETTLEMENT_AMOUNT_FIELD_LABELS`(정산 금액 수정 기안이 고칠 수 있는 칸) 그대로다.
 *
 * ⚠️ `null` 은 「비어 있음」이다 — 0 으로 접지 말 것. 승인 시점 대조는 null ≠ 0 이다
 * (`write-actions/update-settlement-amount.ts` `matchesExpected`, 물품대금의 0 은 「다른 캠페인
 * 계산서에 합산됨」).
 * 영업이익만 재무 카드와 같은 폴백을 쓴다: 저장값이 있으면 그것, 없으면 저장된 칸들로
 * `computeOperatingProfit`(SSOT) — 품목 요율과 무관한 뺄셈이라 이 폴백은 카드와 같은 값이다.
 */
async function execute(input: GetCampaignFinancialsInput): Promise<ToolResult<GetCampaignFinancialsStoredData>> {
  const { campaignId } = input;

  if (!campaignId || campaignId.trim() === "") {
    return missingParam("campaignId가 필요합니다. 어느 캠페인의 재무 정보를 조회할지 알려주세요.");
  }

  try {
    const campaign = await getPrisma().salesCampaign.findUnique({
      where: { id: campaignId },
      select: CAMPAIGN_FINANCIALS_SELECT,
    });

    if (!campaign) {
      return notFound(
        `campaignId=${campaignId}에 해당하는 캠페인을 찾을 수 없습니다.`,
        ["SalesCampaign"],
        { campaignId }
      );
    }

    const amounts = Object.fromEntries(
      STORED_AMOUNT_FIELDS.map((field) => [field, toNullableNumber(campaign[field])]),
    ) as Record<SettlementAmountField, number | null>;
    const storedOperatingProfit = toNullableNumber(campaign.operatingProfit);
    const operatingProfit =
      storedOperatingProfit ??
      computeOperatingProfit({
        settlementSales: amounts.settlementSales ?? 0,
        sellerExpense: amounts.sellerExpense ?? 0,
        taxExpense: amounts.taxExpense ?? 0,
        operatingExpense: amounts.operatingExpense ?? 0,
        miscExpense: amounts.miscExpense ?? 0,
      });

    return ok(
      {
        campaignId: campaign.id,
        dealName: campaign.deal?.dealName ?? null,
        sellerName: campaign.seller?.name ?? null,
        status: campaign.status,
        source: "stored",
        ...amounts,
        operatingProfit,
        operatingProfitSource: storedOperatingProfit === null ? "computed_from_stored" : "stored",
        isManualSettlementSales: campaign.isManualSettlementSales ?? false,
        isManualSellerExpense: campaign.isManualSellerExpense ?? false,
        isManualTaxExpense: campaign.isManualTaxExpense ?? false,
        sellerFeeBasisOverride: toNullableNumber(campaign.sellerFeeBasisOverride),
        isDepositReceived: campaign.isDepositReceived,
        isPayoutCompleted: campaign.isPayoutCompleted,
        // 결재함 카드(`tool-result-views.tsx`)가 이 모양을 읽는다 — 생산자·소비자가 같은 타입을 본다.
      } satisfies GetCampaignFinancialsStoredData,
      ["SalesCampaign", "Deal", "Seller"],
      { campaignId }
    );
  } catch (err) {
    // 권한 거부(42501)는 감싸지 않는다 — 봇 실행기가 이 예외로 「재시도 불가(DB_PERMISSION_DENIED)」를
    // 판정한다. `queryFailed` 로 감싸면 재시도로 바뀌어 워커 role GRANT 회귀가 반복 재시도에 묻힌다.
    if (isPermissionDeniedError(err)) throw err;
    return queryFailed(
      err instanceof Error ? err.message : "캠페인 재무 정보 조회 중 오류가 발생했습니다.",
      ["SalesCampaign"],
      { campaignId }
    );
  }
}

export const getCampaignFinancialsTool: AgentTool<GetCampaignFinancialsInput, GetCampaignFinancialsStoredData> = {
  name: "get_campaign_financials",
  description:
    "특정 캠페인(campaignId 필수)에 저장된 정산 금액(실매출·영업 수익·판매대행비·세금·운영비·기타비용·공급가·물품대금)과 영업이익을 재계산 없이 반환합니다. CRM 재무 카드와 같은 값이며, null 은 「비어 있음」으로 0 과 다릅니다. 정산 확정치는 아닙니다 — isDepositReceived/isPayoutCompleted로 실제 입금/지급 여부를 함께 확인하십시오.",
  inputSchema,
  execute,
};
