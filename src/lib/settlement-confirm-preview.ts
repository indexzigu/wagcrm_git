import type { CampaignGroup, Prisma, SalesCampaign } from "@prisma/client";
import { sumMoneySlotAmounts, type MoneySlotAmountSource } from "@/lib/calendar-entities";
import { toKstYmd } from "@/lib/date-utils";
import { resolveSettlementFlagSnapshot } from "@/lib/settlement-flag-write";
import {
  deriveSettlementState,
  isValidSettlementAction,
  type SettlementCompletionFlags,
  type SettlementStateLabel,
  type SettlementTarget,
} from "@/lib/settlement-status";
import { resolveCampaignMoneySlots, type CampaignMoneySlot } from "@/lib/tax-filing-board";

/**
 * 정산 확정(`confirm_settlement`) 한 건이 **무엇을 얼마로 바꾸는가** — 실행기와 슬랙 카드가 함께 쓰는 판정 SSOT.
 *
 * 실행기(`write-actions/confirm-settlement.ts`)는 이 계획으로 검증·쓰기를 하고, 슬랙 카드
 * (`agent-internal/slack-approval-brief.ts`)는 같은 계획으로 「어느 칸 · 얼마 · 며칠」을 적는다.
 * ⛔ 카드 쪽에서 슬롯·금액·묶음 범위를 따로 다시 읽지 말 것 — 화면마다 같은 판정을 손으로 다시 만들다
 * 갈라지는 것이 이 레포의 반복 결함이다(종전 카드는 묶음 수만 따로 세고 금액은 「없습니다」라고 적었다).
 *
 * 이 모듈은 **던지지 않고 사실만 돌려준다** — 거절 문구는 실행기가, 버튼을 뺄지는 카드가 정한다.
 */

/** 계획이 읽는 클라이언트 — 실행기는 승인 트랜잭션, 카드는 `getPrisma()` 를 넘긴다. */
export type SettlementConfirmPlanClient = Pick<Prisma.TransactionClient, "salesCampaign">;

export type SettlementConfirmCampaign = SalesCampaign & { group: CampaignGroup | null };

export type SettlementConfirmPlan = {
  campaign: SettlementConfirmCampaign;
  /** 완료 플래그의 정본 행(CG-1) — 묶음 소속이면 묶음, 아니면 null. */
  group: CampaignGroup | null;
  /** 쓰기 전 플래그(정본 행 기준). */
  flags: SettlementCompletionFlags;
  state: SettlementStateLabel;
  /** 전진 전용 상태기계 판정(`isValidSettlementAction`). */
  validity: { ok: true } | { ok: false; reason: string };
  /** 대상 대금 칸. null = 이 채널에 그 칸이 없다. */
  slot: CampaignMoneySlot | null;
  /** 이 확정이 함께 바꾸는 캠페인(묶음이면 멤버 전원, 아니면 자기 자신). */
  members: SalesCampaign[];
  /** 멤버별 금액 근거 — 게이트 판정과 거절 문구가 같은 컬럼 집합을 보게 한 벌만 만든다. */
  sources: MoneySlotAmountSource[];
  /** 적용할 금액(멤버 합산, `sumMoneySlotAmounts`). null = 미정. */
  amountKrw: number | null;
  memberCount: number;
};

/**
 * 캠페인 행 → 슬롯 금액 SSOT 의 입력. 다섯 컬럼 전부 넘긴다 — 채널마다 금액 근거가 다르므로
 * SSOT 가 고를 수 있어야 한다(셀러몰 입금 = actualSales − sellerExpense, 브랜드몰 입금 =
 * settlementSales, 공급사 지급 = 수기 물품대금). 타입을 **필수 필드 쪽**
 * (`MoneySlotAmountSource`)으로 받는 것도 같은 이유다 — 선택 필드로 두면 컬럼 하나를
 * 빠뜨려도 컴파일이 통과해 금액이 조용히 「미정」이 된다(#479 의 형태).
 */
export function toMoneySlotSource(campaign: {
  actualSales: unknown;
  sellerExpense: unknown;
  settlementSales: unknown;
  actualPayoutAmount: unknown;
  settlementGoodsCost: unknown;
}): MoneySlotAmountSource {
  // ⚠️ **null 과 0 을 뭉개지 말 것** — 물품대금의 `0` 은 「합산 이관」 마커이고 null 은
  //    「미입력」이라 게이트 문구가 갈린다(`goods-cost.ts` 3-상태).
  const num = (value: unknown) => (value == null ? null : Number(value));
  return {
    actualSales: num(campaign.actualSales),
    sellerExpense: num(campaign.sellerExpense),
    settlementSales: num(campaign.settlementSales),
    actualPayoutAmount: num(campaign.actualPayoutAmount),
    settlementGoodsCost: num(campaign.settlementGoodsCost),
  };
}

/**
 * 확정할 실체 금액이 있는가 — 미정(null)·0 이하는 확정하지 않는다(security-reviewer H1/M1: 「유령 완료」 방지).
 * 실행기 게이트와 카드의 버튼 판정이 이 함수 하나를 본다.
 */
export function isConfirmableAmount(amount: number | null): amount is number {
  return amount != null && Number.isFinite(amount) && amount > 0;
}

/**
 * 계획을 읽는다. 캠페인이 없으면 null.
 *
 * 🪤 **`include: { group: true }` 를 빼지 말 것.** 완료 플래그의 정본은 그룹 스칼라이고(CG-1) 멤버 행 값은
 * 낡을 수 있다 — 종전엔 그룹을 조회조차 하지 않아 그룹 소속 캠페인의 전진 검증·상태 라벨·쓰기가 전부
 * **낡은 멤버 값** 위에서 돌았다(`settlement-flag-write` 헤더).
 * ⚠️ 채널은 대표 멤버 값을 쓴다 — 정본 토글 라우트와 같은 규약이다(조합은 채널이 하나라는 오너 확정
 * 2026-08-25). 여기만 멤버 채널 합집합으로 바꾸면 두 경로의 슬롯 판정이 갈린다.
 */
export async function resolveSettlementConfirmPlan(
  client: SettlementConfirmPlanClient,
  campaignId: string,
  target: SettlementTarget,
): Promise<SettlementConfirmPlan | null> {
  const campaign = await client.salesCampaign.findUnique({
    where: { id: campaignId },
    include: { group: true },
  });
  if (!campaign) return null;
  const group = campaign.groupId ? campaign.group : null;

  const flags = resolveSettlementFlagSnapshot(campaign, group);
  const flagSnapshot = { salesChannel: campaign.salesChannel, ...flags };
  // ⛔ 어느 칸인지 삼항으로 다시 정하지 말 것 — 타깃 값이 곧 슬롯 키이고, 채널별 칸은 슬롯 SSOT 가 정한다
  //    (자사몰 `payout` = 셀러 지급 · 셀러몰 `payout` = 공급사 지급).
  const slot = resolveCampaignMoneySlots(campaign.salesChannel).find((s) => s.key === target) ?? null;

  // ⚠️ **그룹이면 금액도 그룹 단위로 센다.** 플래그가 그룹 스칼라라 이 쓰기는 **조합 전체**를 확정하는데,
  // 대표 멤버 한 명의 금액으로 게이트를 통과시키면 게이트가 지키는 범위와 쓰기가 미치는 범위가 어긋난다.
  // 합산 규약(`CampaignGroup` 에는 정산 금액 컬럼 자체가 없다 — CG-1 · 물품대금은 「입력된 멤버만 더하기」가
  // 금지된 ALL_OR_NOTHING)은 `sumMoneySlotAmounts` 가 소유한다. ⛔ 전원 미입력은 0 이 아니라 `null`(미정)이다.
  const members: SalesCampaign[] = campaign.groupId
    ? await client.salesCampaign.findMany({ where: { groupId: campaign.groupId } })
    : [campaign];
  const sources = members.map(toMoneySlotSource);
  const amountKrw = slot ? sumMoneySlotAmounts(sources, slot) : null;

  return {
    campaign,
    group,
    flags,
    state: deriveSettlementState(flagSnapshot),
    validity: isValidSettlementAction(flagSnapshot, target),
    slot,
    members,
    sources,
    amountKrw,
    memberCount: members.length,
  };
}

/**
 * 지급일·입금일(`completedOn`, KST 달력 날짜 `YYYY-MM-DD`) 판정. 형식은 스키마(`z.string().date()`)가 이미 막지만,
 * 카드는 저장된 payload 를 다시 읽으므로 여기서도 본다.
 *
 * - 미래 날짜는 거부한다(아직 오가지 않은 돈을 완료로 적지 않는다). 하한은 없다 — 지난 지급을 늦게 적는 것은 정상이다.
 * - `now` 는 테스트 주입용. 「오늘」은 KST 기준(`toKstYmd`)이다.
 */
export function checkSettlementCompletedOn(
  completedOn: string,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const at = new Date(completedOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(completedOn) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== completedOn) {
    return { ok: false, reason: "지급 완료일이 올바른 날짜가 아닙니다. 날짜를 확인해 다시 기안합니다." };
  }
  if (completedOn > toKstYmd(now)) {
    return { ok: false, reason: "미래 날짜는 지급 완료일로 기록하지 않습니다. 날짜를 확인해 다시 기안합니다." };
  }
  return { ok: true };
}

/**
 * `completedOn` → 저장할 완료 시각. 날짜만 받는 완료일은 **UTC 자정**으로 저장하는 것이 이 레포의 규약이다 —
 * 캠페인 편집 저장(`campaign-update-plan.ts` 의 `settlementSync.payoutCompletedAt = new Date(data.payoutCompletedAt)`)이
 * 같은 칸을 같은 방식으로 쓴다. UTC 자정은 KST 같은 날 09:00 이라 화면(`toKstYmd`)이 그 날짜 그대로 읽는다.
 * ⛔ KST 자정(`+09:00`)으로 바꾸지 말 것 — 같은 날짜가 화면 저장과 봇 기안에서 다른 시각이 되고,
 *    `toISOString().slice(0, 10)` 로 읽는 곳은 하루 전날로 본다.
 */
export function toSettlementCompletedAt(completedOn: string | undefined, now: Date): Date {
  return completedOn ? new Date(completedOn) : now;
}

/**
 * 카드가 적는 값만 추린 모양 — 슬랙 카드(`slack-approval-brief.ts`)의 주입 의존이 돌려준다(테스트는 이 모양을 직접 만든다).
 * `ready` = 상태기계가 이 전진을 받는가. 금액·칸 판정은 실행기와 같은 계획에서 온다.
 */
export type SettlementConfirmPreview = {
  slot: Pick<CampaignMoneySlot, "counterpartLabel" | "verb"> | null;
  ready: boolean;
  amountKrw: number | null;
  memberCount: number;
};

export function toSettlementConfirmPreview(plan: SettlementConfirmPlan): SettlementConfirmPreview {
  return {
    slot: plan.slot ? { counterpartLabel: plan.slot.counterpartLabel, verb: plan.slot.verb } : null,
    ready: plan.validity.ok,
    amountKrw: plan.amountKrw,
    memberCount: plan.memberCount,
  };
}
