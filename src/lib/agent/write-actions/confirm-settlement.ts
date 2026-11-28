import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { recordActivityChange } from "@/lib/activity-log";
import { CAMPAIGN_INVALIDATION_TAGS } from "@/lib/cache-tags";
import {
  deriveSettlementState,
  computeAutoStatus,
  settlementSlotLabel,
  SETTLEMENT_TARGETS,
  type SettlementCompletionFlags,
} from "@/lib/settlement-status";
import { writeSettlementFlags, type SettlementScalarUpdates } from "@/lib/settlement-flag-write";
import { moneySlotAmount } from "@/lib/calendar-entities";
import {
  describeMoneySlotAmountBlock,
  type CampaignMoneySlot,
  type MoneySlotAmountInput,
} from "@/lib/tax-filing-board";
import { toKstYmd } from "@/lib/date-utils";
import { formatSettlementAmountKrw } from "@/lib/settlement-amount-fields";
import {
  checkSettlementCompletedOn,
  isConfirmableAmount,
  resolveSettlementConfirmPlan,
  toMoneySlotSource,
  toSettlementCompletedAt,
} from "@/lib/settlement-confirm-preview";
import { campaignInvoiceService } from "@/services/campaignInvoiceService";
import { blocksStatusForUnsetPeriod } from "@/lib/campaign-period";
import { assertEntityExists, type WriteActionDefinition, type WriteActionResult } from "./types";

const confirmSettlementArgsSchema = z.object({
  campaignId: z.string().min(1),
  target: z.enum(SETTLEMENT_TARGETS),
  /**
   * 오너가 말한 지급일·입금일(KST 달력 날짜). 없으면 승인한 시각을 기록한다(종전 동작).
   * 미래 날짜는 실행 시점에 거부한다(`checkSettlementCompletedOn`).
   */
  completedOn: z.string().date().optional(),
});

export type ConfirmSettlementArgs = z.infer<typeof confirmSettlementArgsSchema>;

/**
 * 대금 게이트가 금액 미확정으로 거부할 때의 문구. 슬롯 SSOT 에서 파생한다 —
 * 「무엇을 채워야 하나」는 채널마다 다르고, 캠페인 값에 따라 **채울 대상이 아예 없는**
 * 경우도 있다(물품대금의 합산 이관).
 *
 * @param action   문구에 넣을 동작 이름(슬롯 라벨 + 「 완료」, 칸이 없으면 「확정」).
 * @param campaign 금액 근거 컬럼 — 판정이 캠페인 값에 따라 갈리므로 함께 넘긴다.
 * @param slot     대상 대금 칸. `undefined` = 이 채널에 그 칸 자체가 없다.
 */
function buildAmountGateMessage(
  action: string,
  campaign: MoneySlotAmountInput,
  slot: CampaignMoneySlot | null,
): string {
  if (!slot) {
    return `정산 ${action} 불가: 이 판매채널에는 해당 대금 칸이 없습니다.`;
  }
  const block = describeMoneySlotAmountBlock(slot, campaign);
  if (block.kind === "NOT_APPLICABLE") {
    // 채워서 열 수 있는 값이 없다. 「입력 후 다시 시도」로 안내하면 운영자가 이미
    // 올바르게 넣은 값을 의심하며 컬럼만 뒤지게 된다.
    return `정산 ${action} 불가: ${block.reason}`;
  }
  return (
    `정산 ${action} 불가: 금액 근거가 비어 있거나 0 이하입니다. ` +
    `필요한 값: ${block.needs}. 입력 후 다시 시도하세요.`
  );
}

/**
 * 정산 상태를 전진시킨다(Phase 5 HITL WRITE 3종째 — confirm_settlement 청사진 §3-b).
 * 🔴 금전 영향 최고위험.
 *
 * 정본 토글 경로(campaigns/[id]/settlement-status/route.ts)와 동일한 최종 상태(플래그+
 * 타임스탬프+status 자동전이)를 만들되, 자율 에이전트에 필요한 두 가지를 강화한다:
 *  (a) 전진 전용 상태기계 가드 — 역행·중복·건너뛰기는 throw로 거부.
 *  (b) 레이스-세이프 조건부 쓰기 — updateMany의 where에 사전 플래그 상태를 박아
 *      count!==1이면 throw. 동시/재승인 시 잃은 레이스가 조용한 타임스탬프 덮어쓰기가
 *      아니라 FAILED가 되도록 한다(plan-critic #2).
 *
 * add_entity_memo/change_deal_status와 마찬가지로 호출부(approve route)가 연 tx를 그대로
 * 주입받아 recordActivityChange까지 한 트랜잭션으로 원자화한다. 정본 route가 감사 기록에
 * tx를 넘기지 않는 잠재버그는 복제하지 않는다(청사진 §1).
 */
async function handleConfirmSettlement(
  args: ConfirmSettlementArgs,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  await assertEntityExists("CAMPAIGN", args.campaignId, tx);

  // 날짜 판정을 먼저 한다 — 무엇을 읽든 미래 날짜 기안은 적용하지 않는다(카드도 같은 판정으로 버튼을 뺀다).
  if (args.completedOn) {
    const dated = checkSettlementCompletedOn(args.completedOn);
    if (!dated.ok) throw new Error(`정산 확정 불가: ${dated.reason}`);
  }

  // 읽기·상태기계·슬롯·금액은 슬랙 카드와 **같은 계획**에서 온다(`settlement-confirm-preview` 헤더) —
  // 카드가 보여 준 칸·금액과 여기서 판정하는 칸·금액이 구조적으로 못 갈린다.
  // 🪤 그 계획이 `include: { group: true }` 와 묶음 멤버 조회를 소유한다 — 여기서 캠페인을 따로 다시 읽지 말 것.
  const plan = await resolveSettlementConfirmPlan(tx, args.campaignId, args.target);
  if (!plan) {
    // assertEntityExists가 이미 존재를 확인했으므로 사실상 도달 불가하지만 방어적으로 남긴다.
    throw new Error(`대상 캠페인(${args.campaignId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
  }
  const { campaign, group, flags, state, validity, slot, sources, amountKrw } = plan;
  // 문구의 동작 이름도 슬롯이 소유한다(「공급사 지급 완료」·「셀러 입금 완료」). ⛔ 타깃 삼항으로 다시 짓지 말 것 —
  // 같은 `payout` 이 자사몰에선 셀러 지급, 셀러몰에선 공급사 지급이다.
  const actionLabel = slot ? `${settlementSlotLabel(slot)} 완료` : "확정";

  // pre-write 스냅샷에서 상태 파생 + 전진 전용 유효성 검증(plan-critic Minor 1).
  // 판정 축은 채널 슬롯이다(`resolveCampaignMoneySlots`) — 자사몰은 [공급사 지급, 셀러
  // 지급]이라 `deposit` 타깃이 거부되고 `payout` 은 공급사 지급(`supplierPayout`)을 선행 조건으로 본다.
  if (!validity.ok) {
    throw new Error(`정산 ${actionLabel} 불가: ${validity.reason}`);
  }

  // 금액 무결성 하드 게이트(security-reviewer H1). 정본 토글 경로(버튼 UI)는 사람이 화면에서
  // 금액을 보며 누르지만, 이 도구는 LLM이 자연어에서 campaignId를 뽑아 자동 기안하므로 위협모델이
  // 다르다. 금액이 미입력(null)이거나 0 이하인 정산을 확정하면 회계상 "유령 완료"가 생기므로,
  // 소프트 경고가 아니라 상태기계 가드와 동일 계층에서 throw로 거부한다(0-원 명시값도 미확정 — M1).
  // ⛔ **어느 컬럼을 볼지 여기서 고르지 말 것 — 판정은 `sumMoneySlotAmounts`(SSOT) 하나다.**
  // 종전엔 `target === "deposit" ? settlementDeposit : settlementPayout` 삼항이었고, 그
  // 삼항이 표시 경로와 갈라진 채 **프로덕션에서 100% 닫혀 있었다** — 그 두 컬럼이 108건 중
  // 0건이라(2026-08-25 실측) 어떤 캠페인으로 시도해도 여기서 throw 됐다.
  // 🪤 **단위 테스트는 내내 초록이었다** — 픽스처가 그 컬럼에 값을 주입하므로 「이 컬럼이
  // 현실에서 안 채워진다」는 사실을 테스트가 볼 방법이 없다. SSOT 를 부르면 표시와 게이트가 구조적으로 못 갈린다.
  // 슬롯이 없다 = 이 채널에 그 대금 칸 자체가 없다(예: 자사몰의 입금). `isValidSettlementAction`
  // 이 이미 걸러내지만, 그 판정이 느슨해져도 금액 없이 확정되지 않도록 여기서도 닫는다.
  if (slot == null || !isConfirmableAmount(amountKrw)) {
    // ⛔ **어느 컬럼을 채우라고 안내할지 여기서 삼항으로 정하지 말 것.** 종전엔 채널과
    // 무관하게 `입금액(settlementSales)` 로 박혀 있어, 셀러몰 운영자에게 근거가 아닌
    // 컬럼을 채우라고 안내했다 — 그 컬럼을 아무리 채워도 이 게이트는 계속 닫힌다.
    // 금액을 고르는 판정(`sumMoneySlotAmounts`)과 그 금액의 근거를 말하는 문구가 갈리면
    // 위 버그가 문구 쪽에서 그대로 재현된다. 둘 다 슬롯 SSOT 에서 파생한다.
    // ⚠️ **그룹이면 실제로 막고 있는 멤버의 근거로 문구를 만든다.** 판정은 조합 합산인데
    //    문구를 대표 멤버로 만들면, 그 캠페인의 컬럼은 이미 채워져 있는데 "채우고 다시
    //    시도하라"고 말하게 된다 — #479 가 고친 「채워도 안 열리는 안내」가 행 축에서
    //    재현되는 형태다. 보는 컬럼 집합은 판정과 같다(둘 다 `toMoneySlotSource`).
    //    이 줄이 실제로 일하는 곳은 `ALL_OR_NOTHING` 기준(공급사 지급 = 수기 물품대금)이다 — 한 멤버라도
    //    미입력이면 조합 합계가 미정이 되는데, 그 멤버는 대표가 아닐 수 있다(오너 결정 2026-11-28 로
    //    `supplierPayout` 이 이 도구의 타깃이 됐다). `SKIP_UNKNOWN` 기준은 「전원 미입력」에서만 닫혀
    //    대표 멤버와 결과가 같다.
    // ⚠️ 미입력(null) 멤버를 먼저 고른다. ALL_OR_NOTHING 합계를 닫는 것은 미입력이고, 합산 이관(`0`) 멤버는
    //    묶음의 정상 상태다 — `0` 멤버를 먼저 집으면 「채울 것이 없다」는 문구가 나와 실제로 비어 있는 멤버를
    //    가린다(findMany 순서는 정해져 있지 않다).
    const blocking =
      (slot
        ? (sources.find((source) => moneySlotAmount(source, slot) == null) ??
          sources.find((source) => Number(moneySlotAmount(source, slot)) <= 0))
        : undefined) ?? toMoneySlotSource(campaign);
    throw new Error(buildAmountGateMessage(actionLabel, blocking, slot));
  }

  // 새 플래그 값 + 정본 경로와 동일한 status 자동전이(pre-write status에서 계산).
  // ⛔ 어느 플래그가 켜지는지 삼항으로 다시 정하지 말 것 — `slot.flagField` 가 채널 인지
  // SSOT 다(자사몰의 `payout` 은 셀러 지급 레그, `supplierPayout` 은 공급사 지급 레그).
  const nextFlags: SettlementCompletionFlags = { ...flags };
  nextFlags[slot.flagField] = true;
  let autoStatus = computeAutoStatus(campaign.status, campaign.salesChannel, nextFlags);
  // 월정산 계산서 완료 게이트(T-240) — 버튼 경로와 같은 판정: 플래그는 확정하되, 월정산 거래처
  // 캠페인의 달별 공급사 계산서가 남아 있으면 상태 전이만 보류하고 그 사유를 결과 요약에 남긴다.
  const gated = await campaignInvoiceService.gateAutoCompletion(tx, args.campaignId, campaign.status, autoStatus);
  autoStatus = gated.status;
  // 기간 미정(T-313) — 플래그만 확정하고 허용 밖 상태로는 옮기지 않는다.
  if (autoStatus && blocksStatusForUnsetPeriod(campaign, autoStatus)) autoStatus = undefined;
  const monthlyCompletionBlocked = gated.blockedReason;

  // 레이스-세이프 조건부 쓰기(§3-b step 4). `expect` 에 사전 플래그 false 를 박아 원자화한다 —
  // 그 조건이 실리는 행은 **플래그의 정본 행**(그룹이면 그룹 스칼라)이고, 그 선택은
  // `writeSettlementFlags` 가 소유한다.
  // 완료 시각 = 오너가 말한 날(`completedOn`, 저장 규약은 `toSettlementCompletedAt`) 또는 승인한 시각.
  const completedAt = toSettlementCompletedAt(args.completedOn, new Date());
  const settlementUpdates: SettlementScalarUpdates = {
    [slot.flagField]: true,
    [slot.completedAtField]: completedAt,
  } satisfies SettlementScalarUpdates;
  const written = await writeSettlementFlags(tx, {
    campaign,
    group,
    settlementUpdates,
    campaignUpdates: autoStatus !== undefined ? { status: autoStatus } : {},
    expect: { [slot.flagField]: false },
    // 형제 전파 이력도 아래 감사 기록과 같은 주체로 남긴다.
    actor,
  });

  if (!written.ok) {
    // 사전 조회 이후 다른 트랜잭션이 이미 확정했거나 그룹 멤버십이 바뀌었다 —
    // 이중 적용/타임스탬프 덮어쓰기 방지.
    throw new Error(
      `정산 ${actionLabel} 실패: 동시 처리로 이미 확정되었습니다(재시도 시 최신 상태 확인).`
    );
  }

  // 감사 기록 — 필드명은 정본 route와 일치(isDepositReceived/isPayoutCompleted/status), tx 주입.
  const flagField = slot.flagField;
  await recordActivityChange("CAMPAIGN", args.campaignId, flagField, false, true, actor, tx);

  // status가 실제로 바뀔 때만 status 활동행을 기록한다(정본 route parity, plan-critic Minor 2).
  if (autoStatus !== undefined && campaign.status !== autoStatus) {
    await recordActivityChange("CAMPAIGN", args.campaignId, "status", campaign.status, autoStatus, actor, tx);
  }

  const nextState = deriveSettlementState({ salesChannel: campaign.salesChannel, ...nextFlags });
  // 결과 요약 = 어느 칸 · 얼마 · 며칠(슬랙 카드가 승인 전에 보여 준 세 값과 같은 축). 금액은 이 시점에 다시 센 값이다.
  const applied = `금액 ${formatSettlementAmountKrw(amountKrw)} · ${slot.verb}일 ${toKstYmd(completedAt)}`;

  return {
    refType: "CAMPAIGN",
    refId: args.campaignId,
    summary: `정산 ${actionLabel} 처리 (${state}→${nextState}) · ${applied}${autoStatus ? `, 캠페인 상태 ${autoStatus}` : ""}${monthlyCompletionBlocked ? `. 상태 전환 보류: ${monthlyCompletionBlocked}` : ""}`,
  };
}

export const confirmSettlementAction: WriteActionDefinition<ConfirmSettlementArgs> = {
  argsSchema: confirmSettlementArgsSchema,
  handler: handleConfirmSettlement,
  // 정본 버튼 경로 `PATCH /api/campaigns/[id]/settlement-status` 와 **같은 짝**:
  // 캠페인 태그 무효화 + 캘린더 재동기화. 정산 확정은 캘린더 입금/출금 이벤트의 소스라
  // 한쪽만 하면 장부와 일정이 갈린다. refId 는 handleConfirmSettlement 가 넣는 campaignId 다.
  effects: (result) => ({
    revalidate: CAMPAIGN_INVALIDATION_TAGS,
    calendarCampaignId: result.refId,
  }),
};
