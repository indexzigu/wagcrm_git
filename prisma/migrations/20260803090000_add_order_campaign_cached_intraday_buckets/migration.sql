-- 마감 시 동결하는 10분 인트라데이 버킷. 추가형 nullable 컬럼이라 기존 행 무영향이고,
-- 값이 null인 과거 마감 캠페인은 읽기 경로에서 "인트라데이 없음"으로 degrade한다.
-- cachedInsights와 동일한 취지 — 네이버 조회창이 지나면 재구성 불가라 마감 시 영속한다.
ALTER TABLE "OrderCampaign" ADD COLUMN "cachedIntradayBuckets" JSONB;
