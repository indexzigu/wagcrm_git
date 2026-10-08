import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { recordActivityChange } from "@/lib/activity-log";
import { updateSettlementAmountArgsSchema } from "@/lib/agent-worker/contracts";
import { CAMPAIGN_INVALIDATION_TAGS } from "@/lib/cache-tags";
import type { DecimalLike } from "@/lib/campaign-row";
import {
  SETTLEMENT_AMOUNT_FIELD_LABELS,
  formatSettlementAmountKrw,
  type SettlementAmountField,
} from "@/lib/settlement-amount-fields";
import { resolveSettlementFlagSnapshot } from "@/lib/settlement-flag-write";
import { resolveCampaignMoneySlots } from "@/lib/tax-filing-board";
import {
  deriveCampaignFinancialsForUpdate,
  type FinancialDerivationData,
} from "@/services/campaignFinancialDerivation";
import { lockCampaignGroup } from "@/services/campaignGroupService";
import { assertEntityExists, type WriteActionDefinition, type WriteActionResult } from "./types";

export type UpdateSettlementAmountArgs = z.infer<typeof updateSettlementAmountArgsSchema>;

/**
 * 저장 시 자동 재계산이 값을 **덮어쓰는** 세 칸과 그 수동 고정 플래그.
 *
 * 재무 카드에서 이 칸들은 「자동/수동」 토글이 붙어 있고, 자동이면 저장할 때마다
 * `deriveCampaignFinancialsForUpdate` 가 요율로 다시 계산해 덮는다. 그래서 값만 쓰고 플래그를
 * 그대로 두면 **승인한 금액이 다음 저장(누가 무엇을 고치든)에 조용히 사라진다** — 오너가 화면에서
 * 그 칸을 직접 고칠 때 토글을 수동으로 바꾸는 것과 같은 일을 여기서 한다.
 */
const MANUAL_FLAG_BY_FIELD = {
  settlementSales: "isManualSettlementSales",
  sellerExpense: "isManualSellerExpense",
  taxExpense: "isManualTaxExpense",
} as const satisfies Partial<Record<SettlementAmountField, string>>;

type ManualFlag = (typeof MANUAL_FLAG_BY_FIELD)[keyof typeof MANUAL_FLAG_BY_FIELD];

function manualFlagFor(field: SettlementAmountField): ManualFlag | null {
  return Object.hasOwn(MANUAL_FLAG_BY_FIELD, field)
    ? MANUAL_FLAG_BY_FIELD[field as keyof typeof MANUAL_FLAG_BY_FIELD]
    : null;
}

/**
 * 저장값과 기안자가 본 값이 같은가 — **Decimal 로** 비교한다.
 *
 * ⛔ `Number(current) === expected` 로 바꾸지 말 것: 그러면 `null` 이 0 으로 접혀(`Number(null)`
 * 은 0) 「비어 있음」을 0원으로 본 기안이 통과한다. 물품대금의 0 은 「다른 캠페인 계산서에
 * 합산됨」 표시라 null 과 뜻이 반대다(`goods-cost.ts` 3-상태).
 */
function matchesExpected(current: DecimalLike, expected: number | null): boolean {
  if (current == null) return expected === null;
  if (expected === null) return false;
  return new Prisma.Decimal(current.toString()).equals(expected);
}

function toAmount(value: DecimalLike): number | null {
  return value == null ? null : Number(value.toString());
}

/**
 * 파생 계산에 넣을 「이번에 바뀌는 칸」. 공급가액·물품대금은 손익 파생의 입력이 아니므로
 * 비워서 넘긴다 — 그래도 파생은 정본 PATCH 와 똑같이 한 번 돈다(PATCH 도 어떤 칸을 고치든
 * 매번 다시 계산해 쓴다).
 */
function toDerivationData(field: SettlementAmountField, amount: number): FinancialDerivationData {
  switch (field) {
    case "actualSales":
      return { actualSales: amount };
    case "operatingExpense":
      return { operatingExpense: amount };
    case "miscExpense":
      return { miscExpense: amount };
    case "settlementSales":
      return { settlementSales: amount, isManualSettlementSales: true };
    case "sellerExpense":
      return { sellerExpense: amount, isManualSellerExpense: true };
    case "taxExpense":
      return { taxExpense: amount, isManualTaxExpense: true };
    case "settlementSupplyCost":
    case "settlementGoodsCost":
      return {};
  }
}

/**
 * 캠페인 정산 금액 칸 하나를 고친다 — 정산이 확정되기 **전**에만, 기안자가 본 값이 그대로일
 * 때만. 승인 라우트(`POST /api/action-proposals/[id]/approve`)가 연 tx 안에서 돈다.
 *
 * 가드 순서:
 *  ① 정산 확정 거부 — 그 채널의 대금 칸(`resolveCampaignMoneySlots`) 중 하나라도 확정
 *     표시가 켜져 있으면 고치지 않는다. 플래그의 정본은 묶음이면 **묶음 스칼라**다
 *     (`resolveSettlementFlagSnapshot`, CG-1) — 멤버 행 값은 낡을 수 있다.
 *  ② 현재 값 대조 — 저장값 = `expectedCurrentKrw`(Decimal 비교, null ≠ 0).
 *  ③ 조건부 쓰기 — ①②를 읽은 뒤 쓰기 전에 남이 먼저 고쳤으면 `count === 0` 으로 실패한다.
 *     `where` 에 칸 값·확정 표시·묶음 소속·`updatedAt` 을 함께 박는다. `updatedAt` 은
 *     **파생 입력** 보호다 — 다른 칸(예: 총 거래액)이 그 사이에 바뀌었다면 여기서 계산한
 *     영업이익이 낡은 값이라 덮어쓰면 안 된다.
 *
 * 🪤 **묶음 캠페인은 멤버 행 조건만으로 직렬화되지 않는다.** 확정 표시가 묶음 행에 사는데,
 * 첫 레그 확정(`writeSettlementFlags`)은 묶음 행만 쓰고 멤버 행(`updatedAt`)을 건드리지 않을 수
 * 있다 — 멤버 행 `updateMany` 의 관계 조건(`group.is`)은 묶음 행을 잠그지 않으므로, 확정이
 * 우리 쓰기와 겹쳐 커밋되면 「확정 뒤에 금액이 바뀐」 상태가 남는다. 그래서 묶음이면 쓰기 전에
 * ⓐ 그룹 락(`lockCampaignGroup` — 상태 연동 경로와 같은 「락 → 행」 순서)을 잡고 ⓑ **묶음 행
 * 자체를** 「미확정 · 이 캠페인이 아직 멤버」 조건으로 갱신해 행 잠금을 잡는다. 이후의 묶음
 * 확정은 우리 커밋을 기다리고, 우리보다 먼저 커밋된 확정은 ⓑ의 `count === 0` 으로 걸린다.
 * 행 잠금 순서(묶음 → 멤버)는 확정 경로·캠페인 PATCH 와 같다(교착 방지).
 */
async function handleUpdateSettlementAmount(
  args: UpdateSettlementAmountArgs,
  actor: string,
  tx: Prisma.TransactionClient,
): Promise<WriteActionResult> {
  await assertEntityExists("CAMPAIGN", args.campaignId, tx);

  const field = args.field;
  const label = SETTLEMENT_AMOUNT_FIELD_LABELS[field];

  // 🪤 `group` 을 빼지 말 것 — 확정 표시의 정본이 묶음 스칼라다(confirm_settlement 와 같은 함정).
  // `seller.agency` 는 파생 계산의 개인/사업자 판정 입력이다(정본 PATCH 의 `previous` 와 같은 칸).
  const campaign = await tx.salesCampaign.findUnique({
    where: { id: args.campaignId },
    include: {
      group: true,
      seller: { select: { agency: { select: { businessNumber: true } } } },
    },
  });
  if (!campaign) {
    throw new Error(`대상 캠페인(${args.campaignId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
  }
  const group = campaign.groupId ? campaign.group : null;

  // 총 거래액은 품목이 있으면 **품목 합계가 정본**이다 — 정본 PATCH 는 품목을 저장할 때 이 칸을
  // 품목 합으로 덮어쓰고(재무 카드도 이 칸을 읽기 전용으로 보여 준다), 파생 계산의 품목 보정
  // 루프는 이 칸이 아니라 품목 행을 읽는다. 품목을 그대로 둔 채 이 칸만 바꾸면 총 거래액과
  // 품목 합이 갈리고 손익은 움직이지 않는 조용한 어긋남이 생기므로 거부한다.
  if (field === "actualSales") {
    const dealCount = await tx.campaignDeal.count({ where: { campaignId: campaign.id } });
    if (dealCount > 0) {
      throw new Error(
        `정산 금액 수정 불가: 품목이 ${dealCount}개 있는 캠페인의 총 거래액은 품목 합계에서 정해집니다. ` +
          "재무 카드에서 품목 금액을 고치세요.",
      );
    }
  }

  // ① 정산 확정 거부.
  const slots = resolveCampaignMoneySlots(campaign.salesChannel);
  const flags = resolveSettlementFlagSnapshot(campaign, group);
  const confirmed = slots.filter((slot) => flags[slot.flagField]);
  if (confirmed.length > 0) {
    const what = confirmed.map((slot) => `${slot.counterpartLabel} ${slot.verb}`).join("·");
    throw new Error(
      `정산 금액 수정 불가: 이미 정산이 확정된 캠페인입니다(${what} 완료${group ? ", 묶음 캠페인 기준" : ""}). ` +
        "확정을 되돌린 뒤 다시 기안하세요.",
    );
  }

  // ② 현재 값 대조.
  const current = campaign[field];
  if (!matchesExpected(current, args.expectedCurrentKrw)) {
    throw new Error(
      `정산 금액 수정 불가: ${label}의 현재 값이 기안 때와 다릅니다 ` +
        `(기안: ${formatSettlementAmountKrw(args.expectedCurrentKrw)} · 현재: ${formatSettlementAmountKrw(toAmount(current))}). ` +
        "최신 값을 확인한 뒤 다시 기안하세요.",
    );
  }

  // 파생 재계산 — 정본 PATCH 와 **같은 함수**(`campaignService.updateCampaign` 도 이것을 부른다).
  const manualFlag = manualFlagFor(field);
  const { derivedFinancials, nextNetMarginRate } = await deriveCampaignFinancialsForUpdate(tx, {
    id: campaign.id,
    data: toDerivationData(field, args.newAmountKrw),
    previous: campaign,
  });

  // 사후 조건: 파생이 이번 칸을 다시 계산하는 칸이면, 수동 고정 덕분에 승인한 값 그대로여야 한다.
  // 어긋나면(수동 층위 규칙이 바뀌는 등) 승인한 금액과 다른 값이 저장되므로 쓰지 않는다.
  const derivedValue = (derivedFinancials as Partial<Record<string, number>>)[field];
  if (derivedValue !== undefined && derivedValue !== args.newAmountKrw) {
    throw new Error(
      `정산 금액 수정 실패: 재계산 결과(${formatSettlementAmountKrw(derivedValue)})가 승인할 ${label} ` +
        `${formatSettlementAmountKrw(args.newAmountKrw)}와 다릅니다. 재무 카드에서 직접 확인하세요.`,
    );
  }

  // ③ 조건부 쓰기.
  const unconfirmed = Object.fromEntries(slots.map((slot) => [slot.flagField, false]));
  if (group) {
    // ⓐ 그룹 락 → ⓑ 묶음 행 잠금(위 함수 주석 🪤). 데이터는 `updatedAt` 하나뿐이다 — 확정 표시를
    // 쓰는 것이 아니라 행을 잠그고 그 순간의 표시를 다시 확인하려는 쓰기다.
    await lockCampaignGroup(tx, group.id);
    const groupGuard = await tx.campaignGroup.updateMany({
      where: { id: group.id, members: { some: { id: campaign.id } }, ...unconfirmed },
      data: { updatedAt: new Date() },
    });
    if (groupGuard.count !== 1) {
      throw new Error(
        "정산 금액 수정 실패: 확인한 직후 묶음 캠페인의 정산이 확정되었거나 묶음 구성이 바뀌었습니다. 최신 상태를 확인한 뒤 다시 기안하세요.",
      );
    }
  }
  const where = {
    id: campaign.id,
    updatedAt: campaign.updatedAt,
    groupId: campaign.groupId,
    [field]: args.expectedCurrentKrw,
    ...(group ? { group: { is: unconfirmed } } : unconfirmed),
  } as Prisma.SalesCampaignWhereInput;
  const data = {
    ...derivedFinancials,
    [field]: args.newAmountKrw,
    ...(manualFlag ? { [manualFlag]: true } : {}),
    netMarginRate: nextNetMarginRate,
  } as Prisma.SalesCampaignUpdateManyMutationInput;

  const { count } = await tx.salesCampaign.updateMany({ where, data });
  if (count !== 1) {
    throw new Error(
      "정산 금액 수정 실패: 확인한 직후 다른 수정이나 정산 확정이 먼저 반영되었습니다. 최신 값을 확인한 뒤 다시 기안하세요.",
    );
  }

  // 감사 기록 — 칸 이름은 DB 필드명(정산 확정 경로와 같은 관례), 기안 메모는 `content` 로.
  await recordActivityChange(
    "CAMPAIGN",
    campaign.id,
    field,
    current == null ? null : current.toString(),
    String(args.newAmountKrw),
    actor,
    tx,
    args.memo ?? null,
  );
  const manualFlagTurnedOn = manualFlag !== null && !campaign[manualFlag];
  if (manualFlagTurnedOn) {
    await recordActivityChange("CAMPAIGN", campaign.id, manualFlag, false, true, actor, tx);
  }

  // 결과 요약 — 고친 칸 외에 **재계산으로 함께 바뀐 칸**도 적는다(정본 PATCH 와 같은 파생이
  // 자동 칸을 다시 쓰므로, 승인자가 그 사실을 실행 결과에서 볼 수 있어야 한다).
  const derivedLabels = {
    settlementSales: SETTLEMENT_AMOUNT_FIELD_LABELS.settlementSales,
    sellerExpense: SETTLEMENT_AMOUNT_FIELD_LABELS.sellerExpense,
    taxExpense: SETTLEMENT_AMOUNT_FIELD_LABELS.taxExpense,
    operatingProfit: "영업이익",
  } as const;
  const derivedChanges = (Object.keys(derivedLabels) as (keyof typeof derivedLabels)[])
    .filter((key) => key !== field && key in derivedFinancials)
    .map((key) => {
      const before = toAmount(campaign[key]);
      const after = (derivedFinancials as Partial<Record<string, number>>)[key] ?? null;
      return before === after
        ? null
        : `${derivedLabels[key]} ${formatSettlementAmountKrw(before)} → ${formatSettlementAmountKrw(after)}`;
    })
    .filter((line): line is string => line !== null);
  const parts = [
    `${label} ${formatSettlementAmountKrw(toAmount(current))} → ${formatSettlementAmountKrw(args.newAmountKrw)}`,
    ...(manualFlagTurnedOn ? ["자동 계산 → 수동 고정"] : []),
    ...derivedChanges,
  ];

  return {
    refType: "CAMPAIGN",
    refId: campaign.id,
    summary: `정산 금액 수정: ${parts.join(" · ")}`,
  };
}

export const updateSettlementAmountAction: WriteActionDefinition<UpdateSettlementAmountArgs> = {
  argsSchema: updateSettlementAmountArgsSchema,
  handler: handleUpdateSettlementAmount,
  // 정본 PATCH(`revalidateCampaignCaches()`)와 같은 캠페인 태그 묶음을 깬다.
  // 캘린더도 다시 맞춘다 — 대금 일정 이벤트가 이 칸들(영업 수익·총 거래액·판매대행비·물품대금)에서
  // 금액을 읽어 싣기 때문이다(`google-calendar-sync.ts` 의 `moneySlotAmount`). 동기화는 멱등이고
  // 실패해도 쓰기를 되돌리지 않는다(`write-action-effects.ts`). refId 는 위 핸들러의 campaignId 다.
  effects: (result) => ({
    revalidate: CAMPAIGN_INVALIDATION_TAGS,
    calendarCampaignId: result.refId,
  }),
};
