// 구매자 지문 백필/시드 — 보관 중인 NaverOrderSnapshot 전범위를 스위프해
// CampaignBuyerFingerprint를 채운다. 멱등(반복 실행 무해).
// 용도: 마이그레이션 직후 1회 시드(현재 보관 창 안의 회차를 즉시 지문화 — 이후 크론이 증분 유지).
// 실행: source .env 선행 필수(스크립트 단독 실행은 env 수동 로드) 후
//   npx tsx scripts/backfill-buyer-fingerprints.ts
import { sweepBuyerFingerprints } from "../src/lib/cross-campaign-repurchase";

async function main() {
  const started = Date.now();
  const res = await sweepBuyerFingerprints(); // dateKeys 생략 = 보관 전범위
  console.log(
    `[backfill-buyer-fingerprints] 완료 (${((Date.now() - started) / 1000).toFixed(1)}s):`,
    `연동 캠페인 ${res.campaigns}개 · 스냅샷 ${res.snapshotDays}일 · 신규 지문 ${res.inserted}건`,
  );
}

main().catch((err) => {
  console.error("[backfill-buyer-fingerprints] 실패:", err);
  process.exit(1);
});
