import { NextResponse } from "next/server";
import { after } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { getKstMidnightUTC } from "@/lib/seller-history";
import { isMirroredProfileImage, mirrorSellerProfileImage } from "@/lib/seller-profile-image";
import { isSellerMediaStorageConfigured } from "@/lib/seller-analysis/seller-media-storage";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;

  const seller = await getPrisma().seller.findUnique({ where: { id } });
  if (!seller) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }

  // 프로필 이미지 자가 치유 — 상세를 여는 시점에 아직 외부 CDN(서명 URL)을 가리키는 레코드를
  // 자체 버킷으로 미러링해 영구 URL로 교체한다. 수집 경로(recordSellerMetricsSnapshot)는 이미
  // 미러링하지만, 미러링 도입 전 레코드·재수집이 뜸한 셀러는 서명 URL이 만료돼 이미지가 깨진다
  // (오너 지적 2026-07-16). 멱등(이미 미러면 no-op)·응답 지연 없음(after)·소스가 이미 만료됐으면
  // 원본을 유지하므로 실패해도 잃는 것이 없다. 캐시 무효화는 하지 않는다 — 조회마다 ISR write를
  // 태우지 않기 위함(Hobby 사용량 실사고 축). 다음 자연 갱신 때 화면에 반영된다.
  if (
    seller.profilePicUrl &&
    !isMirroredProfileImage(seller.profilePicUrl) &&
    isSellerMediaStorageConfigured()
  ) {
    const sourceUrl = seller.profilePicUrl;
    after(async () => {
      try {
        const mirrored = await mirrorSellerProfileImage(id, sourceUrl);
        if (typeof mirrored === "string" && isMirroredProfileImage(mirrored)) {
          await getPrisma().seller.update({
            where: { id },
            data: { profilePicUrl: mirrored },
          });
        }
      } catch (e) {
        // mirrorSellerProfileImage는 실패를 삼키지 않고 로그 후 원본을 반환한다 — 이 catch는
        // seller.update 등 잔여 실패 대비 벨트앤서스펜더. 조회 응답과 무관하므로 로그만 남긴다.
        console.warn("[seller-history] 프로필 이미지 치유 실패:", e instanceof Error ? e.message : e);
      }
    });
  }

  const snapshots = await getPrisma().sellersHistory.findMany({
    where: { sellerId: id },
    orderBy: { snapshotDate: "asc" },
    select: {
      id: true,
      snapshotDate: true,
      followersCount: true,
      postsCount: true,
      profileBio: true,
      profilePicUrl: true,
      profileExternalUrls: true,
      source: true,
      er: true,
      avgLikes: true,
      avgComments: true,
    },
  });

  const bioHistories = await getPrisma().sellerProfileBioHistory.findMany({
    where: { sellerId: id },
    orderBy: { collectedAt: "desc" },
    select: {
      id: true,
      collectedAt: true,
      previousBio: true,
      bio: true,
      source: true,
    },
  });

  return NextResponse.json({ snapshots, bioHistories });
}

export async function POST(request: Request, context: Context) {
  const { id: sellerId } = await context.params;

  const seller = await getPrisma().seller.findUnique({ where: { id: sellerId } });
  if (!seller) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }

  try {
    const body = await request.json();
    const { snapshotDate, followersCount, postsCount } = body;

    if (!snapshotDate || followersCount === undefined) {
      return NextResponse.json({ error: "날짜와 팔로워 수는 필수입니다" }, { status: 400 });
    }

    const count = parseInt(followersCount, 10);
    if (isNaN(count) || count < 0) {
      return NextResponse.json({ error: "올바른 팔로워 수를 입력해주세요" }, { status: 400 });
    }
    const parsedPostsCount =
      postsCount === undefined || postsCount === null || postsCount === ""
        ? undefined
        : parseInt(postsCount, 10);
    if (parsedPostsCount !== undefined && (isNaN(parsedPostsCount) || parsedPostsCount < 0)) {
      return NextResponse.json({ error: "올바른 게시물 수를 입력해주세요" }, { status: 400 });
    }

    const parsedDate = new Date(snapshotDate);
    if (isNaN(parsedDate.getTime())) {
      return NextResponse.json({ error: "올바른 날짜 형식이 아닙니다" }, { status: 400 });
    }

    const normalizedDate = getKstMidnightUTC(parsedDate);
    const prisma = getPrisma();

    // 1. 히스토리 기록 추가 (Upsert)
    const history = await prisma.sellersHistory.upsert({
      where: {
        sellerId_snapshotDate: {
          sellerId,
          snapshotDate: normalizedDate,
        },
      },
      update: {
        followersCount: count,
        ...(parsedPostsCount !== undefined ? { postsCount: parsedPostsCount } : {}),
        source: "MANUAL",
      },
      create: {
        sellerId,
        snapshotDate: normalizedDate,
        followersCount: count,
        ...(parsedPostsCount !== undefined ? { postsCount: parsedPostsCount } : {}),
        source: "MANUAL",
      },
    });

    // 2. 셀러의 currentFollowers를 가장 최신 스냅샷 데이터로 동기화
    const latestSnapshot = await prisma.sellersHistory.findFirst({
      where: { sellerId },
      orderBy: { snapshotDate: "desc" },
    });

    if (latestSnapshot) {
      await prisma.seller.update({
        where: { id: sellerId },
        data: {
          currentFollowers: latestSnapshot.followersCount,
          ...(latestSnapshot.postsCount !== null ? { currentPostsCount: latestSnapshot.postsCount } : {}),
        },
      });
    }

    return NextResponse.json({
      history,
      latestFollowers: latestSnapshot?.followersCount ?? count,
      latestPostsCount: latestSnapshot?.postsCount ?? parsedPostsCount ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "서버 오류가 발생했습니다";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: Context) {
  const { id: sellerId } = await context.params;
  const { searchParams } = new URL(request.url);
  const historyId = searchParams.get("historyId");

  if (!historyId) {
    return NextResponse.json({ error: "삭제할 이력 ID가 필요합니다" }, { status: 400 });
  }

  const prisma = getPrisma();
  const history = await prisma.sellersHistory.findFirst({
    where: { id: historyId, sellerId },
  });

  if (!history) {
    return NextResponse.json({ error: "해당 이력 데이터를 찾을 수 없습니다" }, { status: 404 });
  }

  try {
    // 1. 이력 데이터 삭제
    await prisma.sellersHistory.delete({
      where: { id: historyId },
    });

    // 2. 삭제 후 남은 이력 중 최신 데이터로 셀러 currentFollowers 동기화
    const latestSnapshot = await prisma.sellersHistory.findFirst({
      where: { sellerId },
      orderBy: { snapshotDate: "desc" },
    });

    const nextFollowers = latestSnapshot ? latestSnapshot.followersCount : 0;
    const nextPostsCount = latestSnapshot?.postsCount ?? null;
    await prisma.seller.update({
      where: { id: sellerId },
      data: { currentFollowers: nextFollowers, currentPostsCount: nextPostsCount },
    });

    return NextResponse.json({ success: true, latestFollowers: nextFollowers, latestPostsCount: nextPostsCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "서버 오류가 발생했습니다";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
