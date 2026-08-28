-- 원천징수 신고·간이지급명세서에 적는 법적 실명. 추가형 nullable 컬럼이라 기존 행 무영향이다.
-- `Seller.name` 은 실무에서 활동명(SNS 계정명)이 들어가 있어 신고 서식에 쓸 수 없다 —
-- 두 값을 분리하고, 미입력 셀러는 리포트에서 폴백 없이 경고로 드러낸다.
ALTER TABLE "Seller" ADD COLUMN "realName" TEXT;
