import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { getCollectCutoff, getCollectIntervalDays } from "@/lib/collect-cycle";
import { isRehostedUrl } from "@/lib/seller-analysis/seller-media-storage";

// (타입은 라우트 밖으로 export하지 않는다 — Next 16 라우트 export 제약. 카드 쪽은 자체 타입 사용.)
interface CollectHealth {
  monitored: number;
  /** 수집 주기(기본 7일) 안에 스냅샷이 있는 감시셀러 수 — 정상이면 monitored와 같아진다. */
  snapshotsFresh: number;
  /** 위 창의 길이(일). 카드 문구가 이 값을 그대로 쓴다(하드코딩된 "7일" 금지). */
  intervalDays: number;
  mirrored: number;
}

// IG 수집의 결과 건강도 — 감시셀러 대비 "주기 안에 갱신된" 셀러 수와 프로필 미러링 수.
// 레이더의 상태 점(돌았나)과 별개로 "돌고 나서 결과물이 쌓였나"를 보인다.
//
// ⚠️ 창(window)은 수집기와 **같은 cutoff**여야 한다(SSOT=collect-cycle). 예전에는 이 값이
// "이번 주 월요일부터"(달력 주)였는데, 크론이 월요일 배치라 그 서술이 맞았다. 크론을 매일로
// 바꾼 뒤(2026-07-30)에는 셀러마다 갱신일이 흩어지므로 달력 주로 세면 월요일 아침마다 0/N,
// 주 중반에도 만성 미달로 보인다 — 실제로는 정상인데 거짓 경보가 된다.
async function getCollectHealth(): Promise<CollectHealth | null> {
  try {
    const prisma = getPrisma();
    const monitored = await prisma.seller.findMany({
      where: { isMonitored: true, snsType: "INSTAGRAM" },
      select: { id: true, profilePicUrl: true },
    });
    const intervalDays = getCollectIntervalDays();
    if (monitored.length === 0) {
      return { monitored: 0, snapshotsFresh: 0, intervalDays, mirrored: 0 };
    }
    const snapped = await prisma.sellersHistory.groupBy({
      by: ["sellerId"],
      where: {
        sellerId: { in: monitored.map((s) => s.id) },
        // 수집기의 재수집 게이트와 같은 부등호(> cutoff = 아직 신선함)를 쓴다.
        snapshotDate: { gt: getCollectCutoff() },
      },
    });
    const mirrored = monitored.filter((s) => isRehostedUrl(s.profilePicUrl)).length;
    return { monitored: monitored.length, snapshotsFresh: snapped.length, intervalDays, mirrored };
  } catch (error) {
    // 건강도 계산 실패가 레이더 본체(상태 점)를 죽이면 안 된다 — 로그로 표면화하고 null 반환.
    console.error("[SystemRadarAPI] collectHealth 계산 실패:", error);
    return null;
  }
}

export async function GET() {
  try {
    const prisma = getPrisma();
    const [statuses, collectHealth] = await Promise.all([
      prisma.systemTaskStatus.findMany({
        orderBy: {
          updatedAt: "desc",
        },
      }),
      getCollectHealth(),
    ]);

    return NextResponse.json({
      success: true,
      data: statuses,
      collectHealth,
    });
  } catch (error) {
    console.error("[SystemRadarAPI] Error fetching statuses:", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
