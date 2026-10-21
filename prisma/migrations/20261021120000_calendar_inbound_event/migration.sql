-- CreateTable
CREATE TABLE "CalendarInboundEvent" (
    "id" TEXT NOT NULL,
    "googleEventId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "parsed" JSONB,
    "proposalId" TEXT,
    "campaignId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarInboundEvent_googleEventId_key" ON "CalendarInboundEvent"("googleEventId");

-- CreateIndex
CREATE INDEX "CalendarInboundEvent_status_lastSeenAt_idx" ON "CalendarInboundEvent"("status", "lastSeenAt");


-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」 — 정책 0개(anon·authenticated 전면 거부), Prisma `postgres` 롤은
-- 소유자라 우회하므로 앱 동작 무변화. `FORCE` 는 쓰지 않는다. 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "CalendarInboundEvent" ENABLE ROW LEVEL SECURITY;
