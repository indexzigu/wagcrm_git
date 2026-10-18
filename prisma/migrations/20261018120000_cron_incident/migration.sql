-- 자동 작업 사고 장부(크론 자가 복구 1단계) — 크론 실패·산출 없음을 사고 한 건으로 묶는 CronIncident 표와,
-- 오류 종류·마지막 산출 시각 칸(SystemTaskStatus.lastErrorKind · lastProducedAt, SystemTaskLog.errorKind).
--
-- 순수 additive 다: 신규 테이블 1개 + nullable 칸 3개. 기존 SELECT 를 깨지 않고 착지 시점의 데이터 변화도 없다 —
-- 행·값은 크론이 다음에 돌 때부터 쌓인다.
--
-- 봇 워커(wag_agent_worker) 권한은 주지 않는다 — 워커는 이 표를 읽는 동작이 없다(필요해지면 그 동작과 같은
-- PR 에서 칸 단위로 연다). SystemTaskLog 는 20261014120000 이 칸 단위 SELECT 만 열어 두었으므로 새 칸
-- errorKind 는 워커에게 닫힌 채로 남고, 워커의 조회(executor.ts)는 명시 select 라 영향이 없다.
-- AlterTable
ALTER TABLE "SystemTaskStatus" ADD COLUMN     "lastErrorKind" TEXT,
ADD COLUMN     "lastProducedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SystemTaskLog" ADD COLUMN     "errorKind" TEXT;

-- CreateTable
CREATE TABLE "CronIncident" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "errorKind" TEXT,
    "signature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastMessage" TEXT,
    "layer" INTEGER,
    "cause" TEXT,
    "causeConfidence" TEXT,
    "actions" JSONB,
    "ownerAction" TEXT,
    "prNumber" INTEGER,
    "normalizedAt" TIMESTAMP(3),
    "normalizedEvidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CronIncident_jobKey_status_idx" ON "CronIncident"("jobKey", "status");

-- CreateIndex
CREATE INDEX "CronIncident_signature_status_idx" ON "CronIncident"("signature", "status");

-- CreateIndex
CREATE INDEX "CronIncident_status_idx" ON "CronIncident"("status");


-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」 — 정책 0개(anon·authenticated 전면 거부), Prisma `postgres` 롤은
-- 소유자라 우회하므로 앱 동작 무변화. `FORCE` 는 쓰지 않는다. 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "CronIncident" ENABLE ROW LEVEL SECURITY;
