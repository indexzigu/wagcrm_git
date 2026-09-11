import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { recordActivityChange } from "@/lib/activity-log";
import { CAMPAIGN_INVALIDATION_TAGS } from "@/lib/cache-tags";
import {
  deriveSettlementState,
  isValidSettlementAction,
  computeAutoStatus,
  type SettlementCompletionFlags,
  type SettlementTarget,
} from "@/lib/settlement-status";
import {
  resolveSettlementFlagSnapshot,
  writeSettlementFlags,
  type SettlementScalarUpdates,
} from "@/lib/settlement-flag-write";
import {
  moneySlotAmount,
  sumMoneySlotAmounts,
  type MoneySlotAmountSource,
} from "@/lib/calendar-entities";
import {
  describeMoneySlotAmountBlock,
  resolveCampaignMoneySlots,
  type CampaignMoneySlot,
  type MoneySlotAmountInput,
} from "@/lib/tax-filing-board";
import { assertEntityExists, type WriteActionDefinition, type WriteActionResult } from "./types";

const confirmSettlementArgsSchema = z.object({
  campaignId: z.string().min(1),
  target: z.enum(["deposit", "payout"]),
});

export type ConfirmSettlementArgs = z.infer<typeof confirmSettlementArgsSchema>;

/**
 * 대금 게이트가 금액 미확정으로 거부할 때의 문구. 슬롯 SSOT 에서 파생한다 —
 * 「무엇을 채워야 하나」는 채널마다 다르고, 캠페인 값에 따라 **채울 대상이 아예 없는**
 * 경우도 있다(물품대금의 합산 이관).
 *
 * @param action   운영자가 누른 동작("입금확정"/"지급완료").
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
 * 캠페인 행 → 슬롯 금액 SSOT 의 입력. 다섯 컬럼 전부 넘긴다 — 채널마다 금액 근거가 다르므로
 * SSOT 가 고를 수 있어야 한다(셀러몰 입금 = actualSales − sellerExpense, 브랜드몰 입금 =
 * settlementSales, 공급사 지급 = 수기 물품대금). 타입을 **필수 필드 쪽**
 * (`MoneySlotAmountSource`)으로 받는 것도 같은 이유다 — 선택 필드로 두면 컬럼 하나를
 * 빠뜨려도 컴파일이 통과해 금액이 조용히 「미정」이 된다(#479 의 형태).
 */
function toMoneySlotSource(campaign: {
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

  // 🪤 **`include: { group: true }` 를 빼지 말 것.** 완료 플래그의 정본은 그룹 스칼라이고
  // (CG-1) 멤버 행 값은 낡을 수 있다 — 종전엔 그룹을 조회조차 하지 않아 그룹 소속 캠페인의
  // 전진 검증·상태 라벨·쓰기가 전부 **낡은 멤버 값** 위에서 돌았다(`settlement-flag-write` 헤더).
  const campaign = await tx.salesCampaign.findUnique({
    where: { id: args.campaignId },
    include: { group: true },
  });
  if (!campaign) {
    // assertEntityExists가 이미 존재를 확인했으므로 사실상 도달 불가하지만 방어적으로 남긴다.
    throw new Error(`대상 캠페인(${args.campaignId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
  }
  const group = campaign.groupId ? campaign.group : null;

  const target = args.target as SettlementTarget;

  // pre-write 스냅샷에서 상태 파생 + 전진 전용 유효성 검증(plan-critic Minor 1).
  // 판정 축은 채널 슬롯이다(`resolveCampaignMoneySlots`) — 자사몰은 [공급사 지급, 셀러
  // 지급]이라 `deposit` 타깃이 거부되고 `payout` 은 공급사 지급을 선행 조건으로 본다.
  // ⚠️ 채널은 대표 멤버 값을 쓴다 — 정본 토글 라우트와 같은 규약이다(조합은 채널이 하나라는
  // 오너 확정 2026-08-25). 여기만 멤버 채널 합집합으로 바꾸면 두 경로의 슬롯 판정이 갈린다.
  const flags = resolveSettlementFlagSnapshot(campaign, group);
  const flagSnapshot = { salesChannel: campaign.salesChannel, ...flags };
  const state = deriveSettlementState(flagSnapshot);
  const validity = isValidSettlementAction(flagSnapshot, target);
  if (!validity.ok) {
    throw new Error(`정산 ${target === "deposit" ? "입금확정" : "지급완료"} 불가: ${validity.reason}`);
  }

  // 금액 무결성 하드 게이트(security-reviewer H1). 정본 토글 경로(버튼 UI)는 사람이 화면에서
  // 금액을 보며 누르지만, 이 도구는 LLM이 자연어에서 campaignId를 뽑아 자동 기안하므로 위협모델이
  // 다르다. 금액이 미입력(null)이거나 0 이하인 정산을 확정하면 회계상 "유령 완료"가 생기므로,
  // 소프트 경고가 아니라 상태기계 가드와 동일 계층에서 throw로 거부한다. Decimal? 필드는 Number()로
  // 안전 변환해 비교한다(0-원 명시값도 미확정으로 간주 — 확정할 실체 금액이 없음, M1).
  // ⛔ **어느 컬럼을 볼지 여기서 고르지 말 것 — 판정은 `sumMoneySlotAmounts`(SSOT) 하나다.**
  // 종전엔 `target === "deposit" ? settlementDeposit : settlementPayout` 삼항이었고, 그
  // 삼항이 표시 경로와 갈라진 채 **프로덕션에서 100% 닫혀 있었다** — 그 두 컬럼이 108건 중
  // 0건이라(2026-08-25 실측) 어떤 캠페인으로 시도해도 여기서 throw 됐다.
  // 🪤 **단위 테스트는 내내 초록이었다** — 픽스처가 그 컬럼에 값을 주입하므로 「이 컬럼이
  // 현실에서 안 채워진다」는 사실을 테스트가 볼 방법이 없다. 다행히 `confirm_settlement`
  // 기안이 0건이라 실사고는 없었다. SSOT 를 부르면 표시와 게이트가 구조적으로 못 갈린다.
  const slot = resolveCampaignMoneySlots(campaign.salesChannel).find((s) => s.key === target) ?? null;
  // ⚠️ **그룹이면 금액도 그룹 단위로 센다.** 플래그가 그룹 스칼라라 이 쓰기는 **조합 전체**를
  // 확정하는데, 대표 멤버 한 명의 금액으로 게이트를 통과시키면 게이트가 지키는 범위와 쓰기가
  // 미치는 범위가 어긋난다. 합산 규약(`CampaignGroup` 에는 정산 금액 컬럼 자체가 없다 —
  // CG-1 정산 방화벽 · 물품대금은 「입력된 멤버만 더하기」가 금지된 ALL_OR_NOTHING 기준이다)은
  // `sumMoneySlotAmounts` 가 소유하고 `agenda-settlements` · 모바일 대금 칸이 이미 같은 규약을
  // 쓴다. ⛔ 전원 미입력은 0 이 아니라 `null`(미정)이므로 아래 게이트에서 그대로 거부된다.
  const members = campaign.groupId
    ? await tx.salesCampaign.findMany({ where: { groupId: campaign.groupId } })
    : [campaign];
  // ⛔ **금액 근거는 한 함수로 만들어 판정과 문구가 같은 컬럼 집합을 보게 한다.** 둘에 따로
  //    만들어 넘기면 한쪽만 컬럼을 빠뜨려도 컴파일이 통과하는데, 그게 정확히 #479 의 실패
  //    형태다(판정은 SSOT 를 쓰는데 문구는 옛 컬럼을 말했다).
  const sources = members.map(toMoneySlotSource);
  // 슬롯이 없다 = 이 채널에 그 대금 칸 자체가 없다(예: 자사몰의 입금). `isValidSettlementAction`
  // 이 이미 걸러내지만, 그 판정이 느슨해져도 금액 없이 확정되지 않도록 여기서도 닫는다.
  const amountField = slot ? sumMoneySlotAmounts(sources, slot) : null;
  if (slot == null || amountField == null || Number(amountField) <= 0) {
    // ⛔ **어느 컬럼을 채우라고 안내할지 여기서 삼항으로 정하지 말 것.** 종전엔 채널과
    // 무관하게 `입금액(settlementSales)` 로 박혀 있어, 셀러몰 운영자에게 근거가 아닌
    // 컬럼을 채우라고 안내했다 — 그 컬럼을 아무리 채워도 이 게이트는 계속 닫힌다.
    // 금액을 고르는 판정(`sumMoneySlotAmounts`)과 그 금액의 근거를 말하는 문구가 갈리면
    // 위 버그가 문구 쪽에서 그대로 재현된다. 둘 다 슬롯 SSOT 에서 파생한다.
    // ⚠️ **그룹이면 실제로 막고 있는 멤버의 근거로 문구를 만든다.** 판정은 조합 합산인데
    //    문구를 대표 멤버로 만들면, 그 캠페인의 컬럼은 이미 채워져 있는데 "채우고 다시
    //    시도하라"고 말하게 된다 — #479 가 고친 「채워도 안 열리는 안내」가 행 축에서
    //    재현되는 형태다. 보는 컬럼 집합은 판정과 같다(둘 다 `toMoneySlotSource`).
    //    ℹ️ 지금은 방어층이다: 이 도구의 타깃 2종(deposit·payout)이 쓰는 기준은 전부
    //    `SKIP_UNKNOWN` 이라 합계가 닫히는 경우는 「전원 미입력」뿐이고, 그때는 대표
    //    멤버와 결과가 같다. `ALL_OR_NOTHING` 기준(공급사 지급)이 이 도구의 타깃으로
    //    들어오는 날 이 줄이 실제로 일한다 — 그때 문구를 다시 짜지 않아도 되게 둔다.
    const blocking =
      (slot
        ? sources.find((source) => {
            const amount = moneySlotAmount(source, slot);
            return amount == null || Number(amount) <= 0;
          })
        : undefined) ?? toMoneySlotSource(campaign);
    const action = target === "deposit" ? "입금확정" : "지급완료";
    throw new Error(buildAmountGateMessage(action, blocking, slot));
  }

  // 새 플래그 값 + 정본 경로와 동일한 status 자동전이(pre-write status에서 계산).
  // ⛔ 어느 플래그가 켜지는지 삼항으로 다시 정하지 말 것 — `slot.flagField` 가 채널 인지
  // SSOT 다(자사몰의 `payout` 은 셀러 지급 레그이고 공급사 지급 레그는 버튼 경로 소유).
  const nextFlags: SettlementCompletionFlags = { ...flags };
  nextFlags[slot.flagField] = true;
  const autoStatus = computeAutoStatus(campaign.status, campaign.salesChannel, nextFlags);

  // 레이스-세이프 조건부 쓰기(§3-b step 4). `expect` 에 사전 플래그 false 를 박아 원자화한다 —
  // 그 조건이 실리는 행은 **플래그의 정본 행**(그룹이면 그룹 스칼라)이고, 그 선택은
  // `writeSettlementFlags` 가 소유한다.
  const now = new Date();
  const settlementUpdates: SettlementScalarUpdates = {
    [slot.flagField]: true,
    [slot.completedAtField]: now,
  } satisfies SettlementScalarUpdates;
  const written = await writeSettlementFlags(tx, {
    campaign,
    group,
    settlementUpdates,
    campaignUpdates: autoStatus !== undefined ? { status: autoStatus } : {},
    expect: { [slot.flagField]: false },
  });

  if (!written.ok) {
    // 사전 조회 이후 다른 트랜잭션이 이미 확정했거나 그룹 멤버십이 바뀌었다 —
    // 이중 적용/타임스탬프 덮어쓰기 방지.
    throw new Error(
      `정산 ${target === "deposit" ? "입금확정" : "지급완료"} 실패: 동시 처리로 이미 확정되었습니다(재시도 시 최신 상태 확인).`
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
  const targetLabel = target === "deposit" ? "입금확정" : "지급완료";

  return {
    refType: "CAMPAIGN",
    refId: args.campaignId,
    summary: `정산 ${targetLabel} 처리 (${state}→${nextState})${autoStatus ? `, 캠페인 상태 ${autoStatus}` : ""}`,
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
