/**
 * 캠페인 수정(`PATCH /api/campaigns/[id]`)의 **본체** — 라우트에서 옮겨 왔다(동작 그대로).
 *
 * 두 호출부가 같은 함수를 탄다:
 *  - 화면 저장 라우트 — 트랜잭션 없이 부른다(종전처럼 `campaignService.updateCampaign` 이 연다).
 *  - 에이전트 `update_record` 승인 실행(`src/lib/agent/write-actions/update-record.ts`) — 승인
 *    트랜잭션(tx2)을 넘긴다. 그러면 모든 DB 쓰기(본 저장·이름 재생성·체크리스트·이력)가 기안의
 *    EXECUTED 전이와 함께 커밋되거나 함께 롤백된다.
 *
 * ⛔ 여기서 외부 IO(구글 캘린더)·캐시 무효화를 하지 말 것 — 커밋 전에 돌면 롤백된 쓰기의 반쪽
 * 반영이 남는다. 이 함수는 「캘린더를 다시 맞춰야 하나」(`calendarSync`)만 돌려주고, 집행은
 * 라우트의 `after()` 와 에이전트의 effects 명세(`write-action-effects.ts`)가 한다.
 * ⛔ 에이전트용 칸 규칙을 여기 넣지 말 것 — 화면과 같은 결과가 이 함수의 존재 이유다.
 */
import type { Prisma } from "@prisma/client";
import { describeChangedFields, recordCampaignActivity } from "@/lib/campaign-activity";
import { ensureCampaignChecklistForStatus } from "@/lib/campaign-checklist";
import { generateCampaignName } from "@/lib/campaign-name";
import { getPrisma } from "@/lib/prisma";
import { getCrmUsers } from "@/lib/user-registry";
import {
  CAMPAIGN_FINANCIAL_STALE_CODE,
  type FinancialExpectation,
} from "@/lib/campaign-financial-guard";
import { dealStoreLinkResetTargets } from "@/lib/order-converter/review-link";
import { resolveSellerFeeBasisEligibility } from "@/lib/campaign-financials";
import {
  SELLER_FEE_BASIS_CHANGE_LABEL,
  describeSellerFeeBasisChange,
  resolveSettlementStates,
  diffCampaignChanges,
  resolveSettlementSync,
  resolveReturnPeriodEndDate,
  resolveAutoStatus,
} from "@/lib/campaign-update-plan";
import type { UpdateCampaignRequest } from "@/lib/validations/campaign-update";
import { campaignService, CAMPAIGN_DETAIL_INCLUDE } from "@/services/campaignService";
import { campaignInvoiceService } from "@/services/campaignInvoiceService";

/** 캠페인 수정 요청에서 `expectedFinancials`(조건) 를 뺀 쓰기 칸. */
export type CampaignPatchData = Omit<UpdateCampaignRequest, "expectedFinancials">;

/** 화면 경로는 `getAuthContext()` 를 그대로, 에이전트는 승인자를 같은 모양으로 넘긴다. */
export type CampaignPatchAuth = {
  userId: string;
  email: string;
  role: string;
} | null;

type PreviousCampaign = NonNullable<Awaited<ReturnType<typeof loadPrevious>>>;

export type CampaignPatchOutcome =
  /** 거절 — 라우트는 그대로 응답하고, 에이전트는 `body.error` 를 실패 사유로 쓴다. */
  | { kind: "error"; status: number; body: { error: unknown; code?: string; fields?: string[] } }
  /** 정산 토글이 실제로 아무것도 바꾸지 않는 요청 — 쓰기 없음. */
  | { kind: "noop"; previous: PreviousCampaign }
  | {
      kind: "ok";
      previous: PreviousCampaign;
      fannedOutSiblings: number;
      propagatedStatusSiblingIds: string[];
      monthlyCompletionBlocked: string | null;
      changedFields: string[];
      /** 캘린더에 실리는 값이 바뀌었다 — 커밋 뒤 재동기화 대상. */
      calendarSync: boolean;
    };

// 구글 캘린더 동기화 — 캘린더에 반영되는 필드가 실제로 바뀐 경우에만 (best-effort).
const CALENDAR_SYNC_FIELDS = new Set([
  "status",
  "start date",
  "end date",
  "deposit date",
  "payout date",
  "expected deposit date",
  "expected payout date",
  "campaign name",
  "deal",
  "seller",
]);

function loadPrevious(db: Prisma.TransactionClient | ReturnType<typeof getPrisma>, id: string) {
  return db.salesCampaign.findUnique({
    where: { id },
    include: CAMPAIGN_DETAIL_INCLUDE,
  });
}

export async function applyCampaignPatch(params: {
  id: string;
  data: CampaignPatchData;
  expectedFinancials?: FinancialExpectation;
  auth: CampaignPatchAuth;
  /** 호출부 트랜잭션(에이전트 승인 실행). 생략하면 화면 저장 경로. */
  tx?: Prisma.TransactionClient;
}): Promise<CampaignPatchOutcome> {
  const { id, data, expectedFinancials, auth: authContext, tx } = params;

  // Validation: if assignedTo is provided, handoffMemo must be non-empty
  if (data.assignedTo !== undefined) {
    if (!data.handoffMemo || data.handoffMemo.trim() === "") {
      return { kind: "error", status: 400, body: { error: "Handoff memo is required" } };
    }
  }

  if (data.status === "DROPPED" && !data.dropReason?.trim()) {
    return { kind: "error", status: 400, body: { error: "Drop reason is required" } };
  }

  // 활동 이력(CampaignActivity) 행위자 — 타임라인에 그대로 찍히므로 이메일로 남긴다.
  const activityActor = authContext?.email ?? "SYSTEM";

  // Authorization: only admin role can change assignedTo
  if (data.assignedTo !== undefined) {
    if (!authContext || authContext.role !== "admin") {
      return { kind: "error", status: 403, body: { error: "Only admins can reassign campaigns" } };
    }
  }

  const prisma = tx ?? getPrisma();
  const previous = await loadPrevious(prisma, id);
  if (!previous) {
    return { kind: "error", status: 404, body: { error: "Campaign not found" } };
  }

  // 수동 정산 기준액 자격(R4) — 저장 후 상태(이 요청이 바꾸는 품목·요율 반영)로 판정한다.
  // 기준액을 새로 넣거나, 기준액이 있는 캠페인의 품목·요율을 바꿔 요율이 섞이면 거부한다.
  // 무관한 저장은 막지 않는다(이미 저장된 상태를 이유로 다른 편집까지 잠그지 않는다).
  const nextSellerFeeBasisOverride =
    data.sellerFeeBasisOverride !== undefined ? data.sellerFeeBasisOverride : previous.sellerFeeBasisOverride;
  const touchesSellerFeeBasis =
    (data.sellerFeeBasisOverride !== undefined && data.sellerFeeBasisOverride !== null) ||
    data.campaignDeals !== undefined ||
    data.sellerMarginRate !== undefined;
  if (nextSellerFeeBasisOverride != null && touchesSellerFeeBasis) {
    const eligibility = resolveSellerFeeBasisEligibility({
      deals: data.campaignDeals ?? previous.campaignDeals,
      campaignSellerMarginRate: data.sellerMarginRate ?? previous.sellerMarginRate,
    });
    if (!eligibility.eligible) {
      return { kind: "error", status: 400, body: { error: eligibility.reason } };
    }
  }

  // Determine if this is a handoff operation
  const isHandoff =
    data.assignedTo !== undefined && data.assignedTo !== previous.assignedTo;

  // If handoff, validate target user exists
  if (isHandoff) {
    const users = await getCrmUsers();
    const targetUser = users.find((u) => u.id === data.assignedTo);
    if (!targetUser) {
      return { kind: "error", status: 404, body: { error: "Target user not found" } };
    }
  }

  const settlementStates = resolveSettlementStates(data, previous);
  // ⚠️ `isGrouped`·`invoiceInfo` 는 트랜잭션 본체(campaignService)가 `settlementStates`
  // 통째로 받아 쓴다 — 여기서 다시 꺼내지 않는다.
  const {
    previousDepositState,
    previousPayoutState,
    previousSupplierPayoutState,
    newDepositState,
    newPayoutState,
    newSupplierPayoutState,
  } = settlementStates;

  const changedFields = diffCampaignChanges(data, previous, settlementStates);

  // 그룹 롤업 재계산 트리거 — changedFields 를 정본으로 삼아 "실제로 바뀐 경우"에만 켠다
  // (요청에 같은 값이 실려 와도 롤업 쓰기를 하지 않는다).
  const periodChanged =
    changedFields.includes("start date") || changedFields.includes("end date");

  // Settlement date → boolean sync logic
  const settlementSync = resolveSettlementSync(data, settlementStates, new Date());

  // 반품기간 종료일 — 명시값이 있으면 그것, 없고 종료일이 바뀌었으며 기존값이 비어 있으면 +14일 자동.
  // 그룹 팬아웃(아래)이 이 값을 형제 멤버에도 복사하므로 **단일 지점에서 확정**한다.
  const resolvedReturnPeriodEndDate = resolveReturnPeriodEndDate(data, previous);

  const settlementStateChanged =
    newDepositState !== previousDepositState ||
    newPayoutState !== previousPayoutState ||
    newSupplierPayoutState !== previousSupplierPayoutState;
  // 완료 판정은 채널이 요구하는 플래그 집합으로 한다(자사몰 = 공급사+셀러 지급) —
  // resolveAutoStatus 가 슬롯 SSOT 에서 파생한다.
  let autoStatus = resolveAutoStatus(settlementStates, previous.status, previous.salesChannel);

  // 월정산 공급사 계산서 날짜 직접 쓰기 게이트(T-248) — 달별 계산서가 정본인 단위에 날짜를 바꾸면
  // 완료 게이트를 우회한다. 값이 실제로 바뀔 때만 묻고(같은 값 재전송은 통과), 막히면 아무것도 쓰지 않는다.
  if (changedFields.includes("supplier invoice date")) {
    const blocker = await campaignInvoiceService.findLegacyDateWriteBlocker(prisma, id);
    if (blocker) return { kind: "error", status: 409, body: { error: blocker } };
  }

  // 월정산 계산서 완료 게이트(T-240) — 월정산 거래처 캠페인은 달별 공급사 계산서가 다 끝나야 완료다.
  // 수동 상태 변경은 409 로 거절하고, 플래그 토글이 부른 자동 전이는 상태만 보류한다(플래그는 저장).
  // 판정·문구 SSOT 는 campaignInvoiceService.findCompletionBlocker.
  // ⚠️ 조합 캠페인은 실캠페인 1개라 원본이 막히면 그룹 전이도 함께 보류된다(형제 전파를 부르지 않는다) —
  // 마지막 달 계산서까지 끝난 뒤 오너가 상태를 정산 완료로 바꾸면 그 수동 변경이 그룹에 전파된다.
  let monthlyCompletionBlocked: string | null = null;
  if (data.status === "COMPLETED" && previous.status !== "COMPLETED") {
    const blocker = await campaignInvoiceService.findCompletionBlocker(prisma, id);
    if (blocker) return { kind: "error", status: 409, body: { error: blocker } };
  } else if (!data.status) {
    const gated = await campaignInvoiceService.gateAutoCompletion(prisma, id, previous.status, autoStatus);
    autoStatus = gated.status;
    monthlyCompletionBlocked = gated.blockedReason;
  }

  const isOnlyNoOpSettlementToggle =
    !settlementStateChanged &&
    Object.keys(data).every(
      (field) =>
        field === "isDepositReceived" ||
        field === "isPayoutCompleted" ||
        field === "isSupplierPayoutCompleted",
    );
  if (isOnlyNoOpSettlementToggle) {
    return { kind: "noop", previous };
  }

  // 트랜잭션 본체는 campaignService.updateCampaign 이 소유한다(3계층 이관 3단계) —
  // 그룹 공유필드 updateMany + 멤버십 낙관 검사 · 일정 팬아웃 · salesTask · campaignDeals ·
  // 재무 파생 · 본 update · 그룹 롤업까지. 이 함수는 아래 후처리(DB)만 소유한다.
  const result = await campaignService.updateCampaign({
    id,
    data,
    previous,
    plan: {
      settlementStates,
      changedFields,
      periodChanged,
      settlementSync,
      resolvedReturnPeriodEndDate,
      autoStatus,
      isHandoff,
    },
    actor: authContext?.userId ?? "SYSTEM",
    expectedFinancials,
    tx,
  });

  if (!result.ok && result.reason === "financial-stale") {
    // 클라이언트 헬퍼(`campaign-patch.ts`)가 `code` 로 멤버십 409 와 가른다.
    return {
      kind: "error",
      status: 409,
      body: {
        error: "Campaign financial values changed since they were loaded",
        code: CAMPAIGN_FINANCIAL_STALE_CODE,
        fields: result.fields,
      },
    };
  }

  if (!result.ok) {
    return {
      kind: "error",
      status: 409,
      body: { error: "Campaign group membership changed; retry the update" },
    };
  }

  const campaign = result.campaign;
  const fannedOutSiblings = result.fannedOutSiblings;
  const propagatedStatusSiblingIds = result.propagatedStatusSiblingIds;

  // Campaign name regeneration trigger: when dealId, sellerId, or roundNumber changes
  const dealChanged = data.dealId !== undefined && data.dealId !== previous.dealId;
  const sellerChanged = data.sellerId !== undefined && data.sellerId !== previous.sellerId;
  const roundChanged = data.roundNumber !== undefined && (data.roundNumber ?? -1) !== (previous.roundNumber ?? -1);

  if (dealChanged || sellerChanged || roundChanged) {
    const dealName = campaign.deal?.dealName ?? null;
    const sellerName = campaign.seller?.alias || campaign.seller?.name || null;
    const roundNumber = campaign.roundNumber ?? null;
    const newCampaignName = generateCampaignName(dealName, sellerName, roundNumber);

    await prisma.salesCampaign.update({
      where: { id },
      data: { campaignName: newCampaignName },
    });
  }

  // 리뷰 해석 캐시 리셋(오너 데이터 경로 ②) — 상품 링크가 실제로 바뀌었거나 캠페인이 다른 딜로
  // 재배정되면 관련 딜의 DealStoreLink를 지워, 다음 collect-reviews 크론이 FAILED 7일 TTL을
  // 기다리지 않고 즉시 재해석하게 한다. 캐시 삭제일 뿐 수집된 리뷰(DealVocSource)는 보존된다.
  const storeLinkResetIds = dealStoreLinkResetTargets(
    { dealId: previous.dealId, baseNaverLink: previous.baseNaverLink },
    { dealId: data.dealId, baseNaverLink: data.baseNaverLink },
  );
  if (storeLinkResetIds.length > 0) {
    await prisma.dealStoreLink.deleteMany({ where: { dealId: { in: storeLinkResetIds } } });
  }

  const calendarSync =
    changedFields.some((field) => CALENDAR_SYNC_FIELDS.has(field)) ||
    dealChanged ||
    sellerChanged ||
    roundChanged;

  // Generic checklist auto-generation when a campaign enters a workflow status.
  // 그룹 상태 연동으로 같은 상태가 된 형제 멤버도 **원본과 같은** 후처리를 받는다 — 손으로
  // 멤버마다 옮겼을 때와 결과가 같아야 한다(체크리스트 생성은 멱등). 정산 자동전이
  // (`autoStatus`)는 원본도 이 분기를 타지 않으므로 형제도 타지 않는다.
  if (data.status && data.status !== previous.status) {
    await ensureCampaignChecklistForStatus(prisma, id, data.status);
    for (const siblingId of propagatedStatusSiblingIds) {
      await ensureCampaignChecklistForStatus(prisma, siblingId, data.status);
    }
  }

  if (data.status === "DROPPED" && data.status !== previous.status) {
    const actor = authContext?.userId ?? "SYSTEM";
    const content = `드랍 처리: ${data.dropReason?.trim() ?? ""}\n발생 단계: ${previous.status}`;
    await prisma.campaignNote.create({
      data: {
        campaignId: campaign.id,
        content,
        actor,
        actorName: authContext?.email ?? null,
      },
    });
    await recordCampaignActivity(
      {
        campaignId: campaign.id,
        action: "DROPPED",
        label: "Campaign dropped",
        details: `${previous.status} -> DROPPED · ${data.dropReason?.trim() ?? ""}`,
        actor,
      },
      tx,
    );
  }

  // Handle handoff: ActivityLog가 인수인계 이력의 정본이다.
  // (HANDOFF_OUT/IN 알림은 알림센터 해체와 함께 2026-07-24 제거 — 수신자가
  //  운영자 본인뿐인 1인 운영 체제에서 알림함 없는 알림은 쓸 곳이 없다.)
  if (isHandoff && authContext) {
    const previousAssigneeId = previous.assignedTo;
    const newAssigneeId = data.assignedTo!;

    // Create ActivityLog CHANGE entry with fieldName "assignedTo" and handoffMemo as content
    await prisma.activityLog.create({
      data: {
        entityType: "CAMPAIGN",
        entityId: campaign.id,
        type: "CHANGE",
        fieldName: "assignedTo",
        previousValue: previousAssigneeId ?? null,
        newValue: newAssigneeId,
        content: data.handoffMemo!,
        actor: authContext.userId,
      },
    });
  }

  // 수동 정산 기준액은 금전 근거라 **이전값 → 새 값**을 따로 남긴다(모드 전환 포함).
  if (changedFields.includes(SELLER_FEE_BASIS_CHANGE_LABEL)) {
    await recordCampaignActivity(
      {
        campaignId: campaign.id,
        action: "SELLER_FEE_BASIS_UPDATED",
        label: "정산 기준액",
        details: describeSellerFeeBasisChange(previous.sellerFeeBasisOverride, data.sellerFeeBasisOverride),
        actor: activityActor,
      },
      tx,
    );
  }

  // Handle non-handoff field changes
  if (changedFields.length > 0) {
    // 한 번의 변경 = 이력 한 건 — 정산 기준액은 위 전용 이력이 이미 남겼으므로 일반 목록에서 뺀다.
    const genericChangedFields = changedFields.filter((field) => field !== SELLER_FEE_BASIS_CHANGE_LABEL);
    if (genericChangedFields.length > 0) {
      await recordCampaignActivity(
        {
          campaignId: campaign.id,
          action: "UPDATED",
          label: "Campaign updated",
          details: describeChangedFields(genericChangedFields),
          // 로그인 사용자를 남긴다 — 종전엔 actor 를 안 넘겨 모든 수정 이력이 "SYSTEM" 으로 찍혔다.
          // 표기 관례는 정산 상태 라우트(`settlement-status`)와 같은 이메일이다.
          actor: activityActor,
        },
        tx,
      );
    }

    // 수정 알림은 만들지 않는다 — 수정 이력의 정본은 위
    // recordCampaignActivity(ActivityLog)다(알림센터 해체, 2026-07-24).
  }

  return {
    kind: "ok",
    previous,
    fannedOutSiblings,
    propagatedStatusSiblingIds,
    monthlyCompletionBlocked,
    changedFields,
    calendarSync,
  };
}
