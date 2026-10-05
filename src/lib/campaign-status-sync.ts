import { toKstYmd } from "./date-utils";
import { ensureCampaignChecklistForStatus } from "./campaign-checklist";
import { recordCampaignActivity } from "./campaign-activity";
import { revalidateCampaignCaches } from "./cache-tags";
import { syncCampaignToCalendar } from "./google-calendar-sync";
import type { AppPrismaClient } from "./prisma-client";
import type { CampaignStatus } from "./crm-types";
import { lockCampaignGroup, propagateGroupStatus } from "@/services/campaignGroupService";

export type CampaignStatusSyncCandidate = {
  id: string;
  status: string;
  startDate: Date | string;
  endDate: Date | string;
  groupId?: string | null;
};

export type CampaignStatusSyncVerdict = {
  campaignId: string;
  /** 그룹 상태 연동(`propagateGroupStatus`)이 읽는다 — 후보 행의 groupId 를 그대로 싣는다. */
  groupId: string | null;
  currentStatus: CampaignStatus;
  targetStatus: CampaignStatus | null;
  reason: "EXPIRED_TO_CLOSED" | "STARTED_TO_ACTIVE" | "NONE";
};

/**
 * 캠페인 기간과 현재 시각(KST)을 기준으로 전이 대상 상태를 순수 판정한다.
 *
 * 규칙:
 * 1. 종료일 경과(+1일 이상):
 *    - `toKstYmd(now) > toKstYmd(endDate)` 인 경우,
 *    - 현재 상태가 `ACTIVE` 이거나 기한이 지난 `PREPARATION`이면 -> `CLOSED`(판매마감)
 * 2. 시작일 도달 (진행중 진입):
 *    - `toKstYmd(now) >= toKstYmd(startDate)` 및 `toKstYmd(now) <= toKstYmd(endDate)` 인 경우,
 *    - 현재 상태가 `PREPARATION`이면 -> `ACTIVE`(진행중)
 * 3. 이미 마감/정산/완료/드랍(`CLOSED`, `SETTLEMENT_WAIT`, `SETTLEMENT_IN_PROGRESS`, `COMPLETED`, `DROPPED` 등) 상태인 캠페인은 변경하지 않는다.
 */
export function resolveScheduledCampaignStatus(
  campaign: CampaignStatusSyncCandidate,
  now: Date = new Date(),
): CampaignStatusSyncVerdict {
  const currentStatus = campaign.status as CampaignStatus;
  const groupId = campaign.groupId ?? null;
  const todayKst = toKstYmd(now);
  const startKst = toKstYmd(new Date(campaign.startDate));
  const endKst = toKstYmd(new Date(campaign.endDate));

  // 1. 이미 판매마감 또는 정산/완료/드랍 단계인 경우 자동 전이 제외
  const TERMINAL_OR_SETTLEMENT_STATUSES: readonly string[] = [
    "CLOSED",
    "SETTLEMENT_WAIT",
    "SETTLEMENT_IN_PROGRESS",
    "COMPLETED",
    "DROPPED",
  ];
  if (TERMINAL_OR_SETTLEMENT_STATUSES.includes(currentStatus)) {
    return { campaignId: campaign.id, groupId, currentStatus, targetStatus: null, reason: "NONE" };
  }

  // 2. 판매 종료일 경과(+1일 도달/초과): ACTIVE 또는 기한 지난 PREPARATION -> CLOSED
  // 예: endKst가 2026-09-08이고 todayKst가 2026-09-09 이상이면 판매마감
  if (todayKst > endKst) {
    return {
      campaignId: campaign.id,
      groupId,
      currentStatus,
      targetStatus: "CLOSED",
      reason: "EXPIRED_TO_CLOSED",
    };
  }

  // 3. 판매 시작일 도달 및 진행 기간 내: PREPARATION -> ACTIVE
  if (currentStatus === "PREPARATION" && todayKst >= startKst && todayKst <= endKst) {
    return {
      campaignId: campaign.id,
      groupId,
      currentStatus,
      targetStatus: "ACTIVE",
      reason: "STARTED_TO_ACTIVE",
    };
  }

  return { campaignId: campaign.id, groupId, currentStatus, targetStatus: null, reason: "NONE" };
}

export type SyncCampaignStatusOptions = {
  dryRun?: boolean;
  activateStarted?: boolean; // 기본값: true (시작일 도달 시 ACTIVE 전환)
};

export type SyncCampaignStatusesResult = {
  totalChecked: number;
  expiredToClosedCount: number;
  startedToActiveCount: number;
  /** 직접 전이한 캠페인 + 그룹 연동으로 따라간 형제 전부. */
  updatedCampaignIds: string[];
  /** 그 중 그룹 상태 연동(`propagateGroupStatus`)으로 바뀐 형제 id. */
  propagatedSiblingIds: string[];
};

type SyncCampaignsDb = Pick<AppPrismaClient, "salesCampaign" | "$transaction">;

/**
 * DB의 판매 캠페인들을 조회하여 기간에 맞게 상태를 자동으로 전이한다.
 */
export async function syncCampaignStatusesBySchedule(
  prisma: SyncCampaignsDb,
  now: Date = new Date(),
  options: SyncCampaignStatusOptions = {},
): Promise<SyncCampaignStatusesResult> {
  const { dryRun = false, activateStarted = true } = options;

  // 검사 대상: 아직 정산/완료되지 않은 활성 파이프라인 후보 (PREPARATION, ACTIVE)
  const candidates = await prisma.salesCampaign.findMany({
    where: {
      status: { in: ["PREPARATION", "ACTIVE"] },
    },
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      groupId: true,
    },
  });

  const verdicts = candidates.map((c) => resolveScheduledCampaignStatus(c, now));
  const actionable = verdicts.filter((v) => {
    if (v.targetStatus == null) return false;
    if (v.reason === "STARTED_TO_ACTIVE" && !activateStarted) return false;
    return true;
  });

  let expiredToClosedCount = 0;
  let startedToActiveCount = 0;
  const updatedCampaignIds: string[] = [];
  const propagatedSiblingIds: string[] = [];
  // 이번 실행에서 그룹 연동으로 이미 목표 상태가 된 형제 — 자기 차례가 와도 다시 쓰지 않는다
  // (멱등·이력 중복 방지). 형제는 같은 그룹이라 일정이 같아 보통 같은 판정을 받는다.
  const alreadyPropagated = new Map<string, CampaignStatus>();

  for (const verdict of actionable) {
    const targetStatus = verdict.targetStatus!;
    if (alreadyPropagated.get(verdict.campaignId) === targetStatus) continue;
    if (verdict.reason === "EXPIRED_TO_CLOSED") expiredToClosedCount += 1;
    if (verdict.reason === "STARTED_TO_ACTIVE") startedToActiveCount += 1;
    updatedCampaignIds.push(verdict.campaignId);

    if (!dryRun) {
      const label = targetStatus === "CLOSED" ? "자동 판매마감" : "자동 진행 전환";
      // 원본 쓰기와 그룹 상태 연동은 한 트랜잭션이다 — 형제만 빠진 커밋이 없어야 한다.
      const propagated = await prisma.$transaction(async (tx) => {
        // 🪤 락 순서: 원본 행을 쓰기 전에 그룹 락부터(`lockCampaignGroup` 주석).
        if (verdict.groupId) await lockCampaignGroup(tx, verdict.groupId);
        await tx.salesCampaign.update({
          where: { id: verdict.campaignId },
          data: { status: targetStatus },
        });
        return propagateGroupStatus(tx, {
          originCampaignId: verdict.campaignId,
          groupId: verdict.groupId,
          originPreviousStatus: verdict.currentStatus,
          status: targetStatus,
          actor: "SYSTEM",
          log: { kind: "campaign-activity", action: "STATUS_AUTO_TRANSITION", label },
          // 형제 **자신의** 기간으로 다시 판정해 같은 답이 나올 때만 옮긴다 — 그룹 멤버의 기간은
          // 서로 다를 수 있어(묶기·합류가 기간을 맞추지 않는다) 원본 기준으로 옮기면 종료 전
          // 형제를 미리 마감하거나 시작 전 형제를 진행으로 만든다(교차 리뷰 지적 2026-10-05).
          // 판정 함수가 마감·정산·완료·드랍 형제를 이미 null 로 거르므로 상태 집합을 따로 두지 않는다.
          isSiblingEligible: (sibling) =>
            resolveScheduledCampaignStatus(sibling, now).targetStatus === targetStatus,
        });
      });
      for (const sibling of propagated) {
        alreadyPropagated.set(sibling.id, targetStatus);
        propagatedSiblingIds.push(sibling.id);
        updatedCampaignIds.push(sibling.id);
      }

      // 부수 효과: 새 상태 템플릿 체크리스트 생성 — 그룹 연동 형제도 원본과 같은 후처리를 받는다.
      for (const campaignId of [verdict.campaignId, ...propagated.map((s) => s.id)]) {
        try {
          await ensureCampaignChecklistForStatus(prisma as AppPrismaClient, campaignId, targetStatus);
        } catch (err) {
          console.error(`[campaign-status-sync] 체크리스트 생성 실패 (${campaignId}):`, err);
        }
      }

      // 활동 이력 기록
      try {
        const details =
          verdict.reason === "EXPIRED_TO_CLOSED"
            ? `캠페인 기간 종료(+1일 경과)에 따른 자동 판매마감 (${verdict.currentStatus} → ${targetStatus})`
            : `캠페인 시작일 도달에 따른 자동 진행 전환 (${verdict.currentStatus} → ${targetStatus})`;

        await recordCampaignActivity({
          campaignId: verdict.campaignId,
          action: "STATUS_AUTO_TRANSITION",
          label: targetStatus === "CLOSED" ? "자동 판매마감" : "자동 진행 전환",
          details,
          actor: "SYSTEM",
        });
      } catch (err) {
        console.error(`[campaign-status-sync] 활동 이력 기록 실패 (${verdict.campaignId}):`, err);
      }

      // 구글 캘린더 동기화 (best-effort) — 그룹 소속이면 내부에서 그룹 전체 동기화로 위임하므로
      // 형제마다 다시 부르지 않는다.
      try {
        await syncCampaignToCalendar(verdict.campaignId);
      } catch (err) {
        console.error(`[campaign-status-sync] 캘린더 동기화 실패 (${verdict.campaignId}):`, err);
      }
    }
  }

  if (!dryRun && updatedCampaignIds.length > 0) {
    try {
      revalidateCampaignCaches();
    } catch {
      // revalidateTag outside request scope safe ignore
    }
  }

  return {
    totalChecked: candidates.length,
    expiredToClosedCount,
    startedToActiveCount,
    updatedCampaignIds,
    propagatedSiblingIds,
  };
}
