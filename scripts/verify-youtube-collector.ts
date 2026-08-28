import { getPrisma } from "../src/lib/prisma";
import { collectYouTubeSubscribers } from "../src/lib/collectors/youtube-collector";
import { assertLocalDbForMockRun } from "./assert-local-db";

async function runTests() {
  console.log("=== Starting YouTube Collector Integration Verification ===");

  // mock 을 켜는 스크립트다 — 프로덕션 DB 에서는 시작조차 하지 않는다(임시 셀러 생성 전에 판정).
  assertLocalDbForMockRun("verify-youtube-collector");

  const prisma = getPrisma();
  const testHandle = "temp_youtube_verification_handle";

  // Clean up any leftovers first
  await prisma.sellersHistory.deleteMany({
    where: { seller: { snsHandle: testHandle } }
  });
  await prisma.seller.deleteMany({
    where: { snsHandle: testHandle }
  });
  await prisma.apiCallLog.deleteMany({
    where: { metadata: { contains: testHandle } }
  });

  const testSeller = await prisma.seller.create({
    data: {
      name: "Temp YouTube Verification Seller",
      snsType: "YOUTUBE",
      snsHandle: testHandle,
      currentFollowers: 2000,
      isMonitored: true,
      category: "IT",
    }
  });

  console.log(`Created temporary YouTube seller with ID: ${testSeller.id}`);

  try {
    // --- SCENARIO 1: Mock Mode Verification ---
    console.log("\n--- Scenario 1: Mock Mode Test ---");
    process.env.YOUTUBE_COLLECT_MODE = "mock";

    // Clear all history snapshots for test seller to avoid idempotency bypass and 7-day skip logic
    await prisma.sellersHistory.deleteMany({
      where: { sellerId: testSeller.id }
    });

    const mockResult = await collectYouTubeSubscribers({
      apiKey: "mock-api-key"
    });

    console.log("Mock Collection Result:", mockResult);

    if (mockResult.failedCount > 0) {
      throw new Error(`Mock mode collection failed: ${JSON.stringify(mockResult.errors)}`);
    }

    // Verify Seller updated
    const updatedSeller = await prisma.seller.findUnique({
      where: { id: testSeller.id }
    });
    console.log(`Updated subscriber count in DB: ${updatedSeller?.currentFollowers}`);
    if (!updatedSeller || updatedSeller.currentFollowers === 2000) {
      throw new Error("Seller current followers count was not updated in database.");
    }

    // Verify SellersHistory created
    const history = await prisma.sellersHistory.findFirst({
      where: { sellerId: testSeller.id }
    });
    if (!history) {
      throw new Error("SellersHistory record was not created.");
    }
    console.log(`Verified SellersHistory created: ${history.followersCount} subscribers, source: ${history.source}`);

    // Verify ApiCallLog logged
    const apiLog = await prisma.apiCallLog.findFirst({
      where: {
        provider: "YOUTUBE",
        metadata: { contains: testHandle }
      }
    });
    if (!apiLog || !apiLog.success || apiLog.statusCode !== 200) {
      throw new Error(`ApiCallLog was not logged correctly in Mock mode: ${JSON.stringify(apiLog)}`);
    }
    console.log(`Verified ApiCallLog in Mock mode: provider: ${apiLog.provider}, success: ${apiLog.success}, status: ${apiLog.statusCode}`);

    // --- SCENARIO 2: Real YouTube API Mode Verification (Expect failure due to fake credentials) ---
    console.log("\n--- Scenario 2: YouTube API Mode Test (With Fake Credentials) ---");
    process.env.YOUTUBE_COLLECT_MODE = "api";

    // Clear all history to force invocation
    await prisma.sellersHistory.deleteMany({
      where: { sellerId: testSeller.id }
    });

    const apiResult = await collectYouTubeSubscribers({
      apiKey: "fake-api-key"
    });

    console.log("YouTube API Collection Result:", apiResult);

    const apiLogRecord = await prisma.apiCallLog.findFirst({
      where: {
        provider: "YOUTUBE",
        endpoint: { contains: "googleapis.com" },
        metadata: { contains: testHandle }
      },
      orderBy: { calledAt: "desc" }
    });

    if (!apiLogRecord) {
      // It might be log on batch level without metadata, search by provider
      const fallbackLog = await prisma.apiCallLog.findFirst({
        where: {
          provider: "YOUTUBE",
          endpoint: { contains: "googleapis.com" }
        },
        orderBy: { calledAt: "desc" }
      });
      if (!fallbackLog) {
        throw new Error("ApiCallLog was not logged for YouTube API Mode call.");
      }
      console.log(`Verified ApiCallLog in YouTube mode (batch fallback): success: ${fallbackLog.success}, statusCode: ${fallbackLog.statusCode}, error: ${fallbackLog.errorMessage}`);
      if (fallbackLog.success) {
        throw new Error("YouTube API call unexpectedly succeeded with fake credentials.");
      }
    } else {
      console.log(`Verified ApiCallLog in YouTube mode: success: ${apiLogRecord.success}, statusCode: ${apiLogRecord.statusCode}, error: ${apiLogRecord.errorMessage}`);
      if (apiLogRecord.success) {
        throw new Error("YouTube API call unexpectedly succeeded with fake credentials.");
      }
    }

    // --- SCENARIO 3: Apify Mode Verification (Expect failure due to missing token) ---
    console.log("\n--- Scenario 3: Apify Mode Test (With Missing Token) ---");
    process.env.YOUTUBE_COLLECT_MODE = "apify";
    const originalApifyToken = process.env.APIFY_API_TOKEN;
    delete process.env.APIFY_API_TOKEN;

    const apifyResult = await collectYouTubeSubscribers({
      apiKey: "fake-api-key"
    });

    console.log("Apify Collection Result:", apifyResult);

    const apifyLog = await prisma.apiCallLog.findFirst({
      where: {
        provider: "YOUTUBE",
        endpoint: { contains: "apify" },
        metadata: { contains: testHandle }
      },
      orderBy: { calledAt: "desc" }
    });

    if (!apifyLog) {
      throw new Error("ApiCallLog was not logged for Apify Mode call.");
    }

    console.log(`Verified ApiCallLog in Apify mode: success: ${apifyLog.success}, statusCode: ${apifyLog.statusCode}, error: ${apifyLog.errorMessage}`);
    if (apifyLog.success || apifyLog.statusCode !== 401 || apifyLog.errorMessage !== "APIFY_API_TOKEN is missing") {
      throw new Error(`Apify failure log mismatch. Received: ${JSON.stringify(apifyLog)}`);
    }

    // Restore original token
    if (originalApifyToken) {
      process.env.APIFY_API_TOKEN = originalApifyToken;
    }

    console.log("\n=== ALL TEST SCENARIOS PASSED SUCCESSFULLY ===");

  } finally {
    console.log("\nCleaning up verification test data...");
    await prisma.sellersHistory.deleteMany({
      where: { seller: { snsHandle: testHandle } }
    });
    await prisma.seller.deleteMany({
      where: { snsHandle: testHandle }
    });
    await prisma.apiCallLog.deleteMany({
      where: { metadata: { contains: testHandle } }
    });
    console.log("Cleanup finished.");
  }
}

runTests().catch(err => {
  console.error("Verification script failed with error:", err);
  process.exit(1);
});
