import { getPrisma } from "@/lib/prisma";
import { getCollectCutoff } from "@/lib/collect-cycle";
import { collectModeUnsetReason, mockCollectBlockedReason, resolveCollectMode } from "@/lib/collect-mode";
import { recordSellerFollowersSnapshot, getKstMidnightUTC } from "@/lib/seller-history";
import type { CollectionResult } from "./instagram-collector";

export type YouTubeCollectorConfig = {
  apiKey: string;
  baseUrl?: string;
};

/**
 * 스냅샷 출처 라벨(`SellersHistory.source`) = **실제로 성공한 실행 경로**의 이름이다.
 * 모드 문자열(`YOUTUBE_COLLECT_MODE`)에서 파생하지 않는다 —
 * `INSTAGRAM_SNAPSHOT_SOURCE`(instagram-collector)와 같은 규약이고, 같은 사고를
 * 막는다(P7 「Snapshot Source Label = 실행 경로의 사실」).
 *
 * 왜 파생을 그만뒀나: 종전 두 호출부가 `${mode.toUpperCase()}_API` 로 라벨을 만들어
 * **모드 문자열이 그대로 출처가 됐다.** 그런데 이 수집기의 실행 경로는 셋뿐인데
 * (mock · Data API · Apify) 분기는 `apify`·`mock` 이 아닌 **모든** 값을 Data API 로
 * 흘리므로, 모드에 따라 존재하지도 않는 라벨이 찍혔다:
 *  - `YOUTUBE_COLLECT_MODE=api` → `API_API`
 *  - `YOUTUBE_COLLECT_MODE=instagram` → `INSTAGRAM_API` ← **인스타 Graph 폴백 라벨과 충돌**
 *    (같은 라벨이 두 플랫폼의 서로 다른 경로를 가리키면 사후 경로 구분이 불가능해진다)
 *  - `=mock` → `MOCK_API` (인스타 mock 의 `MOCK` 과 갈라져 mock 판별이 두 문자열이 됐다)
 *
 * ⚠️ Vercel 의 sensitive env 는 `vercel env pull` 시 빈값으로 내려와 모드의 실제 값을
 * 사후에 읽을 수 없다 — 이 라벨이 "어느 경로가 이 데이터를 썼는가"를 복원하는 유일한
 * 관측 창구다. 그래서 라벨은 설정이 아니라 **사실**이어야 한다.
 */
export const YOUTUBE_SNAPSHOT_SOURCE = {
  /** mock 모드 — 난수 생성값(외부 호출 없음). 인스타와 **같은 문자열**을 쓴다. */
  MOCK: "MOCK",
  /** YouTube Data API v3 `channels?part=statistics` 성공 */
  DATA_API: "YOUTUBE_API",
  /**
   * Apify 액터 경로. 이 파일은 run 을 **시작만** 하고 적립은 웹훅
   * (`/api/cron/apify-webhook/youtube`)이 하므로, 라벨의 실제 writer 는 그쪽이다 —
   * 두 파일이 문자열을 각자 들고 있지 않도록 여기 한 곳에서 내보낸다.
   */
  APIFY: "APIFY_API",
} as const;

export type YouTubeSnapshotSource =
  (typeof YOUTUBE_SNAPSHOT_SOURCE)[keyof typeof YOUTUBE_SNAPSHOT_SOURCE];

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

export async function collectYouTubeSubscribers(
  config: YouTubeCollectorConfig
): Promise<CollectionResult> {
  const prisma = getPrisma();
  const result: CollectionResult = { successCount: 0, failedCount: 0, errors: [] };

  // Query all YouTube sellers that are monitored
  const sellers = await prisma.seller.findMany({
    where: { snsType: "YOUTUBE", isMonitored: true },
    select: { id: true, snsHandle: true, currentFollowers: true },
  });

  if (sellers.length === 0) return result;

  const today = getKstMidnightUTC();

  // 미설정은 mock 이 아니라 "미설정" — 난수 구독자를 쓰지 않고 사유를 남기고 중단한다.
  const mode = resolveCollectMode("YOUTUBE");
  if (!mode) {
    result.errors.push({
      sellerId: "SYSTEM",
      snsHandle: "",
      error: `skipped: ${collectModeUnsetReason("YOUTUBE")}`,
    });
    return result;
  }

  // 인스타 수집기와 같은 게이트 — mock 은 난수 구독자를 **저장**하므로 원격 DB 면 끊는다.
  const mockBlocked = mockCollectBlockedReason("YOUTUBE", mode);
  if (mockBlocked) {
    result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: `skipped: ${mockBlocked}` });
    return result;
  }

  // 수집 주기 cutoff (기본 7일, SSOT=collect-cycle) — 크론이 매일 발화하므로
  // 실제 셀러별 수집 주기는 이 cutoff가 정한다.
  const cutoffDate = getCollectCutoff();

  // Filter out sellers that were already scraped within the last N days
  const targetsToCollect: typeof sellers = [];

  for (const seller of sellers) {
    try {
      // 1. Check if snapshot already exists for today (idempotent)
      const existing = await prisma.sellersHistory.findUnique({
        where: { sellerId_snapshotDate: { sellerId: seller.id, snapshotDate: today } },
      });
      if (existing) {
        result.successCount++;
        continue;
      }

      // 2. Check if collected in last N days
      const lastHistory = await prisma.sellersHistory.findFirst({
        where: {
          sellerId: seller.id,
          source: { not: "INTERNAL" },
        },
        orderBy: { snapshotDate: "desc" },
      });

      if (lastHistory && lastHistory.snapshotDate > cutoffDate) {
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

  if (mode === "apify") {
    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) {
      const errMsg = "APIFY_API_TOKEN is missing";
      result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: errMsg });
      await logApiCall("YOUTUBE", "POST https://api.apify.com/v2/acts/apify~youtube-scraper/runs", 401, false, errMsg, "apify", null);
      return result;
    }

    const startUrls = targetsToCollect.map((s) => ({
      url: s.snsHandle.startsWith("UC")
        ? `https://www.youtube.com/channel/${s.snsHandle}`
        : `https://www.youtube.com/@${s.snsHandle}`,
    }));
    const webhookUrl = `${(config as any).baseUrl || process.env.NEXT_PUBLIC_SITE_URL}/api/cron/apify-webhook/youtube?secret=${process.env.CRON_SECRET}`;

    const url = `https://api.apify.com/v2/acts/apify~youtube-scraper/runs?token=${apifyToken}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls,
          maxResults: 1,
          downloadSubtitles: false,
          downloadComments: false,
          webhooks: [
            {
              eventTypes: ["ACTOR.RUN.SUCCEEDED"],
              requestUrl: webhookUrl,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: `Apify run start failed: ${response.status} - ${errorText}` });
        await logApiCall("YOUTUBE", "POST https://api.apify.com/v2/acts/apify~youtube-scraper/runs", response.status, false, errorText.slice(0, 500), "apify", JSON.stringify({ startUrls, webhookUrl }));
      } else {
        const data = await response.json();
        await logApiCall("YOUTUBE", "POST https://api.apify.com/v2/acts/apify~youtube-scraper/runs", 201, true, null, "apify", JSON.stringify({ runId: data.data.id, startUrlsCount: startUrls.length, webhookUrl }));
        // For Apify, we don't immediately count as success because it will be processed in the webhook.
      }
    } catch (fetchErr) {
      const errMsg = fetchErr instanceof Error ? fetchErr.message : "Network error";
      result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: errMsg });
      await logApiCall("YOUTUBE", "POST https://api.apify.com/v2/acts/apify~youtube-scraper/runs", 500, false, errMsg, "apify", JSON.stringify({ startUrls }));
    }

  } else if (mode === "mock") {
    // Process targets sequentially for mock
    for (const seller of targetsToCollect) {
      try {
        let subscriberCount: number | null = null;

        const current = seller.currentFollowers || 0;
        const change = Math.floor(Math.random() * 91) + 10; // 10 ~ 100
        subscriberCount = current === 0 ? Math.floor(Math.random() * 49000) + 1000 : current + change;

        await logApiCall(
          "YOUTUBE",
          "/mock/youtube/channels",
          200,
          true,
          null,
          "mock",
          JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle, subscriberCount })
        );

        if (typeof subscriberCount === "number") {
          await recordSellerFollowersSnapshot(seller.id, subscriberCount, YOUTUBE_SNAPSHOT_SOURCE.MOCK);

          await prisma.seller.update({
            where: { id: seller.id },
            data: { currentFollowers: subscriberCount },
          });

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
          "YOUTUBE",
          "/mock/youtube/channels",
          500,
          false,
          errMsg,
          "mock",
          JSON.stringify({ sellerId: seller.id, handle: seller.snsHandle })
        );
      }
    }
  } else {
    // YouTube Data API Mode (Batch)
    if (!config.apiKey) {
      const errMsg = "YOUTUBE_API_KEY is missing";
      result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: errMsg });

      await logApiCall(
        "YOUTUBE",
        "GET https://www.googleapis.com/youtube/v3/channels",
        401,
        false,
        errMsg,
        "youtube.readonly",
        null
      );
      return result;
    }

    const batches: typeof targetsToCollect[] = [];
    for (let i = 0; i < targetsToCollect.length; i += 50) {
      batches.push(targetsToCollect.slice(i, i + 50));
    }

    for (const batch of batches) {
      try {
        const ids = batch.map((s) => s.snsHandle).join(",");
        const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${ids}&key=${config.apiKey}`;

        let response;
        try {
          response = await fetch(url);
        } catch (fetchErr) {
          const errMsg = fetchErr instanceof Error ? fetchErr.message : "Network error";
          for (const seller of batch) {
            result.failedCount++;
            result.errors.push({ sellerId: seller.id, snsHandle: seller.snsHandle, error: errMsg });
          }

          await logApiCall(
            "YOUTUBE",
            "GET https://www.googleapis.com/youtube/v3/channels",
            500,
            false,
            errMsg,
            "youtube.readonly",
            JSON.stringify({ batchSize: batch.length, ids })
          );
          continue;
        }

        if (response.status === 403) {
          const errorData = await response.json().catch(() => ({}));
          const errReason = errorData?.error?.errors?.[0]?.reason || "unknown";
          const errMsg = errorData?.error?.message || "YouTube API quota exceeded or forbidden";
          
          result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: errMsg });

          await logApiCall(
            "YOUTUBE",
            "GET https://www.googleapis.com/youtube/v3/channels",
            403,
            false,
            errMsg,
            "youtube.readonly",
            JSON.stringify({ reason: errReason })
          );
          
          if (errReason === "quotaExceeded") {
            return result;
          }
        }

        if (response.status === 400 || response.status === 401) {
          const errorData = await response.json().catch(() => ({}));
          const errMsg = errorData?.error?.message || "Invalid or missing YouTube API key";
          
          result.errors.push({ sellerId: "SYSTEM", snsHandle: "", error: errMsg });

          await logApiCall(
            "YOUTUBE",
            "GET https://www.googleapis.com/youtube/v3/channels",
            response.status,
            false,
            errMsg,
            "youtube.readonly",
            null
          );
          return result;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => `HTTP ${response.status}`);
          for (const seller of batch) {
            result.failedCount++;
            result.errors.push({ sellerId: seller.id, snsHandle: seller.snsHandle, error: errorText });
          }

          await logApiCall(
            "YOUTUBE",
            "GET https://www.googleapis.com/youtube/v3/channels",
            response.status,
            false,
            errorText.slice(0, 500),
            "youtube.readonly",
            JSON.stringify({ ids })
          );
          continue;
        }

        const data = await response.json();
        const items = data.items ?? [];

        const channelMap = new Map<string, number>();
        for (const item of items) {
          const subscriberCount = parseInt(item.statistics?.subscriberCount ?? "0", 10);
          channelMap.set(item.id, subscriberCount);
        }

        await logApiCall(
          "YOUTUBE",
          "GET https://www.googleapis.com/youtube/v3/channels",
          200,
          true,
          null,
          "youtube.readonly",
          JSON.stringify({ batchSize: batch.length, fetchedCount: items.length })
        );

        for (const seller of batch) {
          const subscriberCount = channelMap.get(seller.snsHandle);

          if (subscriberCount === undefined) {
            result.failedCount++;
            result.errors.push({ sellerId: seller.id, snsHandle: seller.snsHandle, error: "Channel not found in response" });
            continue;
          }

          try {
            // 이 분기는 `apify`·`mock` 이 아닌 **모든** 모드가 흘러들어오는 Data API 경로다 —
            // 라벨은 모드가 아니라 이 경로의 이름으로 고정한다(위 상수 주석의 사고 축).
            await recordSellerFollowersSnapshot(seller.id, subscriberCount, YOUTUBE_SNAPSHOT_SOURCE.DATA_API);

            await prisma.seller.update({
              where: { id: seller.id },
              data: { currentFollowers: subscriberCount },
            });

            result.successCount++;
          } catch (error) {
            result.failedCount++;
            result.errors.push({
              sellerId: seller.id,
              snsHandle: seller.snsHandle,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : "Unknown error";
        for (const seller of batch) {
          result.failedCount++;
          result.errors.push({
            sellerId: seller.id,
            snsHandle: seller.snsHandle,
            error: errMsg,
          });
        }
      }

      // Throttle delay between batches in real API mode to be extremely safe
      if (process.env.NODE_ENV !== "test") {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  return result;
}
