import { NextRequest, NextResponse } from "next/server";
import { parseChannelUrl } from "@/lib/channel-url";
import { decodeExternalUrls, normalizeInstagramProfileMetrics, type InstagramProfileMetrics } from "@/lib/instagram-profile";
import { getPrisma } from "@/lib/prisma";
import { applyDbInstagramToken } from "@/lib/instagram-token";
import { assertSnapshotSourceAllowed, recordSellerMetricsSnapshot } from "@/lib/seller-history";
import { collectModeUnsetReason, mockCollectBlockedReason, resolveCollectMode } from "@/lib/collect-mode";
import { classifyGraphBdFailure, recordGraphBdFailure, type GraphBdFailure } from "@/lib/instagram-graph-error";

// Vercel Hobby 플랜: 최대 10초. Apify는 비동기 모드 사용.

type Context = {
  params: Promise<{ id: string }>;
};

type ChannelInfoResponse = {
  snsType?: "INSTAGRAM" | "YOUTUBE" | "X";
  snsHandle?: string;
  name?: string;
  currentFollowers?: number;
  currentPostsCount?: number | null;
  profileBio?: string | null;
  profilePicUrl?: string | null;
  profileExternalUrls?: string[];
  collectMode?: string;
};

// 8초 타임아웃 (Vercel Hobby 10초 제한 내에서 안전하게)
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Apify 비동기 실행 시작 → runId 즉시 반환 (10초 제한 우회)
async function startApifyRunAsync(
  actorId: string,
  token: string,
  input: Record<string, unknown>,
): Promise<string> {
  const url = `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Apify 실행 시작 실패: ${res.status} - ${errText}`);
  }
  const data = await res.json() as { data: { id: string } };
  return data.data.id;
}

/**
 * 인스타 프로필 Apify 액터 비동기 실행 — `apify` 모드와 `api` 모드의 폴백이 **같은 함수**를 부른다.
 * 두 진입점이 각자 액터 ID·입력을 들고 있으면 폴백만 조용히 다른 것을 긁게 된다.
 */
async function startInstagramProfileRun(snsHandle: string, apifyToken: string): Promise<string> {
  return startApifyRunAsync("apify~instagram-profile-scraper", apifyToken, { usernames: [snsHandle] });
}

/** BD 실패 종류별 사용자 문구. 폴백하지 않은 이유를 오너가 바로 알 수 있게 처방까지 적는다. */
function graphFailureMessage(failure: GraphBdFailure): string {
  switch (failure.kind) {
    case "auth":
      return `Instagram Graph API 인증·권한 오류: ${failure.message}. 토큰을 갱신한 뒤 다시 시도하세요. 모든 셀러에 공통으로 영향을 주는 문제라 유료(Apify) 폴백은 하지 않았습니다.`;
    case "rate_limit":
      return `Instagram Graph API 호출 한도 초과: ${failure.message}. 한도가 회복되면 무료로 풀립니다. 유료(Apify) 폴백은 하지 않았습니다.`;
    case "transient":
      return `Instagram Graph API 일시 오류: ${failure.message}. 잠시 후 다시 시도하세요. 유료(Apify) 폴백은 하지 않았습니다.`;
    case "account":
      return `Instagram Graph API 조회 실패: ${failure.message}`;
  }
}

export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;

  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const force = searchParams.get("force") === "true";

  let seller;
  try {
    const prisma = getPrisma();

    // 1. 셀러 및 마지막 스크랩 히스토리 조회
    seller = await prisma.seller.findUnique({
      where: { id },
      include: {
        histories: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
  } catch (dbError) {
    console.error("[channel-info] DB 조회 오류:", dbError);
    return NextResponse.json(
      { error: "데이터베이스 연결 오류가 발생했습니다.", detail: dbError instanceof Error ? dbError.message : String(dbError) },
      { status: 500 },
    );
  }

  if (!seller) {
    return NextResponse.json(
      { error: "해당 셀러를 찾을 수 없습니다." },
      { status: 404 },
    );
  }

  const targetUrl = url || seller.channelUrl;

  if (!targetUrl) {
    return NextResponse.json(
      { error: "url 파라미터가 필요하며 셀러의 채널 URL 정보도 없습니다." },
      { status: 400 },
    );
  }

  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    return NextResponse.json(
      { error: "유효한 URL 형식이 아닙니다." },
      { status: 400 },
    );
  }

  const channelInfo = parseChannelUrl(targetUrl);

  if (!channelInfo) {
    return NextResponse.json(
      { error: "지원하지 않는 채널 URL 형식입니다." },
      { status: 400 },
    );
  }

  const { snsType, snsHandle } = channelInfo;
  const response: ChannelInfoResponse = { snsType, snsHandle };
  let profileMetrics: Omit<InstagramProfileMetrics, "followersCount"> = {};
  let snapshotSource = "INTERNAL";

  // 7일 제한 검증
  const lastHistory = seller.histories[0];
  const now = new Date();
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const lastScrapedAt = lastHistory ? lastHistory.createdAt : null;
  const isWithinOneWeek = lastScrapedAt && (now.getTime() - lastScrapedAt.getTime() < ONE_WEEK_MS);

  if (isWithinOneWeek && !force) {
    // 1주일이 지나지 않았고 force 파라미터가 없으면 패스하고 기존 정보를 반환
    return NextResponse.json({
      snsType: seller.snsType,
      snsHandle: seller.snsHandle,
      name: seller.name,
      currentFollowers: seller.currentFollowers,
      currentPostsCount: seller.currentPostsCount ?? null,
      profileBio: seller.profileBio ?? null,
      profilePicUrl: seller.profilePicUrl ?? null,
      profileExternalUrls: decodeExternalUrls(seller.profileExternalUrls),
      skipped: true,
      lastScrapedAt: lastScrapedAt.toISOString(),
    });
  }

  try {
    if (snsType === "INSTAGRAM") {
      const mode = resolveCollectMode("INSTAGRAM");
      if (!mode) {
        return NextResponse.json({ error: collectModeUnsetReason("INSTAGRAM") }, { status: 500 });
      }
      // mock 은 난수 팔로워를 그대로 스냅샷에 적립한다 — 원격 DB(프로덕션)면 거부한다.
      const mockBlocked = mockCollectBlockedReason("INSTAGRAM", mode);
      if (mockBlocked) {
        return NextResponse.json({ error: mockBlocked }, { status: 500 });
      }
      response.collectMode = mode;
      if (mode === "mock") {
        // mock 모드: 이름은 기존 DB 값을 유지하고 팔로워 수만 임의 생성
        response.currentFollowers = Math.floor(Math.random() * 45000) + 5000;
        response.currentPostsCount = seller.currentPostsCount ?? Math.floor(Math.random() * 1200) + 50;
        profileMetrics.postsCount = response.currentPostsCount;
        snapshotSource = "MOCK";
      } else if (mode === "apify") {
        const apifyToken = process.env.APIFY_API_TOKEN;
        if (!apifyToken) {
          return NextResponse.json({ error: "APIFY_API_TOKEN 환경 변수가 누락되었습니다." }, { status: 500 });
        }
        // 비동기 실행: runId를 즉시 반환하고 클라이언트가 폴링
        const runId = await startInstagramProfileRun(snsHandle, apifyToken);
        return NextResponse.json({ pending: true, runId, sellerId: id, platform: "instagram", collectMode: mode });
      } else if (mode === "api") {
        // F5: DB에 갱신된 토큰이 있으면 env보다 우선 적용
        await applyDbInstagramToken();
        const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
        const igBusinessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
        if (!accessToken || !igBusinessAccountId) {
          return NextResponse.json({ error: "Instagram API 설정(토큰/계정ID)이 누락되었습니다." }, { status: 500 });
        }

        const graphUrl = `https://graph.facebook.com/v19.0/${igBusinessAccountId}?fields=business_discovery.fields(followers_count,media_count,name,username,biography,profile_picture_url,website)&business_discovery.username=${snsHandle}&access_token=${accessToken}`;
        const res = await fetchWithTimeout(graphUrl);
        const body = await res.json().catch(() => null);
        const normalized: InstagramProfileMetrics = res.ok ? normalizeInstagramProfileMetrics(body) : {};
        const followers = normalized.followersCount;

        // Graph BD 실패 → 성질에 따라 Apify 폴백 여부가 갈린다(판정 SSOT = instagram-graph-error).
        // ⚠️ HTTP 상태만 보면 안 된다: 토큰 만료도 개인계정도 대부분 400 으로 온다.
        // 200 인데 팔로워가 없는 경우(BD 가 페이로드를 안 실은 경우)도 여기로 들어온다.
        if (!res.ok || typeof followers !== "number") {
          const failure = classifyGraphBdFailure({ httpStatus: res.status, body });
          const apifyToken = process.env.APIFY_API_TOKEN;

          let runId: string | null = null;
          let fallbackError: string | null = null;
          if (failure.shouldFallback) {
            if (!apifyToken) {
              fallbackError = "APIFY_API_TOKEN 환경 변수가 누락되어 폴백할 수 없습니다.";
            } else {
              try {
                runId = await startInstagramProfileRun(snsHandle, apifyToken);
              } catch (err) {
                fallbackError = err instanceof Error ? err.message : String(err);
              }
            }
          }

          // 폴백했든 안 했든 1행 남긴다 — 조용히 유료 경로로 넘어가면 안 된다(P0).
          await recordGraphBdFailure({
            sellerId: id,
            handle: snsHandle,
            httpStatus: res.status,
            failure,
            fellBack: runId !== null,
            apifyRunId: runId,
            fallbackError,
          });

          if (runId) {
            // 응답 형태가 동기 → 비동기(pending)로 바뀐다. 프론트는 `pending && runId` 로 분기하므로
            // 그대로 폴링을 타고, `fallbackFrom` 은 "무료가 안 돼서 유료로 갔다"를 화면에 알리는 용도다.
            return NextResponse.json({
              pending: true,
              runId,
              sellerId: id,
              platform: "instagram",
              collectMode: "apify",
              fallbackFrom: "api",
              fallbackReason: failure.message,
            });
          }

          const detail = fallbackError ? ` (Apify 폴백도 실패: ${fallbackError})` : "";
          return NextResponse.json(
            { error: `${graphFailureMessage(failure)}${detail}`, graphFailureKind: failure.kind },
            { status: res.ok ? 404 : res.status },
          );
        }

        response.name = normalized.name || normalized.username || snsHandle;
        response.currentFollowers = followers;
        response.currentPostsCount = normalized.postsCount ?? null;
        response.profileBio = normalized.profileBio ?? null;
        response.profilePicUrl = normalized.profilePicUrl ?? null;
        response.profileExternalUrls = normalized.profileExternalUrls ?? [];
        profileMetrics = {
          postsCount: normalized.postsCount,
          profileBio: normalized.profileBio,
          profilePicUrl: normalized.profilePicUrl,
          profileExternalUrls: normalized.profileExternalUrls,
        };
        snapshotSource = "INSTAGRAM_API";
      }
    } else if (snsType === "YOUTUBE") {
      const mode = resolveCollectMode("YOUTUBE");
      if (!mode) {
        return NextResponse.json({ error: collectModeUnsetReason("YOUTUBE") }, { status: 500 });
      }
      const mockBlocked = mockCollectBlockedReason("YOUTUBE", mode);
      if (mockBlocked) {
        return NextResponse.json({ error: mockBlocked }, { status: 500 });
      }
      response.collectMode = mode;
      if (mode === "mock") {
        // mock 모드: 이름은 기존 DB 값을 유지하고 구독자 수만 임의 생성
        response.currentFollowers = Math.floor(Math.random() * 190000) + 10000;
        snapshotSource = "MOCK";
      } else if (mode === "apify") {
        const apifyToken = process.env.APIFY_API_TOKEN;
        if (!apifyToken) {
          return NextResponse.json({ error: "APIFY_API_TOKEN 환경 변수가 누락되었습니다." }, { status: 500 });
        }
        const channelUrl = snsHandle.startsWith("UC")
          ? `https://www.youtube.com/channel/${snsHandle}`
          : `https://www.youtube.com/@${snsHandle}`;
        // 비동기 실행: runId를 즉시 반환하고 클라이언트가 폴링
        const runId = await startApifyRunAsync("apify~youtube-scraper", apifyToken, {
          startUrls: [{ url: channelUrl }],
          maxResults: 1,
          downloadSubtitles: false,
          downloadComments: false,
        });
        return NextResponse.json({ pending: true, runId, sellerId: id, platform: "youtube", collectMode: mode });
      } else if (mode === "api") {
        const apiKey = process.env.YOUTUBE_API_KEY;
        if (!apiKey) {
          return NextResponse.json({ error: "YOUTUBE_API_KEY 환경 변수가 누락되었습니다." }, { status: 500 });
        }

        let ytUrl = "";
        if (snsHandle.startsWith("UC")) {
          ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${snsHandle}&key=${apiKey}`;
        } else {
          ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=@${snsHandle}&key=${apiKey}`;
        }

        const res = await fetchWithTimeout(ytUrl);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData?.error?.message || `HTTP ${res.status}`;
          return NextResponse.json({ error: `YouTube API 오류: ${errMsg}` }, { status: res.status });
        }

        const data = await res.json();
        const item = data.items?.[0];
        if (!item) {
          return NextResponse.json({ error: "유튜브 채널 정보를 찾을 수 없습니다." }, { status: 404 });
        }

        const followers = parseInt(item.statistics?.subscriberCount ?? "0", 10);
        response.name = item.snippet?.title || snsHandle;
        response.currentFollowers = followers;
        response.snsHandle = item.id; // 고유 채널 ID로 갱신하여 반환
        snapshotSource = "YOUTUBE_API";
      }
    } else if (snsType === "X") {
      const mode = resolveCollectMode("X");
      if (!mode) {
        return NextResponse.json({ error: collectModeUnsetReason("X") }, { status: 500 });
      }
      const mockBlocked = mockCollectBlockedReason("X", mode);
      if (mockBlocked) {
        return NextResponse.json({ error: mockBlocked }, { status: 500 });
      }
      response.collectMode = mode;
      const cleanHandle = snsHandle.replace(/^@/, "");
      if (mode === "mock") {
        response.name = cleanHandle;
        response.currentFollowers = Math.floor(Math.random() * 20000) + 1000;
        snapshotSource = "MOCK";
      } else if (mode === "api") {
        const apiKey = process.env.RAPIDAPI_KEY;
        if (!apiKey) {
          return NextResponse.json({ error: "RAPIDAPI_KEY 환경 변수가 누락되었습니다." }, { status: 500 });
        }
        const host = "twitter-api45.p.rapidapi.com";
        const targetUrl = `https://${host}/screenname.php?screenname=${encodeURIComponent(cleanHandle)}`;

        const res = await fetchWithTimeout(targetUrl, {
          headers: {
            "x-rapidapi-key": apiKey,
            "x-rapidapi-host": host,
            "Content-Type": "application/json",
          },
          cache: "no-store",
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData?.error || errData?.message || `HTTP ${res.status}`;
          return NextResponse.json({ error: `X API 오류: ${errMsg}` }, { status: res.status });
        }

        const data = await res.json();
        // ⚠️ 이 API 는 없는 핸들에도 HTTP 200 을 주고 본문에 status:"notfound" + 전 필드 null 을
        // 담는다. res.ok 만 믿으면 name=null·팔로워 0 이 그대로 DB 에 기록된다(조용한 오염).
        if (data?.status !== "active" || data?.sub_count == null) {
          return NextResponse.json({ error: "X 프로필 정보를 찾을 수 없습니다." }, { status: 404 });
        }

        response.name = data.name || cleanHandle;
        response.currentFollowers = data.sub_count ?? 0;
        snapshotSource = "X_API";
      }
    }

    // 이 라우트는 스냅샷 헬퍼보다 **먼저** Seller 를 갱신하므로, 헬퍼 안의 차단선만으로는
    // "게이트를 우회하면 Seller 만 오염"이 남는다 — 첫 쓰기 앞에서 한 번 더 판정한다.
    assertSnapshotSourceAllowed(snapshotSource);

    // DB 업데이트 진행
    const updatedName = response.name || seller.name;
    const updatedFollowers = response.currentFollowers ?? seller.currentFollowers;
    // snsHandle이 실제로 변경된 경우에만 업데이트에 포함
    // PostgreSQL은 UPDATE 시에도 unique constraint(snsType, snsHandle)를 검사하므로
    // 변경 없이 동일 값으로 update해도 P2002가 발생할 수 있음
    const newSnsHandle = response.snsHandle;
    const updateData: Record<string, unknown> = {
      name: updatedName,
      currentFollowers: updatedFollowers,
    };
    if (newSnsHandle && newSnsHandle !== seller.snsHandle) {
      updateData.snsHandle = newSnsHandle;
    }

    const prisma = getPrisma();
    await prisma.seller.update({
      where: { id },
      data: updateData,
    });

    // SellersHistory에 프로필 수집 스냅샷 저장 (프로필 이미지는 내부에서 Blob 미러링됨)
    const snapshot = await recordSellerMetricsSnapshot(
      id,
      updatedFollowers,
      snapshotSource,
      profileMetrics,
    );

    return NextResponse.json({
      ...response,
      name: updatedName,
      currentPostsCount: response.currentPostsCount ?? seller.currentPostsCount ?? null,
      profileBio: response.profileBio ?? seller.profileBio ?? null,
      profilePicUrl: snapshot.profilePicUrl ?? seller.profilePicUrl ?? null,
      profileExternalUrls: response.profileExternalUrls ?? [],
      createdAt: seller.createdAt,
      skipped: false,
      lastScrapedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[channel-info] 채널 정보 수집 오류:", error);
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        { error: "채널 정보 조회 시간이 초과되었습니다." },
        { status: 504 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 시스템 오류가 발생했습니다.", detail: String(error) },
      { status: 500 },
    );
  }
}
