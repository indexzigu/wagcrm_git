CREATE TABLE "AgentJob" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "workerId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'SYSTEM',
    "eventCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentJobEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentJob_idempotencyKey_key" ON "AgentJob"("idempotencyKey");
CREATE INDEX "AgentJob_status_leaseExpiresAt_createdAt_idx" ON "AgentJob"("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "AgentJob_createdAt_idx" ON "AgentJob"("createdAt");
CREATE INDEX "AgentJobEvent_jobId_createdAt_idx" ON "AgentJobEvent"("jobId", "createdAt");

ALTER TABLE "AgentJobEvent" ADD CONSTRAINT "AgentJobEvent_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "AgentJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentJobEvent" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wag_agent_worker') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO wag_agent_worker';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE "AgentJob", "AgentJobEvent" TO wag_agent_worker';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE "ActionProposal", "ActionProposalEvent" TO wag_agent_worker';
    EXECUTE 'GRANT SELECT ON TABLE "Deal", "Partner", "SalesCampaign", "Seller", "NaverOrderSnapshot", "CampaignGroup" TO wag_agent_worker';

    EXECUTE 'CREATE POLICY "wag_agent_worker_agent_job" ON "AgentJob" FOR ALL TO wag_agent_worker USING (true) WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_agent_job_event" ON "AgentJobEvent" FOR ALL TO wag_agent_worker USING (true) WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_action_proposal" ON "ActionProposal" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_action_proposal_insert" ON "ActionProposal" FOR INSERT TO wag_agent_worker WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_action_proposal_event" ON "ActionProposalEvent" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_action_proposal_event_insert" ON "ActionProposalEvent" FOR INSERT TO wag_agent_worker WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_deal" ON "Deal" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_partner" ON "Partner" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_sales_campaign" ON "SalesCampaign" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_seller" ON "Seller" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_naver_order_snapshot" ON "NaverOrderSnapshot" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_campaign_group" ON "CampaignGroup" FOR SELECT TO wag_agent_worker USING (true)';
  END IF;
END $$;
