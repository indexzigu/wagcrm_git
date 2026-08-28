import { NextRequest, NextResponse } from "next/server";
import { normalizeInstagramProfileMetrics, type InstagramProfileMetrics } from "@/lib/instagram-profile";
import { getPrisma } from "@/lib/prisma";
import { recordSellerMetricsSnapshot } from "@/lib/seller-history";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");
  const platform = searchParams.get("platform") as "instagram" | "youtube" | null;

  if (!runId || !platform) {
    return NextResponse.json({ error: "runId, platform 파라미터가 필요합니다." }, { status: 400 });
  }

  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) {
    return NextResponse.json({ error: "APIFY_API_TOKEN이 설정되지 않았습니다." }, { status: 500 });
  }

  try {
    // 1. Apify 런 상태 확인
    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`,
    );
    if (!statusRes.ok) {
      return NextResponse.json({ error: "Apify 런 상태 조회 실패" }, { status: 502 });
    }
    const statusData = await statusRes.json() as { data: { status: string } };
    const runStatus = statusData.data.status;

    // 아직 실행 중
    if (runStatus === "RUNNING" || runStatus === "READY" || runStatus === "CREATED") {
      return NextResponse.json({ pending: true, runStatus });
    }

    // 실패
    if (runStatus !== "SUCCEEDED") {
      return NextResponse.json(
        { error: `Apify 런 실패: ${runStatus}` },
        { status: 502 },
      );
    }

    // 2. 결과 데이터 조회
    const dataRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apifyToken}&limit=1`,
    );
    if (!dataRes.ok) {
      return NextResponse.json({ error: "Apify 결과 조회 실패" }, { status: 502 });
    }
    const items = await dataRes.json() as unknown[];
    const item = Array.isArray(items) ? items[0] as Record<string, unknown> : null;
    if (!item) {
      return NextResponse.json({ error: "Apify 결과가 비어있습니다." }, { status: 404 });
    }

    // 3. 플랫폼별 데이터 파싱
    let followers: number | undefined;
    let profileMetrics: Omit<InstagramProfileMetrics, "followersCount"> = {};
    let name: string | undefined;
    let newSnsHandle: string | undefined;

    if (platform === "instagram") {
      const normalized = normalizeInstagramProfileMetrics(item);
      followers = normalized.followersCount;
      name = normalized.name || normalized.username || undefined;
      profileMetrics = {
        postsCount: normalized.postsCount,
        profileBio: normalized.profileBio,
        profilePicUrl: normalized.profilePicUrl,
        profileExternalUrls: normalized.profileExternalUrls,
      };
    } else {
      const rawFollowers = item.numberOfSubscribers ?? item.subscribersCount ?? item.subscribers;
      followers = typeof rawFollowers === "number" ? rawFollowers : undefined;
      name = (item.title as string) || (item.channelName as string) || undefined;
      newSnsHandle = (item.channelId as string) || (item.id as string) || undefined;
    }

    if (followers === undefined) {
      return NextResponse.json({ error: "팔로워/구독자 수를 파싱할 수 없습니다." }, { status: 404 });
    }

    // 4. DB 업데이트
    const prisma = getPrisma();
    const seller = await prisma.seller.findUnique({ where: { id } });
    if (!seller) {
      return NextResponse.json({ error: "셀러를 찾을 수 없습니다." }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {
      currentFollowers: followers,
    };
    if (name) updateData.name = name;
    if (newSnsHandle && newSnsHandle !== seller.snsHandle) {
      updateData.snsHandle = newSnsHandle;
    }

    await prisma.seller.update({ where: { id }, data: updateData });
    // 프로필 이미지는 recordSellerMetricsSnapshot 내부에서 Blob 미러링됨
    const snapshot = await recordSellerMetricsSnapshot(id, followers, "APIFY_API", profileMetrics);

    return NextResponse.json({
      pending: false,
      name: (updateData.name as string) ?? seller.name,
      currentFollowers: followers,
      currentPostsCount: profileMetrics.postsCount ?? seller.currentPostsCount ?? null,
      profileBio: profileMetrics.profileBio ?? seller.profileBio ?? null,
      profilePicUrl: snapshot.profilePicUrl ?? seller.profilePicUrl ?? null,
      profileExternalUrls: profileMetrics.profileExternalUrls ?? [],
      snsHandle: (updateData.snsHandle as string) ?? seller.snsHandle,
      snsType: seller.snsType,
      createdAt: seller.createdAt,
      collectMode: "apify",
      lastScrapedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[channel-info/poll] 오류:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "폴링 오류" },
      { status: 500 },
    );
  }
}
