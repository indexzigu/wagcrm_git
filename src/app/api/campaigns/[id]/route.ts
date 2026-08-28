import { NextResponse, after } from "next/server";
import { z } from "zod";
import { describeChangedFields, recordCampaignActivity } from "@/lib/campaign-activity";
import { ensureCampaignChecklistForStatus } from "@/lib/campaign-checklist";
import { generateCampaignName } from "@/lib/campaign-name";
import { toCampaignRow } from "@/lib/campaign-row";
import { getPrisma } from "@/lib/prisma";
import { getAuthContext } from "@/lib/auth-context";
import { getCrmUsers } from "@/lib/user-registry";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import {
  deleteCampaignCalendarEvents,
  syncCampaignToCalendar,
} from "@/lib/google-calendar-sync";
import { recalculateCampaignRounds } from "@/services/campaignRounds";
import { campaignService, CAMPAIGN_DETAIL_INCLUDE } from "@/services/campaignService";
import { dealStoreLinkResetTargets } from "@/lib/order-converter/review-link";
import {
  SETTLEMENT_COUNTERPARTIES,
  SETTLEMENT_INVOICE_MODES,
} from "@/lib/settlement-items";
import {
  resolveSettlementStates,
  diffCampaignChanges,
  resolveSettlementSync,
  resolveReturnPeriodEndDate,
  resolveAutoStatus,
} from "@/lib/campaign-update-plan";

type Context = {
  params: Promise<{ id: string }>;
};

// PATCH 응답 조립 — "salesTask 조회 → toCampaignRow → groupScheduleSyncedCount 조건부
// 부착(>0 일 때만) → salesTask 6필드 부착 → NextResponse.json" 패턴을 통합한다
// (behavior-preserving 리팩터 1단계). ⚠️ no-op 단락(변경 없음, 재조회 없이 previous 그대로)도
// 이 헬퍼로 표현 가능 — previous 자체가 CAMPAIGN_DETAIL_INCLUDE 로 조회된 행이라 그대로 넘긴다.
async function buildCampaignRowResponse(
  prisma: ReturnType<typeof getPrisma>,
  campaign: Parameters<typeof toCampaignRow>[0],
  opts: { fannedOutSiblings?: number } = {},
) {
  const salesTask = await prisma.salesTask.findFirst({
    where: { linkedCampaignId: campaign.id },
  });
  const row = toCampaignRow(campaign);
  if (opts.fannedOutSiblings && opts.fannedOutSiblings > 0) {
    row.groupScheduleSyncedCount = opts.fannedOutSiblings;
  }
  row.salesTask = salesTask
    ? {
        id: salesTask.id,
        status: salesTask.status,
        contactChannel: salesTask.contactChannel,
        proposalMessage: salesTask.proposalMessage,
        negotiationMemo: salesTask.negotiationMemo,
        testingMemo: salesTask.testingMemo,
      }
    : null;
  return NextResponse.json(row);
}

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();

  const campaign = await prisma.salesCampaign.findUnique({
    where: { id },
    include: CAMPAIGN_DETAIL_INCLUDE,
  });

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const salesTask = await prisma.salesTask.findFirst({
    where: { linkedCampaignId: id },
  });

  const row = toCampaignRow(campaign);
  row.salesTask = salesTask
    ? {
        id: salesTask.id,
        status: salesTask.status,
        contactChannel: salesTask.contactChannel,
        proposalMessage: salesTask.proposalMessage,
        negotiationMemo: salesTask.negotiationMemo,
        testingMemo: salesTask.testingMemo,
      }
    : null;

  return NextResponse.json(row);
}

const updateCampaignSchema = z.object({
  status: z
    .enum([
      "PROPOSAL",
      "PREPARATION",
      "ACTIVE",
      "CLOSED",
      "SETTLEMENT_WAIT",
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
      "DROPPED",
    ])
    .optional(),
  salesChannel: z.enum(["UNSPECIFIED", "OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"]).optional(),
  actualSales: z.coerce.number().nonnegative().nullable().optional(),
  operatingExpense: z.coerce.number().min(-999_999_999).max(999_999_999).nullable().optional(),
  miscExpense: z.coerce.number().min(-999_999_999).max(999_999_999).nullable().optional(),
  quantity: z.coerce.number().int().nonnegative().max(999_999).nullable().optional(),
  itemCount: z.coerce.number().int().nonnegative().max(999_999).nullable().optional(),
  totalMarginRate: z.coerce.number().nonnegative().optional(),
  sellerMarginRate: z.coerce.number().nonnegative().optional(),
  netMarginRate: z.coerce.number().optional(),
  isManualMargin: z.boolean().optional(),
  isManualSettlementSales: z.boolean().optional(),
  isManualSellerExpense: z.boolean().optional(),
  isManualTaxExpense: z.boolean().optional(),
  settlementSales: z.coerce.number().nonnegative().nullable().optional(),
  sellerExpense: z.coerce.number().nonnegative().nullable().optional(),
  taxExpense: z.coerce.number().nonnegative().nullable().optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  isDepositReceived: z.boolean().optional(),
  depositReceivedAt: z.string().date().nullable().optional(),
  isPayoutCompleted: z.boolean().optional(),
  payoutCompletedAt: z.string().date().nullable().optional(),
  // 자사몰 공급사 지급 레그 — 슬롯 SSOT: resolveCampaignMoneySlots(tax-filing-board.ts)
  isSupplierPayoutCompleted: z.boolean().optional(),
  supplierPayoutCompletedAt: z.string().date().nullable().optional(),
  returnPeriodEndDate: z.string().date().nullable().optional(),
  settlementSupplyCost: z.coerce.number().nonnegative().nullable().optional(),
  // 수기 물품대금(세무 대조 전용) — 0 은 「타 캠페인 계산서에 합산됨」 마커라 유효값이다.
  settlementGoodsCost: z.coerce.number().nonnegative().nullable().optional(),
  /**
   * 정산 부가 항목 — **전체 교체**(보낸 배열이 곧 최종 상태, 생략하면 무변경).
   * 행이 몇 개 안 되는 목록이라 부분 패치보다 교체가 단순하고, 편집 모드가 통째로
   * 저장하는 화면 흐름과도 맞는다.
   *
   * ⛔ `amount` 는 **부호 있는 값**이라 `nonnegative()` 를 걸지 않는다 — 음수는
   * 역방향 정정(수정세금계산서·반품 조정 차감)이고 자사 항목에선 지출을 뜻한다
   * (설계 §2-2, `resolveSettlementItemSignedAmount`).
   */
  settlementItems: z
    .array(
      z.object({
        invoiceMode: z.enum(SETTLEMENT_INVOICE_MODES),
        counterparty: z.enum(SETTLEMENT_COUNTERPARTIES),
        amount: z.coerce.number().min(-999_999_999).max(999_999_999),
        note: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .max(50)
    .optional(),
  supplierInvoiceIssuedAt: z.string().date().nullable().optional(),
  sellerInvoiceIssuedAt: z.string().date().nullable().optional(),
  expectedDepositDate: z.string().date().nullable().optional(),
  expectedPayoutDate: z.string().date().nullable().optional(),
  expectedSupplierPayoutDate: z.string().date().nullable().optional(),
  accountingCompletedAt: z.string().date().nullable().optional(),
  invoiceInfo: z.string().max(1000).nullable().optional(),
  roundNumber: z.coerce.number().int().nonnegative().nullable().optional(),
  campaignName: z.string().max(100).nullable().optional(),
  dealId: z.string().optional(),
  sellerId: z.string().optional(),
  baseNaverLink: z.string().optional(),
  assignedTo: z.string().optional(),
  handoffMemo: z.string().optional(),
  dropReason: z.string().trim().max(500).optional(),
  notesFromImport: z.string().max(1000).nullable().optional(),
  sellerTaxType: z.string().nullable().optional(),
  salesTask: z
    .object({
      contactChannel: z.string().nullable().optional(),
      proposalMessage: z.string().nullable().optional(),
      negotiationMemo: z.string().nullable().optional(),
      testingMemo: z.string().nullable().optional(),
    })
    .optional(),
  campaignDeals: z.array(z.object({
    id: z.string().optional(),
    dealId: z.string(),
    quantity: z.coerce.number().int().nonnegative(),
    actualSales: z.coerce.number().nonnegative(),
    feeRate: z.coerce.number().nonnegative().nullable().optional(),
    sellerMarginRate: z.coerce.number().nonnegative().nullable().optional(),
    costPrice: z.coerce.number().nonnegative().nullable().optional(),
    sellingPrice: z.coerce.number().nonnegative().nullable().optional(),
  })).optional(),
});

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  const parsed = updateCampaignSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;

  // Validation: if assignedTo is provided, handoffMemo must be non-empty
  if (data.assignedTo !== undefined) {
    if (!data.handoffMemo || data.handoffMemo.trim() === "") {
      return NextResponse.json(
        { error: "Handoff memo is required" },
        { status: 400 },
      );
    }
  }

  if (data.status === "DROPPED" && !data.dropReason?.trim()) {
    return NextResponse.json(
      { error: "Drop reason is required" },
      { status: 400 },
    );
  }

  // Get auth context for authorization and notification logic
  const authContext = await getAuthContext();

  // Authorization: only admin role can change assignedTo
  if (data.assignedTo !== undefined) {
    if (!authContext || authContext.role !== "admin") {
      return NextResponse.json(
        { error: "Only admins can reassign campaigns" },
        { status: 403 },
      );
    }
  }

  const prisma = getPrisma();
  const previous = await prisma.salesCampaign.findUnique({
    where: { id },
    include: CAMPAIGN_DETAIL_INCLUDE,
  });
  if (!previous) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Determine if this is a handoff operation
  const isHandoff =
    data.assignedTo !== undefined && data.assignedTo !== previous.assignedTo;

  // If handoff, validate target user exists
  if (isHandoff) {
    const users = await getCrmUsers();
    const targetUser = users.find((u) => u.id === data.assignedTo);
    if (!targetUser) {
      return NextResponse.json(
        { error: "Target user not found" },
        { status: 404 },
      );
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
  const autoStatus = resolveAutoStatus(settlementStates, previous.status, previous.salesChannel);

  const isOnlyNoOpSettlementToggle =
    !settlementStateChanged &&
    Object.keys(data).every(
      (field) =>
        field === "isDepositReceived" ||
        field === "isPayoutCompleted" ||
        field === "isSupplierPayoutCompleted",
    );
  if (isOnlyNoOpSettlementToggle) {
    return buildCampaignRowResponse(prisma, previous);
  }

  // 트랜잭션 본체는 campaignService.updateCampaign 이 소유한다(3계층 이관 3단계) —
  // 그룹 공유필드 updateMany + 멤버십 낙관 검사 · 일정 팬아웃 · salesTask · campaignDeals ·
  // 재무 파생 · 본 update · 그룹 롤업까지. 라우트는 아래 후처리(외부 IO 포함)만 소유한다.
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
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: "Campaign group membership changed; retry the update" },
      { status: 409 },
    );
  }

  const campaign = result.campaign;
  const fannedOutSiblings = result.fannedOutSiblings;

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

    // Update the campaign object in memory for the response
    (campaign as Record<string, unknown>).campaignName = newCampaignName;
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

  // 구글 캘린더 동기화 — 캘린더에 반영되는 필드가 실제로 바뀐 경우에만 (best-effort).
  // 멱등이라 재호출해도 일정이 중복 생성되지 않으며, 미연결/오류 시에도 저장은 성공시킨다.
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
  if (
    changedFields.some((field) => CALENDAR_SYNC_FIELDS.has(field)) ||
    dealChanged ||
    sellerChanged ||
    roundChanged
  ) {
    // 저장 응답을 막지 않도록 after()로 백그라운드 동기화(멱등·best-effort).
    after(() =>
      syncCampaignToCalendar(id).catch((calendarError) =>
        console.error("[calendar-sync] 캠페인 수정 훅 실패:", calendarError),
      ),
    );
  }

  // Generic checklist auto-generation when a campaign enters a workflow status.
  if (data.status && data.status !== previous.status) {
    await ensureCampaignChecklistForStatus(prisma, id, data.status);
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
    await recordCampaignActivity({
      campaignId: campaign.id,
      action: "DROPPED",
      label: "Campaign dropped",
      details: `${previous.status} -> DROPPED · ${data.dropReason?.trim() ?? ""}`,
      actor,
    });
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

  // Handle non-handoff field changes
  if (changedFields.length > 0) {
    await recordCampaignActivity({
      campaignId: campaign.id,
      action: "UPDATED",
      label: "Campaign updated",
      details: describeChangedFields(changedFields),
    });

    // 수정 알림은 만들지 않는다 — 수정 이력의 정본은 위
    // recordCampaignActivity(ActivityLog)다(알림센터 해체, 2026-07-24).

    const refreshed = await prisma.salesCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
      include: CAMPAIGN_DETAIL_INCLUDE,
    });
    revalidateCampaignCaches();

    return buildCampaignRowResponse(prisma, refreshed, { fannedOutSiblings });
  }

  revalidateCampaignCaches();

  const refreshedCampaign = await prisma.salesCampaign.findUniqueOrThrow({
    where: { id },
    include: CAMPAIGN_DETAIL_INCLUDE,
  });
  return buildCampaignRowResponse(prisma, refreshedCampaign, { fannedOutSiblings });
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();
  // 행 삭제 후에는 조회가 불가하므로, 캘린더 이벤트 id와 함께
  // (dealId, sellerId) 코호트 키도 먼저 확보한다 — 삭제 후 남은 캠페인의
  // 차수·캠페인명을 재계산해 "N차" 잔존을 막기 위함이다.
  const existing = await prisma.salesCampaign.findUnique({
    where: { id },
    select: { calendarEventIds: true, dealId: true, sellerId: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.trackingAttribution.updateMany({
      where: { campaignId: id },
      data: { campaignId: null },
    });
    await tx.asset.updateMany({
      where: { campaignId: id },
      data: { campaignId: null },
    });
    await tx.salesCampaign.delete({ where: { id } });

    // 삭제로 코호트 구성이 바뀌었으니 같은 tx 안에서 차수·이름을 재계산한다.
    // (recalculateCampaignRounds는 pg_advisory_xact_lock을 쓰므로 반드시 tx 내 호출)
    if (existing) {
      await recalculateCampaignRounds(existing.dealId, existing.sellerId, tx);
    }
  });
  revalidateCampaignCaches();
  // 동기화됐던 구글 캘린더 이벤트 정리 — 삭제 응답을 막지 않도록 after()로
  // fire-and-forget(멱등·best-effort), 실패는 로그만 남긴다.
  const calendarEventIds = existing?.calendarEventIds ?? null;
  if (calendarEventIds) {
    after(async () => {
      try {
        const result = await deleteCampaignCalendarEvents(calendarEventIds);
        if (!result.ok) {
          console.error(
            `[calendar-sync] 캠페인 ${id} 삭제 훅 이벤트 정리 실패:`,
            result,
          );
        }
      } catch (calendarError) {
        console.error(
          `[calendar-sync] 캠페인 ${id} 삭제 훅 실패:`,
          calendarError,
        );
      }
    });
  }
  return NextResponse.json({ ok: true });
}
