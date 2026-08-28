import { getPrisma } from "@/lib/prisma";
import { getCollectCutoff } from "@/lib/collect-cycle";
import { collectModeUnsetReason, mockCollectBlockedReason, resolveCollectMode } from "@/lib/collect-mode";
import { normalizeInstagramProfileMetrics, type InstagramProfileMetrics } from "@/lib/instagram-profile";
import { recordSellerMetricsSnapshot, getKstMidnightUTC } from "@/lib/seller-history";
import { proxyFetch } from "@/lib/order-converter/fetch-client";

export type InstagramCollectorConfig = {
  appId: string;
  appSecret: string;
  accessToken: string;
  igBusinessAccountId: string;
  baseUrl?: string;
};

export type CollectionResult = {
  successCount: number;
  failedCount: number;
  errors: Array<{ sellerId: string; snsHandle: string; error: string }>;
};

/**
 * 스냅샷 출처 라벨(`SellersHistory.source`) = **실제로 성공한 실행 경로**의 이름이다.
 * 모드 문자열(`INSTAGRAM_COLLECT_MODE`)을 그대로 베끼지 않는다.
 *
 * 왜: Vercel의 sensitive env 는 `vercel env pull` 시 빈값으로 내려와 모드의 실제
 * 값을 사후에 읽을 수 없다 — 이 라벨이 "어느 경로가 이 데이터를 썼는가"를 복원하는
 * 유일한 관측 창구다. 예전 구현은 모드를 그대로 라벨로 옮겼는데, Apify 실행 코드가
 * 이 파일에서 제거된 뒤에도 `mode=apify` 이면 `APIFY_API` 를 찍어 **부르지도 않은
 * 벤더가 출처로 기록**됐다(2026-07-24 조사). 라벨은 의도가 아니라 사실이어야 한다.
 *
 * 비-mock 경로는 2단 폴백이며 **두 갈래의 라벨이 서로 다르다**:
 *  - 공개 웹 프로필 스크래퍼 성공 → `INSTAGRAM_SCRAPER`
 *  - 스크래퍼 실패 후 Meta Graph `business_discovery` 성공 → `INSTAGRAM_API`
 *
 * ⚠️ 과거 행의 `APIFY_API` 의미는 그대로 둔다 — 수동 채널정보 경로
 * (`/api/sellers/[id]/channel-info/**`)는 지금도 진짜 Apify 를 쓰고 같은 라벨을
 * 쓴다. 여기서 그 라벨을 더 이상 쓰지 않을 뿐이다(소급 수정 없음).
 */
export const INSTAGRAM_SNAPSHOT_SOURCE = {
  /** mock 모드 — 난수 생성값(외부 호출 없음) */
  MOCK: "MOCK",
  /** 공개 웹 프로필 스크래퍼(`/api/v1/users/web_profile_info/`) */
  SCRAPER: "INSTAGRAM_SCRAPER",
  /** Meta Graph API `business_discovery` 폴백 */
  GRAPH: "INSTAGRAM_API",
} as const;

export type InstagramSnapshotSource =
  (typeof INSTAGRAM_SNAPSHOT_SOURCE)[keyof typeof INSTAGRAM_SNAPSHOT_SOURCE];

async function logApiCall(
  provider: string,
  endpoint: string,
  statusCode: number,
  success: boolean,
  errorMessage: string | null = null,
  permissionScope: string | null = null,
  metadata: string | null = null
) {
  try {
    const prisma = getPrisma();
    await prisma.apiCallLog.create({
      data: {
        provider,
        permissionScope,
        endpoint,
        statusCode,
        success,
        errorMessage,
        metadata,
      },
    });
  } catch (err) {
    console.error("[logApiCall] Failed to log API call:", err);
  }
}

async function scrapePublicInstagramProfile(username: string): Promise<any> {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
  
  const response = await proxyFetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "x-ig-app-id": "936619743392459",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    }
  });

  if (!response.ok) {
    throw new Error(`Scraper HTTP Error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as any;
  if (!json?.data?.user) {
    throw new Error("Invalid scraper response: User data not found");
  }

  const user = json.data.user;
  return {
    followersCount: user.edge_followed_by?.count,
    postsCount: user.edge_owner_to_timeline_media?.count,
    profileBio: user.biography,
    profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
    profileExternalUrls: user.external_url ? [user.external_url] : [],
    name: user.full_name,
    username: user.username
  };
}

export async function collectInstagramFollowers(
  config: InstagramCollectorConfig
): Promise<CollectionResult> {
  const prisma = getPrisma();
  const result: CollectionResult = { successCount: 0, failedCount: 0, errors: [] };

  // Query all Instagram sellers that are monitored
  const sellers = await prisma.seller.findMany({
    where: { snsType: "INSTAGRAM", isMonitored: true },
    select: { id: true, snsHandle: true, currentFollowers: true, currentPostsCount: true },
  });

  if (sellers.length === 0) return result;

  const today = getKstMidnightUTC();

  // 미설정은 mock 이 아니라 "미설정" 이다 — 조용히 난수를 쓰지 않고 사유를 남기고 중단한다
  // (engagement 수집기들이 이미 쓰는 게이트 패턴, P0 No Silent Failure).
  const mode = resolveCollectMode("INSTAGRAM");
  if (!mode) {
    result.errors.push({
      sellerId: "SYSTEM",
      snsHandle: "",
      error: `skipped: ${collectModeUnsetReason("INSTAGRAM")}`,
    });
    return result;
  }

  // mock 은 no-op 이 아니라 난수를 **저장**한다 — 원격 DB(프로덕션)면 여기서 끊는다.
  // throw 하지 않는 이유: 크론 라우트가 이 수집기를 다른 잡과 같은 요청에서 돌리므로
  // 예외를 던지면 크론 전체가 죽는다(기존 미설정 게이트와 같은 관용구).
  const mockBlocked = mockCollectBlockedReason("INSTAGRAM", mode);
  if (mockBlocked) {
    result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: `skipped: ${mockBlocked}` });
    return result;
  }

  // `apify` 는 이 수집기에서 더 이상 실행 경로가 아니다(Apify 호출 코드 제거됨) — 비-mock
  // 값은 전부 같은 2단 폴백으로 흐른다. 라벨은 실제 경로를 따라가므로 데이터는 정확하지만,
  // env 가 사실과 어긋나 있다는 것 자체는 알린다(env 값을 사후에 읽을 수 없으므로 로그가 창구).
  if (mode === "apify") {
    console.warn(
      "[InstagramCollector] INSTAGRAM_COLLECT_MODE=apify 는 이 수집기에서 실행 경로가 아닙니다 — 비-mock 경로(공개 스크래퍼 → Graph 폴백)로 동작합니다."
    );
  }

  // 수집 주기 cutoff (기본 7일, SSOT=collect-cycle) — 크론이 매일 발화하므로
  // 실제 셀러별 수집 주기는 이 cutoff가 정한다.
  const cutoffDate = getCollectCutoff();

  const targetsToCollect: typeof sellers = [];

  for (const seller of sellers) {
    try {
      // 1. Check if snapshot already exists for today (idempotency)
      const existing = await prisma.sellersHistory.findUnique({
        where: { sellerId_snapshotDate: { sellerId: seller.id, snapshotDate: today } },
      });
      if (existing) {
        result.successCount++;
        continue;
      }

      // 2. Check if a successful scrape happened in the last N days
      const lastHistory = await prisma.sellersHistory.findFirst({
        where: { 
          sellerId: seller.id,
          source: { not: "INTERNAL" }
        },
        orderBy: { snapshotDate: "desc" },
      });

      if (lastHistory && lastHistory.snapshotDate > cutoffDate) {
        // Skip if collected less than N days ago
        result.successCount++;
        continue;
      }

      targetsToCollect.push(seller);
    } catch (err) {
      result.failedCount++;
      result.errors.push({
        sellerId: seller.id,
        snsHandle: seller.snsHandle,
        error: err instanceof Error ? err.message : "Preprocessing error",
      });
    }
  }

  if (targetsToCollect.length === 0) return result;

    // Apify 모드는 더 이상 사용하지 않으므로 제거되었습니다.
    for (const seller of targetsToCollect) {
      try {
        let followersCount: number | null = null;
        let profileMetrics: Omit<InstagramProfileMetrics, "followersCount"> = {};
        // 성공한 경로에서만 채운다 — 모드가 아니라 사실을 담는 변수다.
        let snapshotSource: InstagramSnapshotSource | null = null;

        if (mode === "mock") {
          // Mock Mode: Generate a random change (+50 to +200 followers)
          const current = seller.currentFollowers || 0;
          const change = Math.floor(Math.random() * 151) + 50; // 50 ~ 200
          followersCount = current === 0 ? Math.floor(Math.random() * 10000) + 5000 : current + change;
          profileMetrics.postsCount =
            seller.currentPostsCount == null
              ? Math.floor(Math.random() * 1200) + 50
              : seller.currentPostsCount + Math.floor(Math.random() * 3);
          snapshotSource = INSTAGRAM_SNAPSHOT_SOURCE.MOCK;

          // Log the mock call
          await logApiCall(
            "INSTAGRAM",
            "/mock/instagram/business_discovery",
            200,
            true,
            null,
            "mock",
            JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle, followersCount, postsCount: profileMetrics.postsCount })
          );
        } else {
          let scraperSuccess = false;
          try {
            console.log(`[InstagramCollector] Attempting scraper for seller: ${seller.snsHandle}`);
            const scraped = await scrapePublicInstagramProfile(seller.snsHandle);
            
            followersCount = scraped.followersCount ?? null;
            profileMetrics = {
              postsCount: scraped.postsCount,
              profileBio: scraped.profileBio,
              profilePicUrl: scraped.profilePicUrl,
              profileExternalUrls: scraped.profileExternalUrls,
              name: scraped.name,
            };

            if (typeof followersCount === "number") {
              scraperSuccess = true;
              snapshotSource = INSTAGRAM_SNAPSHOT_SOURCE.SCRAPER;
              await logApiCall(
                "INSTAGRAM",
                `/scraper/web_profile_info?username=${seller.snsHandle}`,
                200,
                true,
                null,
                "instagram_scraper",
                JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle, followersCount, postsCount: profileMetrics.postsCount })
              );

              if (process.env.NODE_ENV !== "test") {
                await new Promise((resolve) => setTimeout(resolve, 1500));
              }
            }
          } catch (scraperErr: any) {
            console.warn(`[InstagramCollector] Scraper failed for ${seller.snsHandle}: ${scraperErr.message}. Falling back to Meta Graph API...`);
            await logApiCall(
              "INSTAGRAM",
              `/scraper/web_profile_info?username=${seller.snsHandle}`,
              500,
              false,
              `Scraper failed: ${scraperErr.message}`,
              "instagram_scraper",
              JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle })
            );
          }

          if (!scraperSuccess) {
            // Meta Graph API Mode Fallback
            const url = `https://graph.facebook.com/v19.0/${config.igBusinessAccountId}?fields=business_discovery.fields(followers_count,media_count,name,username,biography,profile_picture_url,website)&business_discovery.username=${seller.snsHandle}&access_token=${config.accessToken}`;

            let response;
          try {
            response = await fetch(url);
          } catch (fetchErr) {
            const errMsg = fetchErr instanceof Error ? fetchErr.message : "Network error";
            result.failedCount++;
            result.errors.push({ sellerId: seller.id, snsHandle: seller.snsHandle, error: errMsg });
            
            await logApiCall(
              "INSTAGRAM",
              `GET /v19.0/${config.igBusinessAccountId}/business_discovery`,
              500,
              false,
              errMsg,
              "instagram_basic",
              JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle })
            );
            continue;
          }

          if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get("retry-after") || "60", 10);
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
            result.failedCount++;
            const errMsg = "Rate limited, skipped";
            result.errors.push({ sellerId: seller.id, snsHandle: seller.snsHandle, error: errMsg });
            
            await logApiCall(
              "INSTAGRAM",
              `GET /v19.0/${config.igBusinessAccountId}/business_discovery`,
              429,
              false,
              errMsg,
              "instagram_basic",
              JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle })
            );
            continue;
          }

          if (response.status === 401 || response.status === 400) {
            const errorData = await response.json().catch(() => ({}));
            const errorMsg = errorData?.error?.message || "Authentication failed";
            
            await logApiCall(
              "INSTAGRAM",
              `GET /v19.0/${config.igBusinessAccountId}/business_discovery`,
              response.status,
              false,
              errorMsg,
              "instagram_basic",
              JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle })
            );

            if (errorMsg.includes("token") || errorMsg.includes("expired") || errorMsg.includes("invalid")) {
              result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: `Auth failure: ${errorMsg}` });
              continue;
            }
          }

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
            result.failedCount++;
            result.errors.push({ sellerId: seller.id, snsHandle: seller.snsHandle, error: errorMsg });
            
            await logApiCall(
              "INSTAGRAM",
              `GET /v19.0/${config.igBusinessAccountId}/business_discovery`,
              response.status,
              false,
              errorMsg,
              "instagram_basic",
              JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle })
            );
            continue;
          }

          const data = await response.json();
          const normalized = normalizeInstagramProfileMetrics(data);
          followersCount = normalized.followersCount ?? null;
          profileMetrics = {
            postsCount: normalized.postsCount,
            profileBio: normalized.profileBio,
            profilePicUrl: normalized.profilePicUrl,
            profileExternalUrls: normalized.profileExternalUrls,
            name: normalized.name,
          };

          if (typeof followersCount !== "number") {
            const errMsg = "Invalid response: followers_count not found";
            result.failedCount++;
            result.errors.push({ sellerId: seller.id, snsHandle: seller.snsHandle, error: errMsg });
            
            await logApiCall(
              "INSTAGRAM",
              `GET /v19.0/${config.igBusinessAccountId}/business_discovery`,
              200,
              false,
              errMsg,
              "instagram_basic",
              JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle, rawData: data })
            );
            continue;
          }

          snapshotSource = INSTAGRAM_SNAPSHOT_SOURCE.GRAPH;

          // Log successful Meta call
          await logApiCall(
            "INSTAGRAM",
            `GET /v19.0/${config.igBusinessAccountId}/business_discovery`,
            200,
            true,
            null,
            "instagram_basic",
            JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle, followersCount, postsCount: profileMetrics.postsCount })
          );

          // API Throttle delay to avoid rate limit
          if (process.env.NODE_ENV !== "test") {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          } // End of if (!scraperSuccess)
        }

        if (typeof followersCount === "number") {
          // 값은 있는데 경로 라벨이 없다면 위 분기 중 하나가 라벨을 빠뜨린 것이다.
          // 출처 불명으로 저장하면 이 필드의 관측 가치가 다시 사라지므로 조용히
          // 넘기지 않고 실패로 남긴다(P0 No Silent Failure).
          if (!snapshotSource) {
            throw new Error("Snapshot source unresolved: collection path did not label itself");
          }

          // Upsert snapshot using helper to prevent primary key collision
          await recordSellerMetricsSnapshot(seller.id, followersCount, snapshotSource, profileMetrics);

          result.successCount++;
        }
      } catch (error) {
        result.failedCount++;
        const errMsg = error instanceof Error ? error.message : "Unknown error";
        result.errors.push({
          sellerId: seller.id,
          snsHandle: seller.snsHandle,
          error: errMsg,
        });

        await logApiCall(
          "INSTAGRAM",
          mode === "mock"
            ? "/mock/instagram/business_discovery"
            : `GET /v19.0/${config.igBusinessAccountId}/business_discovery`,
          500,
          false,
          errMsg,
          mode === "mock" ? "mock" : "instagram_basic",
          JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle })
        );
      }
    }
  return result;
}
