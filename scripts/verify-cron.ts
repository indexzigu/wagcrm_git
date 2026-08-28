// 팔로워 수집의 **수동 통합 검증** — 수집기가 로컬 DB에 실제로 쓰는지(Seller.currentFollowers
// 갱신 + SellersHistory 스냅샷 생성) 목업 모드로 확인한다. 단위 테스트는 Prisma를 목킹하므로
// "실제 DB에 써지는가"는 여기서만 본다.
//
// ⚠️ 종전에는 `/api/cron/sync-followers` 라우트의 GET을 불렀는데, 그 라우트는 아래 두 수집기를
// 감싸기만 하는 껍데기였고 vercel.json crons·KNOWN_JOBS·GHA 폴백 어디에도 등록되지 않은
// 미등록 고아였다(기능은 collect-instagram·collect-youtube가 완전히 흡수했고, 그쪽은 레이더
// 관측·캐시 무효화까지 한다). 2026-08-05 오너 결정으로 라우트를 삭제하면서, 이 스크립트는
// **원래 검증하려던 대상인 수집기를 직접** 부르도록 바꿨다 — 라우트를 거칠 이유가 없었다.
//
// 삭제된 인증 시나리오(401/200)는 손실이 아니다: `src/lib/__tests__/cron-auth.test.ts`(예시)와
// `src/app/api/cron/__tests__/cron-auth.property.test.ts`(프로퍼티)가 훨씬 넓게 덮는다.
import { collectInstagramFollowers } from "../src/lib/collectors/instagram-collector";
import { collectYouTubeSubscribers } from "../src/lib/collectors/youtube-collector";
import { getPrisma } from "../src/lib/prisma";
import { assertLocalDbForMockRun } from "./assert-local-db";

async function testCronRoute() {
  console.log("=== Starting Follower Collector Integration Verification ===");

  // mock 을 켜는 스크립트다 — 프로덕션 DB 에서는 시작조차 하지 않는다(임시 셀러 생성 전에 판정).
  assertLocalDbForMockRun("verify-cron");

  const prisma = getPrisma();
  
  // 1. Setup temporary monitored sellers for testing
  const testIgHandle = "cron_test_ig_handle";
  const testYtHandle = "cron_test_yt_handle";

  // Cleanup
  await prisma.sellersHistory.deleteMany({
    where: { seller: { snsHandle: { in: [testIgHandle, testYtHandle] } } }
  });
  await prisma.seller.deleteMany({
    where: { snsHandle: { in: [testIgHandle, testYtHandle] } }
  });

  // Create monitored sellers
  const igSeller = await prisma.seller.create({
    data: {
      name: "Cron Test Instagram Seller",
      snsType: "INSTAGRAM",
      snsHandle: testIgHandle,
      currentFollowers: 5000,
      isMonitored: true,
      category: "Fashion",
    }
  });

  const ytSeller = await prisma.seller.create({
    data: {
      name: "Cron Test YouTube Seller",
      snsType: "YOUTUBE",
      snsHandle: testYtHandle,
      currentFollowers: 15000,
      isMonitored: true,
      category: "IT",
    }
  });

  console.log(`Created test sellers: IG ID ${igSeller.id}, YT ID ${ytSeller.id}`);

  try {
    // Set to mock mode
    process.env.INSTAGRAM_COLLECT_MODE = "mock";
    process.env.YOUTUBE_COLLECT_MODE = "mock";

    // Clear history to avoid skip logic
    await prisma.sellersHistory.deleteMany({
      where: { sellerId: { in: [igSeller.id, ytSeller.id] } }
    });

    console.log("\n--- Collecting Instagram followers (mock) ---");
    const instagramResult = await collectInstagramFollowers({
      appId: process.env.INSTAGRAM_APP_ID || "",
      appSecret: process.env.INSTAGRAM_APP_SECRET || "",
      accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || "",
      igBusinessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "",
    });

    console.log("\n--- Collecting YouTube subscribers (mock) ---");
    const youtubeResult = await collectYouTubeSubscribers({
      apiKey: process.env.YOUTUBE_API_KEY || "",
    });

    console.log(
      "Collector results:",
      JSON.stringify({ instagram: instagramResult, youtube: youtubeResult }, null, 2),
    );

    // Verify database updates
    const updatedIg = await prisma.seller.findUnique({ where: { id: igSeller.id } });
    const updatedYt = await prisma.seller.findUnique({ where: { id: ytSeller.id } });

    console.log(`Updated Instagram followers: ${updatedIg?.currentFollowers}`);
    console.log(`Updated YouTube subscribers: ${updatedYt?.currentFollowers}`);

    if (updatedIg?.currentFollowers === 5000 || updatedYt?.currentFollowers === 15000) {
      throw new Error("Sellers follower counts were not updated by Cron batch");
    }

    // Verify history entries
    const igHist = await prisma.sellersHistory.findFirst({ where: { sellerId: igSeller.id } });
    const ytHist = await prisma.sellersHistory.findFirst({ where: { sellerId: ytSeller.id } });

    if (!igHist || !ytHist) {
      throw new Error("History snapshots were not created by Cron batch");
    }
    console.log(`Verified history snaps: IG=${igHist.followersCount}, YT=${ytHist.followersCount}`);

    console.log("\n=== ALL FOLLOWER COLLECTOR CHECKS PASSED SUCCESSFULLY ===");

  } finally {
    console.log("\nCleaning up verification data...");
    await prisma.sellersHistory.deleteMany({
      where: { seller: { snsHandle: { in: [testIgHandle, testYtHandle] } } }
    });
    await prisma.seller.deleteMany({
      where: { snsHandle: { in: [testIgHandle, testYtHandle] } }
    });
    console.log("Cleanup finished.");
  }
}

testCronRoute().catch(err => {
  console.error("Cron verification failed with error:", err);
  process.exit(1);
});
