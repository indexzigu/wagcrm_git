import { getPrisma } from "@/lib/prisma";
import { encodeExternalUrls, type InstagramProfileMetrics } from "@/lib/instagram-profile";
import { isRemoteDatabaseUrl } from "@/lib/prisma-client";
import { mirrorSellerProfileImage } from "@/lib/seller-profile-image";

/**
 * mock 적립의 **최종 차단선**(쓰기 지점). 호출부 게이트
 * (`mockCollectBlockedReason`)가 앞에서 막지만, 그 게이트를 거치지 않는 새 writer
 * 가 생기면 다시 프로덕션에 난수가 쌓인다 — 그래서 판정 근거를 "모드 문자열"이 아니라
 * **실제로 저장되려는 출처 라벨**에 둔다(라벨은 실행 경로의 사실이다, P7).
 *
 * 접두사 매칭인 이유: **현행 mock 라벨은 `MOCK` 하나로 통일됐지만**(유튜브 수집기의
 * `MOCK_API` 는 은퇴 — 프로덕션에 그 라벨 행이 0건이라 소급 의미 문제 없이 정리됐다),
 * 접두사는 그대로 둔다. 라벨을 새로 만드는 경로가 생겼을 때 `MOCK_*` 변형이 이 차단선을
 * 우회하지 못하게 하는 것이 목적이고, 정상 라벨 중 `MOCK` 으로 시작하는 것은 없다.
 */
export function assertSnapshotSourceAllowed(source: string): void {
  if (!source.toUpperCase().startsWith("MOCK")) return;
  if (!isRemoteDatabaseUrl()) return;
  throw new Error(
    `mock 출처(${source}) 스냅샷은 원격 DB 에 적립할 수 없습니다. DATABASE_URL 이 sqlite 가 아닙니다(로컬 예행은 npm run dev:local).`,
  );
}

export function getKstMidnightUTC(date: Date = new Date()): Date {
  const kstOffset = 9 * 60 * 60 * 1000; // 9 hours
  const kstTime = new Date(date.getTime() + kstOffset);
  
  return new Date(
    Date.UTC(
      kstTime.getUTCFullYear(),
      kstTime.getUTCMonth(),
      kstTime.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
}

// ER 추이 적립용 파생 스칼라 (§11-3). 값이 없으면 필드 자체를 생략(undefined)해
// 같은 날 앞선 적립분을 upsert update가 null로 덮지 않도록 한다.
export type SellerEngagementSnapshot = {
  er?: number | null;
  avgLikes?: number | null;
  avgComments?: number | null;
};

/** null/NaN/Infinity → undefined (Prisma가 해당 컬럼을 건드리지 않음) */
function finiteOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && isFinite(value) ? value : undefined;
}

export async function recordSellerMetricsSnapshot(
  sellerId: string,
  followersCount: number,
  source: string = "INTERNAL",
  metrics: Omit<InstagramProfileMetrics, "followersCount"> = {},
  engagement?: SellerEngagementSnapshot
): Promise<{ profilePicUrl: string | null | undefined }> {
  // 어떤 외부 호출·쓰기보다 먼저 판정한다(미러링도 하지 않는다).
  assertSnapshotSourceAllowed(source);

  const prisma = getPrisma();

  // 외부 CDN의 만료성 프로필 이미지 URL을 Vercel Blob에 미러링해 안정적인 자체 URL로 치환.
  // undefined("건드리지 마라")는 그대로 통과하므로 팔로워-only 갱신 경로에는 영향이 없다.
  const profilePicUrl = await mirrorSellerProfileImage(sellerId, metrics.profilePicUrl);

  const snapshotDate = getKstMidnightUTC();
  const hasExternalUrls = metrics.profileExternalUrls !== undefined;
  const profileExternalUrls = encodeExternalUrls(metrics.profileExternalUrls);
  const historyData = {
    followersCount,
    source,
    postsCount: metrics.postsCount,
    profileBio: metrics.profileBio,
    profilePicUrl,
    profileExternalUrls: hasExternalUrls ? profileExternalUrls : undefined,
    // 팔로워-only 경로(engagement 미전달)는 전부 undefined → 기존 ER 보존
    er: finiteOrUndefined(engagement?.er),
    avgLikes: finiteOrUndefined(engagement?.avgLikes),
    avgComments: finiteOrUndefined(engagement?.avgComments),
  };

  await prisma.sellersHistory.upsert({
    where: {
      sellerId_snapshotDate: {
        sellerId,
        snapshotDate,
      },
    },
    update: historyData,
    create: {
      sellerId,
      snapshotDate,
      ...historyData,
    },
  });

  if (typeof prisma.seller.findUnique !== "function") return { profilePicUrl };

  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { profileBio: true },
  });
  if (!seller) return { profilePicUrl };

  const nextBio = metrics.profileBio?.trim();
  const currentBio = seller.profileBio?.trim() || null;
  if (nextBio && nextBio !== currentBio) {
    await prisma.sellerProfileBioHistory.create({
      data: {
        sellerId,
        previousBio: currentBio,
        bio: nextBio,
        source,
      },
    });
  }

  const sellerData: Record<string, unknown> = { currentFollowers: followersCount };
  if (metrics.postsCount !== undefined) sellerData.currentPostsCount = metrics.postsCount;
  if (metrics.profileBio !== undefined) sellerData.profileBio = metrics.profileBio;
  if (profilePicUrl !== undefined) sellerData.profilePicUrl = profilePicUrl;
  if (hasExternalUrls) sellerData.profileExternalUrls = profileExternalUrls;
  if (metrics.name !== undefined && metrics.name.trim() !== "") sellerData.name = metrics.name.trim();

  await prisma.seller.update({
    where: { id: sellerId },
    data: sellerData,
  });

  return { profilePicUrl };
}

export async function recordSellerFollowersSnapshot(
  sellerId: string,
  followersCount: number,
  source: string = "INTERNAL",
  engagement?: SellerEngagementSnapshot
): Promise<void> {
  await recordSellerMetricsSnapshot(sellerId, followersCount, source, {}, engagement);
}
