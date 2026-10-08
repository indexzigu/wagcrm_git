-- 월별 정산 줄(#159) 표 드롭 — T-243.
--
-- #160 이 이 표를 캠페인 계산서(CampaignInvoice)로 대체한 뒤 읽고 쓰는 경로가 0곳이다.
-- 남아 있던 행은 #159 의 월정산 스위치를 켤 때 코드가 캠페인 값을 복사해 만든 것이고, 원본 값은
-- 캠페인 행에 그대로 있다.
-- 설계 정본: docs/private/specs/2026-10-08-campaign-invoices-design.md §이전
--
-- 드롭 전 프로덕션 백업 완료(읽기 전용, 2026-10-08 — 행 수는 로컬 백업 파일 참조):
-- docs/private/backups/campaign-monthly-settlement-20261008.json (모드 L, 미추적).
-- 롤백 주의: 이 배포 이전 체크아웃에는 이 표를 아는 코드가 없다(#160 에서 이미 제거) — 되돌려도
-- 앱은 이 표를 읽지 않는다. 표 자체를 되살려야 하면 20261008120000 의 CREATE 문 + 위 백업으로.
--
-- `prisma migrate diff --script`(직전 스키마 → 현 스키마) 출력과 같다 — FK 를 먼저 떼고 표를 드롭.
--
-- ⚠️ 이 표의 RLS 는 20261008120000_add_campaign_monthly_settlement 가 켰고, 그 마이그레이션은
-- 적용 완료라 편집할 수 없다(Prisma 체크섬). rls-coverage 계약의 「유령 테이블」 단언은
-- DROPPED_TABLES 면제로 처리한다.

-- DropForeignKey
ALTER TABLE "CampaignMonthlySettlement" DROP CONSTRAINT "CampaignMonthlySettlement_campaignId_fkey";

-- DropTable
DROP TABLE "CampaignMonthlySettlement";
