import { sellerDisplayName } from "@/lib/seller-display-name";
import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { priceMonitorSnapshotRepository } from "@/repositories/priceMonitorSnapshotRepository";
import {
  MARKET_SOURCE_LABEL,
  type MarketSourceChannel,
  type MarketSourceStatus,
} from "@/lib/price-monitor/source-errors";
import type { MarketSourceState, MarketSourceStates } from "@/lib/price-monitor/source-status";

/**
 * 홈 "최저가 방어" 카드 공급 API — 알림센터 해체(2026-07-24 오너 확정)의 대체 표면.
 *
 * price-monitoring 크론이 매일 적재하는 일일 스냅샷을 타깃(딜×캠페인)별 최신
 * 1건으로 요약해 반환한다. 신규 수집·쓰기 없음(읽기 전용). 종전 PRICE_VIOLATION
 * 알림이 캠페인 상세를 열어야만 보이던 유일 통로 문제를 홈 상시 노출로 대체한다.
 */

// 종료된 타깃의 낡은 스냅샷이 "현재 상태"로 보이지 않도록 하는 조회 창.
// 크론은 매일 돌므로 살아있는 타깃은 항상 이 창 안에 최신 행이 있다.
const RECENT_WINDOW_DAYS = 7;

type OverviewEntry = {
  dealId: string;
  campaignId: string | null;
  dealName: string;
  verdict: string;
  ourUnitPrice: number | null;
  minValidPrice: number | null;
  snapshotDate: string;
};

type SourceHealthEntry = {
  status: MarketSourceStatus | "unknown";
  checkedAt: string | null;
  itemCount: number;
  lastSuccessAt: string | null;
  latestError: string | null;
};

type SourceHealth = Record<MarketSourceChannel, SourceHealthEntry>;

const SOURCE_CHANNELS = Object.keys(MARKET_SOURCE_LABEL) as MarketSourceChannel[];
const SOURCE_STATUSES = new Set<MarketSourceStatus>(["ok", "empty", "error", "disabled"]);
const SOURCE_STATUS_PRIORITY: Record<SourceHealthEntry["status"], number> = {
  ok: 1,
  empty: 1,
  disabled: 2,
  unknown: 3,
  error: 4,
};
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SOURCE_AGE_MS = (RECENT_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;

function createSourceHealth(): SourceHealth {
  return Object.fromEntries(
    SOURCE_CHANNELS.map((channel) => [
      channel,
      { status: "unknown", checkedAt: null, itemCount: 0, lastSuccessAt: null, latestError: null },
    ]),
  ) as SourceHealth;
}

function parseRecentTime(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > now + MAX_FUTURE_SKEW_MS || parsed < now - MAX_SOURCE_AGE_MS) return null;
  return parsed;
}

function isMarketSourceState(value: unknown, now = Date.now()): value is MarketSourceState {
  if (value == null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.checkedAt === "string" &&
    parseRecentTime(state.checkedAt, now) !== null &&
    SOURCE_STATUSES.has(state.status as MarketSourceStatus) &&
    typeof state.itemCount === "number" &&
    Number.isFinite(state.itemCount) &&
    state.itemCount >= 0
  );
}

function readSourceStates(value: unknown, now = Date.now()): Partial<MarketSourceStates> {
  if (value == null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    SOURCE_CHANNELS.flatMap((channel) => (isMarketSourceState(record[channel], now) ? [[channel, record[channel]]] : [])),
  ) as Partial<MarketSourceStates>;
}

function readSourceErrors(value: unknown): Partial<Record<MarketSourceChannel, string>> {
  if (value == null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    SOURCE_CHANNELS.flatMap((channel) => {
      const reason = record[channel];
      return typeof reason === "string" && reason.trim() ? [[channel, reason.trim()]] : [];
    }),
  ) as Partial<Record<MarketSourceChannel, string>>;
}

function timeValue(value: string | null, now = Date.now()): number {
  return parseRecentTime(value, now) ?? 0;
}

function buildSourceHealth(
  latestSnapshots: Array<{ snapshotDate: string; evidence: unknown }>,
  historySnapshots: Array<{ snapshotDate: string; evidence: unknown }>,
  now = Date.now(),
): SourceHealth {
  const health = createSourceHealth();

  for (const channel of SOURCE_CHANNELS) {
    const observations = latestSnapshots.map((snapshot) => {
      const evidence = priceMonitorSnapshotRepository.parseEvidence(snapshot);
      const states = readSourceStates(evidence?.sourceStates, now);
      const errors = readSourceErrors(evidence?.sourceErrors);
      const state = states[channel];
      const reason = errors[channel] ?? null;
      const observedAt = timeValue(state?.checkedAt ?? snapshot.snapshotDate, now);

      if (!state) {
        return {
          status: "unknown" as const,
          checkedAt: null,
          itemCount: 0,
          latestError: reason,
          observedAt,
        };
      }

      if (reason && state.status !== "disabled") {
        return {
          status: "error" as const,
          checkedAt: state.checkedAt,
          itemCount: state.itemCount,
          latestError: reason,
          observedAt,
        };
      }

      return {
        status: state.status,
        checkedAt: state.checkedAt,
        itemCount: state.itemCount,
        latestError: state.status === "error" ? reason ?? "소스 응답 실패" : null,
        observedAt,
      };
    });

    const current = observations.reduce((best, candidate) => {
      if (!best) return candidate;
      const candidatePriority = SOURCE_STATUS_PRIORITY[candidate.status];
      const bestPriority = SOURCE_STATUS_PRIORITY[best.status];
      return candidatePriority > bestPriority || (candidatePriority === bestPriority && candidate.observedAt >= best.observedAt)
        ? candidate
        : best;
    }, null as (typeof observations)[number] | null);

    if (current) {
      health[channel] = {
        status: current.status,
        checkedAt: current.checkedAt,
        itemCount: current.itemCount,
        lastSuccessAt: null,
        latestError: current.latestError,
      };
    }

    let lastSuccessValue = 0;
    for (const snapshot of historySnapshots) {
      const evidence = priceMonitorSnapshotRepository.parseEvidence(snapshot);
      const state = readSourceStates(evidence?.sourceStates, now)[channel];
      if (!state || (state.status !== "ok" && state.status !== "empty")) continue;
      const successValue = parseRecentTime(state.checkedAt, now);
      if (successValue !== null && successValue >= lastSuccessValue) {
        lastSuccessValue = successValue;
        health[channel].lastSuccessAt = state.checkedAt;
      }
    }
  }

  return health;
}

export async function GET() {
  try {
    const prisma = getPrisma();
    const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const sinceKey = since.toISOString().slice(0, 10);

    const snapshots = await prisma.priceMonitorSnapshot.findMany({
      where: { snapshotDate: { gte: sinceKey } },
      orderBy: { snapshotDate: "desc" },
      select: {
        dealId: true,
        campaignId: true,
        snapshotDate: true,
        verdict: true,
        ourUnitPrice: true,
        minValidPrice: true,
        evidence: true,
        deal: { select: { dealName: true } },
      },
    });

    // 타깃별 최신 1건 — snapshotDate desc 정렬이라 첫 등장이 최신이다.
    const latestByTarget = new Map<string, (typeof snapshots)[number]>();
    for (const snap of snapshots) {
      const key = `${snap.dealId}:${snap.campaignId ?? ""}`;
      if (!latestByTarget.has(key)) latestByTarget.set(key, snap);
    }
    const entries: OverviewEntry[] = [...latestByTarget.values()].map((s) => ({
      dealId: s.dealId,
      campaignId: s.campaignId,
      dealName: s.deal.dealName,
      verdict: s.verdict,
      ourUnitPrice: s.ourUnitPrice,
      minValidPrice: s.minValidPrice,
      snapshotDate: s.snapshotDate,
    }));

    const counts = { ok: 0, tie: 0, violated: 0, review: 0, noData: 0 };
    for (const e of entries) {
      if (e.verdict === "OK") counts.ok++;
      else if (e.verdict === "TIE") counts.tie++;
      else if (e.verdict === "VIOLATED") counts.violated++;
      else if (e.verdict === "REVIEW") counts.review++;
      else counts.noData++;
    }

    // 위반 행에만 캠페인 라벨(셀러 별칭 우선 — P2 Seller Alias Priority)을 붙인다.
    const violatedEntries = entries.filter((e) => e.verdict === "VIOLATED");
    const campaignIds = violatedEntries
      .map((e) => e.campaignId)
      .filter((id): id is string => id !== null);
    const campaigns = campaignIds.length
      ? await prisma.salesCampaign.findMany({
          where: { id: { in: campaignIds } },
          select: {
            id: true,
            roundNumber: true,
            seller: { select: { name: true, alias: true } },
          },
        })
      : [];
    const campaignLabel = new Map(
      campaigns.map((c) => {
        const sellerName = sellerDisplayName(c.seller);
        const round = c.roundNumber && c.roundNumber > 1 ? ` ${c.roundNumber}차` : "";
        return [c.id, `${sellerName}${round}`];
      }),
    );

    const violations = violatedEntries.map((e) => ({
      dealId: e.dealId,
      campaignId: e.campaignId,
      dealName: e.dealName,
      campaignLabel: e.campaignId ? (campaignLabel.get(e.campaignId) ?? null) : null,
      // "1위보다 X원 비쌈" — 두 값이 모두 있을 때만 금액을 만든다(없으면 라벨만).
      gap:
        e.ourUnitPrice !== null && e.minValidPrice !== null
          ? Math.round(e.ourUnitPrice - e.minValidPrice)
          : null,
      snapshotDate: e.snapshotDate,
    }));

    const latestSnapshotDate = entries.reduce<string | null>(
      (max, e) => (max === null || e.snapshotDate > max ? e.snapshotDate : max),
      null,
    );
    const sourceSnapshots = snapshots.map((snapshot) => ({
      snapshotDate: snapshot.snapshotDate,
      evidence: snapshot.evidence,
    }));
    const sourceHealth = buildSourceHealth(
      [...latestByTarget.values()].map((snapshot) => ({
        snapshotDate: snapshot.snapshotDate,
        evidence: snapshot.evidence,
      })),
      sourceSnapshots,
    );

    return NextResponse.json({
      monitoredCount: entries.length,
      latestSnapshotDate,
      counts,
      violations,
      sourceHealth,
    });
  } catch (error) {
    console.error("[api/price-monitoring/overview] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
