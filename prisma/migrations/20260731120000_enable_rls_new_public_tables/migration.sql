-- Enable Row Level Security on public tables created after the 2026-07-15 snapshot.
--
-- 배경: `20260715120000_enable_rls_public_tables` 는 **그 시점의 스냅샷**이라 57개 테이블을
-- 손으로 열거했고, 마이그레이션은 다시 돌지 않는다. 그래서 그 뒤에 생긴 테이블 9개가
-- RLS 없이 남았다(2026-07-31 실측). 생성 마이그레이션은 아래와 같다:
--   20260717000000_add_product_qna_customer_inquiry  → ProductQna, CustomerInquiry
--   20260717120000_add_deal_voc_source               → DealVocSource
--   20260717150000_add_voc_insight_snapshot          → VocInsightSnapshot
--   20260718000000_add_deal_store_link               → DealStoreLink
--   20260729120000_add_claims_registry               → BannedPhraseRule, DealClaim
--   20260730120000_add_offer_answers                 → DealOfferAnswer
--   20260730150000_add_deal_asset_drafts             → DealAssetDraft
--
-- 노출 여부(과잉대응 방지): 이 9개는 **라이브 유출이 아니었다**.
-- `20260716130000_revoke_public_grants_from_anon` 이 anon 롤의 public 스키마 기본 권한을
-- 회수해 둔 상태라 `information_schema.role_table_grants` 에 anon 행이 0건이다. Supabase
-- advisor 의 "anyone with the anon key can read or modify every row" 경고는 기본 GRANT 가
-- 살아있다는 전제이고 이 DB 에는 해당하지 않는다. 이 마이그레이션이 되돌리는 것은
-- **심층방어의 두 번째 겹**이다 — GRANT 가 어떤 경로로든 되살아나도 받쳐주게.
--
-- 앱 영향 0: 데이터 접근은 전량 Prisma(`postgres` role — 테이블 소유자·BYPASSRLS)다.
-- 정책(policy)을 만들지 않으면 anon·authenticated 만 전면 거부된다. FORCE 는 쓰지 않는다
-- (소유자까지 RLS 대상이 되어 Prisma 경로를 깬다). 20260715120000 과 동일한 방식이다.
--
-- 재발 방지: 이 스냅샷 방식은 구조적으로 새 테이블을 놓친다. 그래서 판정을 사람 손이 아니라
-- `src/lib/__tests__/rls-coverage.contract.test.ts` 가 한다 — `schema.prisma` 의 모델 목록과
-- 전 마이그레이션의 ENABLE ROW LEVEL SECURITY 를 대조해 누락 시 CI(test)가 실패한다.
-- `Migration Guard`(shadow DB)로는 잡을 수 없다: RLS 는 Prisma datamodel 밖이라
-- `migrate diff` 가 영원히 무드리프트라고 답한다.

ALTER TABLE "ProductQna" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomerInquiry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealVocSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VocInsightSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealStoreLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BannedPhraseRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealOfferAnswer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealAssetDraft" ENABLE ROW LEVEL SECURITY;
