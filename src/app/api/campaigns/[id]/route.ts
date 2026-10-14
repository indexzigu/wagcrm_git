import { NextResponse, after } from "next/server";
import { toCampaignRow } from "@/lib/campaign-row";
import { getPrisma } from "@/lib/prisma";
import { getAuthContext } from "@/lib/auth-context";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import {
  deleteCampaignCalendarEvents,
  syncCampaignToCalendar,
} from "@/lib/google-calendar-sync";
import { updateCampaignSchema } from "@/lib/validations/campaign-update";
import { recalculateCampaignRounds } from "@/services/campaignRounds";
import { CAMPAIGN_DETAIL_INCLUDE } from "@/services/campaignService";
import { applyCampaignPatch } from "@/services/campaignPatchService";

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
  opts: { fannedOutSiblings?: number; propagatedStatusSiblingIds?: string[]; monthlyCompletionBlocked?: string | null } = {},
) {
  const salesTask = await prisma.salesTask.findFirst({
    where: { linkedCampaignId: campaign.id },
  });
  const row = toCampaignRow(campaign);
  if (opts.fannedOutSiblings && opts.fannedOutSiblings > 0) {
    row.groupScheduleSyncedCount = opts.fannedOutSiblings;
  }
  // 그룹 상태 연동 고지 — `groupScheduleSyncedCount` 와 같은 일회성 신호(형제 id 목록).
  if (opts.propagatedStatusSiblingIds && opts.propagatedStatusSiblingIds.length > 0) {
    row.groupStatusSyncedIds = opts.propagatedStatusSiblingIds;
  }
  // 월정산 계산서 완료 게이트가 자동 전이를 보류했다(T-240) — 일회성 신호, 화면이 이유를 토스트로 알린다.
  if (opts.monthlyCompletionBlocked) {
    row.monthlyCompletionBlocked = opts.monthlyCompletionBlocked;
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

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  const parsed = updateCampaignSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // `expectedFinancials` 는 쓰기 필드가 아니므로 `data` 에서 뺀다 — 남겨 두면 변경 필드 판정·
  // no-op 단락(`Object.keys(data)`)이 그것을 「바뀐 필드」로 센다.
  const { expectedFinancials, ...data } = parsed.data;

  // Get auth context for authorization and notification logic
  const authContext = await getAuthContext();

  // 본체(검증·인가·게이트·저장·DB 후처리)는 `applyCampaignPatch` 가 소유한다 — 에이전트
  // `update_record` 승인 실행이 같은 함수를 탄다. 라우트는 외부 IO(캘린더)·캐시·응답만 한다.
  const outcome = await applyCampaignPatch({
    id,
    data,
    expectedFinancials,
    auth: authContext,
  });

  if (outcome.kind === "error") {
    return NextResponse.json(outcome.body, { status: outcome.status });
  }

  const prisma = getPrisma();
  if (outcome.kind === "noop") {
    return buildCampaignRowResponse(prisma, outcome.previous);
  }

  if (outcome.calendarSync) {
    // 저장 응답을 막지 않도록 after()로 백그라운드 동기화(멱등·best-effort).
    after(() =>
      syncCampaignToCalendar(id).catch((calendarError) =>
        console.error("[calendar-sync] 캠페인 수정 훅 실패:", calendarError),
      ),
    );
  }

  revalidateCampaignCaches();

  const refreshedCampaign = await prisma.salesCampaign.findUniqueOrThrow({
    where: { id },
    include: CAMPAIGN_DETAIL_INCLUDE,
  });
  return buildCampaignRowResponse(prisma, refreshedCampaign, {
    fannedOutSiblings: outcome.fannedOutSiblings,
    propagatedStatusSiblingIds: outcome.propagatedStatusSiblingIds,
    monthlyCompletionBlocked: outcome.monthlyCompletionBlocked,
  });
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
