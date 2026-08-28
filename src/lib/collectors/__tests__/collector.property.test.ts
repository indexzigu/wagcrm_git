/**
 * Property-based tests for Instagram and YouTube collectors.
 *
 * Feature: data-collection-insights
 * Validates: Requirements 1.2, 1.3, 1.5, 2.2, 2.4, 3.2, 3.3, 3.5, 4.1, 4.2, 4.4
 *
 * Properties tested:
 *   Property 1: Snapshot creation preserves fetched data
 *   Property 3: Collection is idempotent within a day
 *   Property 4: Collection is resilient to per-seller failures
 *   Property 5: Collection summary counts are accurate
 *   Property 6: Quota termination preserves collected data
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports of the modules under test
// ---------------------------------------------------------------------------

// We mock the prisma module so no real DB is needed.
vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));

// We mock global fetch so no real HTTP calls are made.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Instagram Tier 0 스크래퍼(scrapePublicInstagramProfile)는 global fetch가 아니라
// proxyFetch(undici)를 쓰므로 위 stub을 우회해 실제 instagram.com에 붙는다(401/지연).
// 스크래퍼를 즉시 실패시켜 네트워크 없이 Graph API(global fetch=모킹됨) 폴백으로
// 결정적으로 흘려보낸다 — 테스트는 source=INSTAGRAM_API(Graph) 경로를 검증하므로 일치.
vi.mock("@/lib/order-converter/fetch-client", () => ({
  proxyFetch: vi.fn().mockRejectedValue(new Error("scraper disabled in test")),
}));

import { getPrisma } from "@/lib/prisma";
import { getKstMidnightUTC } from "@/lib/seller-history";
import {
  collectInstagramFollowers,
  type InstagramCollectorConfig,
} from "../instagram-collector";
import { collectYouTubeSubscribers, type YouTubeCollectorConfig } from "../youtube-collector";

let originalMode: string | undefined;
let originalIgMode: string | undefined;
let originalYtMode: string | undefined;

beforeAll(() => {
  originalMode = process.env.METRICS_PROVIDER_MODE;
  process.env.METRICS_PROVIDER_MODE = "youtube";
  originalIgMode = process.env.INSTAGRAM_COLLECT_MODE;
  process.env.INSTAGRAM_COLLECT_MODE = "instagram";
  originalYtMode = process.env.YOUTUBE_COLLECT_MODE;
  process.env.YOUTUBE_COLLECT_MODE = "youtube";
});

afterAll(() => {
  if (originalMode === undefined) {
    delete process.env.METRICS_PROVIDER_MODE;
  } else {
    process.env.METRICS_PROVIDER_MODE = originalMode;
  }
  if (originalIgMode === undefined) {
    delete process.env.INSTAGRAM_COLLECT_MODE;
  } else {
    process.env.INSTAGRAM_COLLECT_MODE = originalIgMode;
  }
  if (originalYtMode === undefined) {
    delete process.env.YOUTUBE_COLLECT_MODE;
  } else {
    process.env.YOUTUBE_COLLECT_MODE = originalYtMode;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Prisma mock whose behaviour can be overridden per test. */
function buildPrismaMock(overrides: Record<string, unknown> = {}) {
  return {
    seller: {
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    sellersHistory: {
      findUnique: vi.fn().mockResolvedValue(null), // no existing snapshot by default
      findFirst: vi.fn().mockResolvedValue(null), // no recent snapshot by default
      create: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    apiCallLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

/** Build a successful Instagram API response for a given follower count. */
function instagramSuccessResponse(followersCount: number): Response {
  return new Response(
    JSON.stringify({ business_discovery: { followers_count: followersCount } }),
    { status: 200 }
  );
}

/** Build a successful YouTube API response for a list of (channelId, subscriberCount) pairs. */
function youtubeSuccessResponse(items: Array<{ id: string; subscriberCount: number }>): Response {
  return new Response(
    JSON.stringify({
      items: items.map(({ id, subscriberCount }) => ({
        id,
        statistics: { subscriberCount: String(subscriberCount) },
      })),
    }),
    { status: 200 }
  );
}

/** Build a YouTube quota-exceeded 403 response. */
function youtubeQuotaResponse(): Response {
  return new Response(
    JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }),
    { status: 403 }
  );
}

/** Build a generic HTTP error response. */
function errorResponse(status: number, message = "API error"): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

const instagramConfig: InstagramCollectorConfig = {
  appId: "app-id",
  appSecret: "app-secret",
  accessToken: "valid-token",
  igBusinessAccountId: "ig-biz-id",
};

const youtubeConfig: YouTubeCollectorConfig = { apiKey: "yt-api-key" };

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates a non-empty alphanumeric string suitable for IDs / handles. */
const nonEmptyAlphaNum = fc.stringMatching(/^[a-z0-9]{1,20}$/);

/** Generates a valid follower count (0 – 10,000,000). */
const followerCount = fc.integer({ min: 0, max: 10_000_000 });

/** Generates a list of 1–20 unique sellers. */
const sellersArb = fc
  .uniqueArray(
    fc.record({ id: nonEmptyAlphaNum, snsHandle: nonEmptyAlphaNum }),
    { minLength: 1, maxLength: 20, selector: s => s.id }
  );

// ---------------------------------------------------------------------------
// Property 1: Snapshot creation preserves fetched data
// Validates: Requirements 1.2, 3.2
// ---------------------------------------------------------------------------

describe("Property 1: Snapshot creation preserves fetched data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Instagram — created snapshot has correct sellerId, followersCount, and source=INSTAGRAM_API", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: nonEmptyAlphaNum, snsHandle: nonEmptyAlphaNum }),
        followerCount,
        async (seller, followers) => {
          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue([seller]);
          prisma.sellersHistory.findUnique.mockResolvedValue(null);
          prisma.sellersHistory.upsert.mockResolvedValue({});
          mockFetch.mockResolvedValue(instagramSuccessResponse(followers));

          await collectInstagramFollowers(instagramConfig);

          expect(prisma.sellersHistory.upsert).toHaveBeenCalledOnce();
          const createArg = prisma.sellersHistory.upsert.mock.calls[0][0].create;
          expect(createArg.sellerId).toBe(seller.id);
          expect(createArg.followersCount).toBe(followers);
          expect(createArg.source).toBe("INSTAGRAM_API");
          // snapshotDate should be today at midnight
          expect(createArg.snapshotDate).toBeInstanceOf(Date);
          const today = getKstMidnightUTC();
          expect(createArg.snapshotDate.getTime()).toBe(today.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });

  it("YouTube — created snapshot has correct sellerId, followersCount, and source=YOUTUBE_API", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: nonEmptyAlphaNum, snsHandle: nonEmptyAlphaNum }),
        followerCount,
        async (seller, subscribers) => {
          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue([seller]);
          prisma.sellersHistory.findUnique.mockResolvedValue(null);
          prisma.sellersHistory.upsert.mockResolvedValue({});
          mockFetch.mockResolvedValue(
            youtubeSuccessResponse([{ id: seller.snsHandle, subscriberCount: subscribers }])
          );

          await collectYouTubeSubscribers(youtubeConfig);

          expect(prisma.sellersHistory.upsert).toHaveBeenCalledOnce();
          const createArg = prisma.sellersHistory.upsert.mock.calls[0][0].create;
          expect(createArg.sellerId).toBe(seller.id);
          expect(createArg.followersCount).toBe(subscribers);
          expect(createArg.source).toBe("YOUTUBE_API");
          const today = getKstMidnightUTC();
          expect(createArg.snapshotDate.getTime()).toBe(today.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Collection is idempotent within a day
// Validates: Requirements 1.5, 3.5
// ---------------------------------------------------------------------------

describe("Property 3: Collection is idempotent within a day", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Instagram — does not create a duplicate snapshot when one already exists for today", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: nonEmptyAlphaNum, snsHandle: nonEmptyAlphaNum }),
        followerCount,
        async (seller, followers) => {
          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue([seller]);
          // Simulate existing snapshot for today
          prisma.sellersHistory.findUnique.mockResolvedValue({
            id: "existing",
            sellerId: seller.id,
            followersCount: followers,
          });
          mockFetch.mockResolvedValue(instagramSuccessResponse(followers));

          await collectInstagramFollowers(instagramConfig);

          // upsert should NOT be called because snapshot already exists
          expect(prisma.sellersHistory.upsert).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("YouTube — does not create a duplicate snapshot when one already exists for today", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: nonEmptyAlphaNum, snsHandle: nonEmptyAlphaNum }),
        followerCount,
        async (seller, subscribers) => {
          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue([seller]);
          prisma.sellersHistory.findUnique.mockResolvedValue({
            id: "existing",
            sellerId: seller.id,
            followersCount: subscribers,
          });
          mockFetch.mockResolvedValue(
            youtubeSuccessResponse([{ id: seller.snsHandle, subscriberCount: subscribers }])
          );

          await collectYouTubeSubscribers(youtubeConfig);

          expect(prisma.sellersHistory.upsert).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Collection is resilient to per-seller failures
// Validates: Requirements 2.2, 4.2
// ---------------------------------------------------------------------------

describe("Property 4: Collection is resilient to per-seller failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Instagram — processes remaining sellers even when some return API errors", async () => {
    await fc.assert(
      fc.asyncProperty(
        // At least 2 sellers so we can have 1 failure + 1 success
        fc.uniqueArray(
          fc.record({ id: nonEmptyAlphaNum, snsHandle: nonEmptyAlphaNum }),
          { minLength: 2, maxLength: 10, selector: s => s.id }
        ),
        // Index of the seller that will fail (not the last one, so there's always a success after)
        fc.integer({ min: 0, max: 0 }), // always fail the first seller
        followerCount,
        async (sellers, _failIdx, followers) => {
          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue(sellers);
          prisma.sellersHistory.findUnique.mockResolvedValue(null);
          prisma.sellersHistory.upsert.mockResolvedValue({});

          // First seller fails with 500, rest succeed
          let callCount = 0;
          mockFetch.mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve(errorResponse(500));
            return Promise.resolve(instagramSuccessResponse(followers));
          });

          const result = await collectInstagramFollowers(instagramConfig);

          // The remaining N-1 sellers should have succeeded
          expect(result.successCount).toBe(sellers.length - 1);
          expect(result.failedCount).toBe(1);
          // upsert should have been called for each successful seller
          expect(prisma.sellersHistory.upsert).toHaveBeenCalledTimes(sellers.length - 1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("YouTube — processes remaining sellers even when some are missing from API response", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Sellers with unique snsHandles so the channelMap lookup is deterministic
        fc.uniqueArray(
          fc.nat({ max: 9999 }).map(n => ({
            id: `seller-${n}`,
            snsHandle: `handle-${n}`,
          })),
          { minLength: 2, maxLength: 10, selector: s => s.snsHandle }
        ),
        followerCount,
        async (sellers, subscribers) => {
          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue(sellers);
          prisma.sellersHistory.findUnique.mockResolvedValue(null);
          prisma.sellersHistory.create.mockResolvedValue({});

          // Only return data for sellers[1..] — sellers[0] is "missing" from response
          const successfulSellers = sellers.slice(1);
          mockFetch.mockResolvedValue(
            youtubeSuccessResponse(
              successfulSellers.map(s => ({ id: s.snsHandle, subscriberCount: subscribers }))
            )
          );

          const result = await collectYouTubeSubscribers(youtubeConfig);

          // sellers[0] should fail (not found), rest should succeed
          expect(result.failedCount).toBe(1);
          expect(result.successCount).toBe(sellers.length - 1);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Collection summary counts are accurate
// Validates: Requirements 2.4, 4.4
// ---------------------------------------------------------------------------

describe("Property 5: Collection summary counts are accurate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Instagram — successCount + failedCount = total sellers, errors.length = failedCount", async () => {
    await fc.assert(
      fc.asyncProperty(
        sellersArb,
        // Number of sellers that will fail (0 to all)
        fc.nat(),
        followerCount,
        async (sellers, rawFailCount, followers) => {
          const failCount = rawFailCount % sellers.length; // 0..N-1 failures
          const successCount = sellers.length - failCount;

          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue(sellers);
          prisma.sellersHistory.findUnique.mockResolvedValue(null);
          prisma.sellersHistory.create.mockResolvedValue({});

          let callCount = 0;
          mockFetch.mockImplementation(() => {
            callCount++;
            if (callCount <= failCount) return Promise.resolve(errorResponse(500));
            return Promise.resolve(instagramSuccessResponse(followers));
          });

          const result = await collectInstagramFollowers(instagramConfig);

          expect(result.successCount).toBe(successCount);
          expect(result.failedCount).toBe(failCount);
          expect(result.errors.length).toBe(failCount);
          expect(result.successCount + result.failedCount).toBe(sellers.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("YouTube — successCount + failedCount = total sellers, errors.length = failedCount", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Sellers with unique IDs AND unique snsHandles (YouTube maps by snsHandle)
        fc.uniqueArray(
          fc.nat({ max: 9999 }).map(n => ({
            id: `seller-${n}`,
            snsHandle: `handle-${n}`,
          })),
          { minLength: 1, maxLength: 20, selector: s => s.snsHandle }
        ),
        fc.nat(),
        followerCount,
        async (sellers, rawFailCount, subscribers) => {
          const failCount = rawFailCount % sellers.length;
          const successCount = sellers.length - failCount;

          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue(sellers);
          prisma.sellersHistory.findUnique.mockResolvedValue(null);
          prisma.sellersHistory.create.mockResolvedValue({});

          // Return data only for the "successful" sellers (last N-failCount)
          // The first failCount sellers are omitted from the response → "not found" → failedCount++
          const successfulSellers = sellers.slice(failCount);
          mockFetch.mockResolvedValue(
            youtubeSuccessResponse(
              successfulSellers.map(s => ({ id: s.snsHandle, subscriberCount: subscribers }))
            )
          );

          const result = await collectYouTubeSubscribers(youtubeConfig);

          expect(result.successCount).toBe(successCount);
          expect(result.failedCount).toBe(failCount);
          expect(result.errors.length).toBe(failCount);
          expect(result.successCount + result.failedCount).toBe(sellers.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Quota termination preserves collected data
// Validates: Requirements 4.1
// ---------------------------------------------------------------------------

describe("Property 6: Quota termination preserves collected data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("YouTube — snapshots created before quota error are preserved; collection terminates early", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Need at least 2 batches: first succeeds, second hits quota
        // Each batch is up to 50 sellers; use 2 batches of 1 seller each for simplicity
        fc.integer({ min: 1, max: 5 }),  // K sellers succeed before quota
        fc.integer({ min: 1, max: 5 }),  // M sellers would have been processed after quota
        async (kSuccess, mAfterQuota) => {
          // Build K+M unique sellers
          const successSellers = Array.from({ length: kSuccess }, (_, i) => ({
            id: `success-${i}`,
            snsHandle: `handle-success-${i}`,
          }));
          const afterSellers = Array.from({ length: mAfterQuota }, (_, i) => ({
            id: `after-${i}`,
            snsHandle: `handle-after-${i}`,
          }));
          const allSellers = [...successSellers, ...afterSellers];

          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue(allSellers);
          prisma.sellersHistory.findUnique.mockResolvedValue(null);
          prisma.sellersHistory.upsert.mockResolvedValue({});

          // YouTube batches 50 at a time. With ≤10 sellers total, all fit in one batch.
          // To test quota mid-run we need multiple batches, so we use sellers > 50.
          // Instead, we simulate quota by making the SECOND fetch call return quota error.
          // We split into two batches by having >50 sellers — but that's complex.
          // Simpler: test that when quota hits on the FIRST batch, 0 snapshots are created
          // and the result is returned immediately (preserving 0 already-collected).
          // For the multi-batch case, we test with exactly 51 sellers.

          // Reset to a simpler scenario: all sellers in one batch, quota hits immediately.
          // The key property: whatever was created before the quota call is preserved.
          // Since quota is a batch-level error, we test: quota on batch 1 → 0 creates, terminates.
          mockFetch.mockResolvedValue(youtubeQuotaResponse());

          const result = await collectYouTubeSubscribers(youtubeConfig);

          // No snapshots should have been created (quota hit before any success)
          expect(prisma.sellersHistory.upsert).not.toHaveBeenCalled();
          // Result should be returned (not thrown)
          expect(result).toBeDefined();
          expect(result.errors.some(e => e.error.includes("quota"))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("YouTube — with 2 batches (>50 sellers): snapshots from first batch are preserved when second batch hits quota", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Second batch size: 1-50 sellers that hit quota (first batch is always 50)
        fc.integer({ min: 1, max: 50 }),
        followerCount,
        async (secondBatchSize, subscribers) => {
          // First batch is exactly 50 sellers (fills one full batch)
          const firstBatchSize = 50;
          const firstBatch = Array.from({ length: firstBatchSize }, (_, i) => ({
            id: `first-${i}`,
            snsHandle: `handle-first-${i}`,
          }));
          // Second batch has secondBatchSize sellers
          const secondBatch = Array.from({ length: secondBatchSize }, (_, i) => ({
            id: `second-${i}`,
            snsHandle: `handle-second-${i}`,
          }));
          const allSellers = [...firstBatch, ...secondBatch];
          // Total > 50, so YouTube collector will make 2 separate fetch calls

          const prisma = buildPrismaMock();
          vi.mocked(getPrisma).mockReturnValue(prisma as never);
          prisma.seller.findMany.mockResolvedValue(allSellers);
          prisma.sellersHistory.findUnique.mockResolvedValue(null);
          prisma.sellersHistory.upsert.mockResolvedValue({});

          let batchCall = 0;
          mockFetch.mockImplementation(() => {
            batchCall++;
            if (batchCall === 1) {
              // First batch succeeds
              return Promise.resolve(
                youtubeSuccessResponse(
                  firstBatch.map(s => ({ id: s.snsHandle, subscriberCount: subscribers }))
                )
              );
            }
            // Second batch hits quota
            return Promise.resolve(youtubeQuotaResponse());
          });

          const result = await collectYouTubeSubscribers(youtubeConfig);

          // First batch snapshots should have been created (preserved)
          expect(prisma.sellersHistory.upsert).toHaveBeenCalledTimes(firstBatchSize);
          // Result should reflect first batch successes
          expect(result.successCount).toBe(firstBatchSize);
          // Quota error should be in errors
          expect(result.errors.some(e => e.error.includes("quota"))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
