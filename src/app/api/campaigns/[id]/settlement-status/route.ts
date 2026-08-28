import { NextResponse, after } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { recordActivityChange } from "@/lib/activity-log";
import { getAuthContext } from "@/lib/auth-context";
import { computeAutoStatus } from "@/lib/settlement-status";
import { syncCampaignToCalendar } from "@/lib/google-calendar-sync";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import {
  resolveSettlementFlagSnapshot,
  writeSettlementFlags,
  type SettlementScalarUpdates,
} from "@/lib/settlement-flag-write";

/**
 * ⛔ 세 플래그는 **채널이 고르는 슬롯의 완료 축**이다(`resolveCampaignMoneySlots`).
 * 자사몰은 [공급사 지급, 셀러 지급]이라 `isSupplierPayoutCompleted` 가 없으면 대시보드
 * 「지연된 정산」 모달이 공급사 지급 지연을 **처리할 방법이 없다**(2026-08-25 2단계).
 * 아래 세 블록은 형태가 같아야 한다 — 하나만 고치면 그 레그만 그룹 전파·감사 기록·
 * status 자동전이에서 빠진다.
 */
const updateSchema = z.object({
  isDepositReceived: z.boolean().optional(),
  isPayoutCompleted: z.boolean().optional(),
  isSupplierPayoutCompleted: z.boolean().optional(),
  memo: z.string().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const parsed = updateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();
  const campaign = await prisma.salesCampaign.findUnique({
    where: { id },
    include: { group: true },
  });

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const authCtx = await getAuthContext();
  const actor = authCtx?.email ?? "SYSTEM";
  const group = campaign.groupId ? campaign.group : null;
  // 정본 행 고르기(CG-1)는 `settlement-flag-write` 가 소유한다 — 여기서 세 번 손으로
  // `group?.X ?? campaign.X` 를 쓰면 어시스턴트 경로가 그랬듯 한 레그만 낡은 값을 본다.
  const previousFlags = resolveSettlementFlagSnapshot(campaign, group);
  const previousDepositState = previousFlags.isDepositReceived;
  const previousPayoutState = previousFlags.isPayoutCompleted;
  const previousSupplierPayoutState = previousFlags.isSupplierPayoutCompleted;
  const newDepositState = parsed.data.isDepositReceived ?? previousDepositState;
  const newPayoutState = parsed.data.isPayoutCompleted ?? previousPayoutState;
  const newSupplierPayoutState =
    parsed.data.isSupplierPayoutCompleted ?? previousSupplierPayoutState;

  const settlementUpdates: SettlementScalarUpdates = {};

  if (parsed.data.isDepositReceived !== undefined && newDepositState !== previousDepositState) {
    settlementUpdates.isDepositReceived = parsed.data.isDepositReceived;
    if (parsed.data.isDepositReceived) {
      settlementUpdates.depositReceivedAt = new Date();
    } else {
      settlementUpdates.depositReceivedAt = null;
    }
  }

  if (parsed.data.isPayoutCompleted !== undefined && newPayoutState !== previousPayoutState) {
    settlementUpdates.isPayoutCompleted = parsed.data.isPayoutCompleted;
    if (parsed.data.isPayoutCompleted) {
      settlementUpdates.payoutCompletedAt = new Date();
    } else {
      settlementUpdates.payoutCompletedAt = null;
    }
  }

  if (
    parsed.data.isSupplierPayoutCompleted !== undefined &&
    newSupplierPayoutState !== previousSupplierPayoutState
  ) {
    settlementUpdates.isSupplierPayoutCompleted = parsed.data.isSupplierPayoutCompleted;
    if (parsed.data.isSupplierPayoutCompleted) {
      settlementUpdates.supplierPayoutCompletedAt = new Date();
    } else {
      settlementUpdates.supplierPayoutCompletedAt = null;
    }
  }

  // Auto-transition logic — 판정은 computeAutoStatus(채널 인지 SSOT) 하나다.
  const settlementStateChanged =
    newDepositState !== previousDepositState ||
    newPayoutState !== previousPayoutState ||
    newSupplierPayoutState !== previousSupplierPayoutState;
  const autoStatus = settlementStateChanged
    ? computeAutoStatus(campaign.status, campaign.salesChannel, {
        isDepositReceived: newDepositState,
        isPayoutCompleted: newPayoutState,
        isSupplierPayoutCompleted: newSupplierPayoutState,
      })
    : null;
  const campaignUpdates: Prisma.SalesCampaignUpdateManyMutationInput = autoStatus
    ? { status: autoStatus }
    : {};

  // Use a transaction to update salesCampaign and record activities atomically
  const updated = await prisma.$transaction(async (tx) => {
    // 플래그는 정본 행(그룹이면 그룹 스칼라)에, status 는 멤버 행에 — 판정은 SSOT 하나다.
    // ⚠️ 감사 기록보다 **먼저** 부른다: 멤버십이 바뀌어 쓰기가 거절되면 로그도 남지 않아야 한다
    // (`recordActivityChange` 는 tx 를 받지 않아 롤백에 딸려오지 않는다).
    const written = await writeSettlementFlags(tx, {
      campaign,
      group,
      settlementUpdates,
      campaignUpdates,
    });
    if (!written.ok) return null;

    if (parsed.data.isDepositReceived !== undefined && previousDepositState !== parsed.data.isDepositReceived) {
      await recordActivityChange(
        "CAMPAIGN",
        id,
        "isDepositReceived",
        previousDepositState,
        parsed.data.isDepositReceived,
        actor
      );
    }

    if (parsed.data.isPayoutCompleted !== undefined && previousPayoutState !== parsed.data.isPayoutCompleted) {
      await recordActivityChange(
        "CAMPAIGN",
        id,
        "isPayoutCompleted",
        previousPayoutState,
        parsed.data.isPayoutCompleted,
        actor
      );
    }

    if (
      parsed.data.isSupplierPayoutCompleted !== undefined &&
      previousSupplierPayoutState !== parsed.data.isSupplierPayoutCompleted
    ) {
      await recordActivityChange(
        "CAMPAIGN",
        id,
        "isSupplierPayoutCompleted",
        previousSupplierPayoutState,
        parsed.data.isSupplierPayoutCompleted,
        actor
      );
    }

    const expectedStatus = autoStatus;
    if (expectedStatus && campaign.status !== expectedStatus) {
      await recordActivityChange(
        "CAMPAIGN",
        id,
        "status",
        campaign.status,
        expectedStatus,
        actor
      );
    }

    if (parsed.data.memo && parsed.data.memo.trim() !== "") {
      await tx.campaignNote.create({
        data: {
          campaignId: id,
          content: parsed.data.memo,
          actor: actor,
        },
      });
    }

    return { campaign: written.campaign, group: written.group };
  });

  if (!updated) {
    return NextResponse.json(
      { error: "Campaign group membership changed; retry the update" },
      { status: 409 },
    );
  }

  revalidateCampaignCaches();

  // 입금/지급 상태·일자는 캘린더 입금/출금 이벤트의 소스 — 다음 전체 동기화까지
  // stale로 남지 않게 여기서 재동기화한다(그룹 캠페인은 내부에서 그룹 동기화로
  // 위임). fire-and-forget — 캘린더 실패가 정산 토글을 막지 않는다.
  if (settlementStateChanged) {
    after(async () => {
      try {
        const result = await syncCampaignToCalendar(id);
        if (!result.ok && !result.skipped) {
          console.error(`[calendar-sync] 캠페인 ${id} 정산 토글 훅 동기화 실패:`, result);
        }
      } catch (calendarError) {
        console.error(`[calendar-sync] 캠페인 ${id} 정산 토글 훅 실패:`, calendarError);
      }
    });
  }

  const effectiveGroup = updated.group;
  const effectiveCampaign = updated.campaign;

  return NextResponse.json({
    id: effectiveCampaign.id,
    status: effectiveCampaign.status,
    isDepositReceived: effectiveGroup ? effectiveGroup.isDepositReceived : effectiveCampaign.isDepositReceived,
    isPayoutCompleted: effectiveGroup ? effectiveGroup.isPayoutCompleted : effectiveCampaign.isPayoutCompleted,
    isSupplierPayoutCompleted: effectiveGroup
      ? effectiveGroup.isSupplierPayoutCompleted
      : effectiveCampaign.isSupplierPayoutCompleted,
    depositReceivedAt: effectiveGroup ? effectiveGroup.depositReceivedAt : effectiveCampaign.depositReceivedAt,
    payoutCompletedAt: effectiveGroup ? effectiveGroup.payoutCompletedAt : effectiveCampaign.payoutCompletedAt,
    supplierPayoutCompletedAt: effectiveGroup
      ? effectiveGroup.supplierPayoutCompletedAt
      : effectiveCampaign.supplierPayoutCompletedAt,
  });
}
