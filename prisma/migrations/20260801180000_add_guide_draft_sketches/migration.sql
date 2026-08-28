-- 촬영 컷 시안 URL 목록(JSON 문자열). 추가형 nullable 컬럼이라 기존 행 무영향.
-- 컷 텍스트 해시를 키로 캐시해 재생성 시 바뀐 컷만 다시 그린다.
ALTER TABLE "DealGuideDraft" ADD COLUMN "sketches" TEXT;
