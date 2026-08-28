-- 공유 미리보기 스냅샷 컬럼. 전부 nullable 이라 기존 행·기존 SELECT 를 깨지 않는다.
-- (prisma migrate diff 정규 출력과 동일한 형태로 둔다 — 이후 대조가 깔끔하다)
-- AlterTable
ALTER TABLE "TrackedLink" ADD COLUMN     "ogDescription" TEXT,
ADD COLUMN     "ogFetchedAt" TIMESTAMP(3),
ADD COLUMN     "ogImage" TEXT,
ADD COLUMN     "ogTitle" TEXT;
