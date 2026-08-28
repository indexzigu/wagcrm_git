/**
 * WRITE 액션 실행기 (청사진 §2, §0-3/§0-6).
 *
 * payload 화이트리스트 디스패치 — ActionProposal.payload = {action, args}에서
 * action 문자열로 WRITE_ACTIONS 정적 맵만 조회한다. 임의 {service,method} eval은
 * 절대 금지(R1) — 여기서는 사전에 등록된 핸들러만 호출 가능하다.
 *
 * executeWriteAction은:
 *  ① 화이트리스트 검증(미등록 action은 throw)
 *  ② argsSchema로 args 재검증(승인 시점에 다시 검증 — 기안 생성 이후 스키마가
 *     바뀌었거나 payload가 변조됐을 가능성에 대비)
 *  ③ 대상 엔티티 존재 검증(§0-6, entityType별 findUnique) — 없으면 throw
 *  ④ handler 호출(호출부가 열어둔 tx를 그대로 주입 — 원자성은 호출부 책임)
 *
 * 반환값 {refType, refId, summary}는 ActionProposal.executedRefType/executedRefId/
 * executionResult 기록에 쓰인다.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  CAMPAIGN_INVALIDATION_TAGS,
  MASTER_DATA_INVALIDATION_TAGS,
  type CrmCacheTag,
} from "@/lib/cache-tags";
import { recordActivityMemo, recordActivityChange, type ActivityEntityType } from "@/lib/activity-log";
import { DEAL_STATUSES, isValidTransition, getValidNextStatuses, type DealStatus } from "@/lib/deal-status";
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

const ENTITY_TYPES = ["PARTNER", "SELLER", "DEAL", "CAMPAIGN"] as const;

const addEntityMemoArgsSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().min(1),
  content: z.string().min(1).max(4000), // security-review L3: 자동승인 경로 스토리지 남용 방지 상한
});

export type AddEntityMemoArgs = z.infer<typeof addEntityMemoArgsSchema>;

const changeDealStatusArgsSchema = z.object({
  dealId: z.string().min(1),
  newStatus: z.enum(DEAL_STATUSES as [DealStatus, ...DealStatus[]]),
});

export type ChangeDealStatusArgs = z.infer<typeof changeDealStatusArgsSchema>;

const confirmSettlementArgsSchema = z.object({
  campaignId: z.string().min(1),
  target: z.enum(["deposit", "payout"]),
});

export type ConfirmSettlementArgs = z.infer<typeof confirmSettlementArgsSchema>;

export type WriteActionResult = {
  refType: string;
  refId: string;
  summary: string;
};

type WriteActionHandler<TArgs> = (
  args: TArgs,
  actor: string,
  tx: Prisma.TransactionClient
) => Promise<WriteActionResult>;

/**
 * 쓰기가 **커밋된 뒤** 라우트가 수행해야 하는 후속 처리 명세(순수 데이터).
 *
 * ⛔ 여기서 직접 무효화·캘린더를 부르지 말 것 — 이 모듈은 트랜잭션 **안**에서 도는
 * 실행기다. 실행이 롤백돼도 캐시가 깨지고 캘린더가 갱신되는 반쪽 반영이 생긴다.
 * 실제 집행은 `write-action-effects.ts` 가 커밋 뒤에 한다(외부 IO 는 라우트 소유 —
 * `docs/agents/codebase-map.md`).
 */
export type WriteActionEffectSpec = {
  /**
   * 커밋 직후 무효화할 캐시 태그.
   * ⚠️ **빈 배열은 "아직 안 채운 구멍"이 아니라 판정 결과다** — 그 액션이 바꾸는 데이터를
   * 읽는 `use cache` 표면이 하나도 없다는 뜻이고, 태그를 채우면 신선도 이득 없이
   * ISR 쓰기만 늘어난다(`src/lib/cache-policy.ts` fan-out 축소 주석).
   */
  readonly revalidate: readonly CrmCacheTag[];
  /** 구글 캘린더를 재동기화할 캠페인 id. null = 캘린더에 실리는 값이 바뀌지 않는다. */
  readonly calendarCampaignId: string | null;
};

type WriteActionDefinition<TArgs = any> = {
  argsSchema: z.ZodType<TArgs>;
  handler: WriteActionHandler<TArgs>;
  /**
   * **필수 필드다.** 신규 WRITE 액션을 등록하면 컴파일러가 후속 처리 판정을 강제한다 —
   * 이 필드가 선택이었다면 "DB 는 바뀌는데 화면은 그대로"가 조용히 재발한다.
   */
  effects: (result: WriteActionResult) => WriteActionEffectSpec;
};

/**
 * entityType별로 대상 엔티티가 실재하는지 확인한다(§0-6). 존재하지 않으면 throw —
 * 호출부(approve 라우트)가 이를 잡아 ActionProposal을 APPROVED→FAILED로 전이시킨다.
 */
async function assertEntityExists(
  entityType: ActivityEntityType,
  entityId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  const entityLabel: Record<ActivityEntityType, string> = {
    PARTNER: "거래처",
    SELLER: "셀러",
    DEAL: "딜",
    CAMPAIGN: "캠페인",
  };

  let found: unknown = null;
  switch (entityType) {
    case "PARTNER":
      found = await tx.partner.findUnique({ where: { id: entityId } });
      break;
    case "SELLER":
      found = await tx.seller.findUnique({ where: { id: entityId } });
      break;
    case "DEAL":
      found = await tx.deal.findUnique({ where: { id: entityId } });
      break;
    case "CAMPAIGN":
      found = await tx.salesCampaign.findUnique({ where: { id: entityId } });
      break;
  }

  if (!found) {
    throw new Error(
      `대상 ${entityLabel[entityType]}(${entityId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`
    );
  }
}

async function handleAddEntityMemo(
  args: AddEntityMemoArgs,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  await assertEntityExists(args.entityType, args.entityId, tx);

  const log = await recordActivityMemo(args.entityType, args.entityId, args.content, actor, tx);

  return {
    refType: args.entityType,
    refId: args.entityId,
    summary: `${args.entityType} ${args.entityId}에 메모 기록 (ActivityLog ${log.id})`,
  };
}

/**
 * 딜 상태를 변경한다(Phase 5 HITL WRITE 2종째 — 청사진 확정 설계).
 *
 * add_entity_memo와 달리 값 변경(§실제 필드 mutate)이므로 딜 상태기계 규칙을
 * executor에서 강제한다: 무의미한 자기전이, 역행, DROPPED(terminal) 탈출은 모두
 * throw로 거부한다. dealService.updateDeal은 tx를 지원하지 않아 원자성이 깨지므로
 * 재사용하지 않고, 여기서 직접 tx.deal.update + recordActivityChange(tx)를 호출한다.
 */
async function handleChangeDealStatus(
  args: ChangeDealStatusArgs,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  await assertEntityExists("DEAL", args.dealId, tx);

  const deal = await tx.deal.findUnique({ where: { id: args.dealId } });
  if (!deal) {
    // assertEntityExists가 이미 존재를 확인했으므로 이 분기는 사실상 도달 불가하지만
    // 타입 좁히기 및 방어적 코딩을 위해 남겨둔다.
    throw new Error(`대상 딜(${args.dealId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
  }

  const currentStatus = deal.status as DealStatus;

  if (currentStatus === args.newStatus) {
    throw new Error(`이미 ${currentStatus} 상태입니다. 동일한 상태로는 변경할 수 없습니다.`);
  }

  if (!isValidTransition(currentStatus, args.newStatus)) {
    const validNext = getValidNextStatuses(currentStatus);
    const validNextLabel = validNext.length > 0 ? validNext.join(", ") : "없음(terminal 상태)";
    throw new Error(
      `${currentStatus}에서 ${args.newStatus}로 변경할 수 없습니다 (딜 상태기계 위반). ` +
        `가능한 다음 상태: ${validNextLabel}`
    );
  }

  await tx.deal.update({
    where: { id: args.dealId },
    data: { status: args.newStatus },
  });

  await recordActivityChange("DEAL", args.dealId, "상태", currentStatus, args.newStatus, actor, tx);

  return {
    refType: "DEAL",
    refId: args.dealId,
    summary: `딜 상태 ${currentStatus}→${args.newStatus} 변경`,
  };
}

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

/**
 * WRITE 액션 화이트리스트. Phase 5 HITL은 add_entity_memo, change_deal_status,
 * confirm_settlement 3종을 등록한다(청사진 확정 설계).
 */
export const WRITE_ACTIONS: Record<string, WriteActionDefinition> = {
  add_entity_memo: {
    argsSchema: addEntityMemoArgsSchema,
    handler: handleAddEntityMemo,
    // 무효화 대상 없음 — 이 액션은 `ActivityLog`(type=MEMO) 행만 만들고 엔티티 필드는
    // 건드리지 않으며, 그 테이블을 읽는 캐시 표면이 **0건**이다(2026-08-27 전수 확인).
    // 🪤 **문자열 grep 으로 캐시 표면을 세지 말 것** — `"use cache"` 를 grep 하면 파일 4개가
    //    걸리지만 그중 둘(`api/mobile/pulse/route.ts` · `reports/inflow/page.tsx`)은 「`use
    //    cache` 를 **안** 쓴다」고 적은 **주석**이다. 디렉티브를 실제로 가진 파일은
    //    `cached-crm-data.ts` · `cached-portal-data.ts` **둘뿐**이고, 그 둘과 그들이 부르는
    //    데이터 모듈 어디에도 `activityLog` 접근이 없다. `ActivityLog` 가 다른 모델의
    //    relation 으로 include 되는 경로도, `unstable_cache` 사용도 레포 전체에 0건이다.
    //    메모를 실제로 보여주는 `/api/activity-log` 와 세금계산서 보드는 둘 다 동적 라우트다.
    effects: () => ({ revalidate: [], calendarCampaignId: null }),
  },
  change_deal_status: {
    argsSchema: changeDealStatusArgsSchema,
    handler: handleChangeDealStatus,
    // 정본 버튼 경로 `PATCH /api/deals/[id]` 와 **같은 집합**(revalidateMasterDataCaches).
    // 집합을 여기서 새로 고르지 말 것 — 정본과 갈리는 순간 두 경로의 화면이 달라진다.
    effects: () => ({ revalidate: MASTER_DATA_INVALIDATION_TAGS, calendarCampaignId: null }),
  },
  confirm_settlement: {
    argsSchema: confirmSettlementArgsSchema,
    handler: handleConfirmSettlement,
    // 정본 버튼 경로 `PATCH /api/campaigns/[id]/settlement-status` 와 **같은 짝**:
    // 캠페인 태그 무효화 + 캘린더 재동기화. 정산 확정은 캘린더 입금/출금 이벤트의 소스라
    // 한쪽만 하면 장부와 일정이 갈린다. refId 는 handleConfirmSettlement 가 넣는 campaignId 다.
    effects: (result) => ({
      revalidate: CAMPAIGN_INVALIDATION_TAGS,
      calendarCampaignId: result.refId,
    }),
  },
};

export type WriteActionName = keyof typeof WRITE_ACTIONS;

/**
 * WRITE 액션을 화이트리스트 경유로 실행한다. 등록되지 않은 action은 즉시 거부한다 —
 * 임의 서비스/메서드를 동적으로 호출하는 경로는 존재하지 않는다(R1).
 */
export async function executeWriteAction(
  action: string,
  args: unknown,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  const definition = WRITE_ACTIONS[action];
  if (!definition) {
    throw new Error(`등록되지 않은 WRITE 액션입니다 (화이트리스트에 없음): ${action}`);
  }

  const parsed = definition.argsSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`WRITE 액션 args 검증 실패 (${action}): ${issues}`);
  }

  return definition.handler(parsed.data, actor, tx);
}

/**
 * 실행이 커밋된 뒤 수행할 후속 처리 명세를 액션 이름으로 조회한다.
 *
 * `executeWriteAction` 의 반환 타입(`WriteActionResult`)은 `ActionProposal.executionResult`
 * 로 그대로 직렬화되므로 여기에 후속 처리 정보를 얹지 않고 **별도 조회**로 분리한다.
 */
export function resolveWriteActionEffects(
  action: string,
  result: WriteActionResult
): WriteActionEffectSpec {
  const definition = WRITE_ACTIONS[action];
  if (!definition) {
    throw new Error(`등록되지 않은 WRITE 액션입니다 (화이트리스트에 없음): ${action}`);
  }
  return definition.effects(result);
}
