import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

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
        const sellerName =
          c.seller.alias && c.seller.alias.trim() !== "" ? c.seller.alias : c.seller.name;
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

    return NextResponse.json({
      monitoredCount: entries.length,
      latestSnapshotDate,
      counts,
      violations,
    });
  } catch (error) {
    console.error("[api/price-monitoring/overview] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
