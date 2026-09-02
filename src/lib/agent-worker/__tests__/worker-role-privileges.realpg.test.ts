/**
 * Ephemeral PostgreSQL privilege check for the `wag_agent_worker` role (plan contract 5)
 * plus an end-to-end run of all five executor operations AS the worker role.
 *
 * Opt-in: set AGENT_WORKER_PRIVILEGE_TEST_ADMIN_URL to a superuser URL of a
 * disposable local PostgreSQL (for example a throw-away `postgres:17` container on a
 * random loopback port). The test creates the worker role, applies every Prisma
 * migration (so the grant block of the AgentJob migration runs for real), then probes
 * the role. It never reads the repository `.env` and refuses URLs that look like the
 * self-hosted production stack.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "@/lib/agent-worker/contracts";

const adminUrl = process.env.AGENT_WORKER_PRIVILEGE_TEST_ADMIN_URL ?? "";
const enabled = adminUrl.length > 0;

// The executor and every repository it reuses resolve their client through
// getPrisma(); here that client connects as the worker role.
let worker: PrismaClient | undefined;
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => {
    if (!worker) throw new Error("worker client not initialized");
    return worker;
  },
}));
vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => false,
}));

function assertDisposable(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("privilege test refuses non-loopback databases");
  }
  if (parsed.port === "55432" || parsed.port === "5432" || parsed.port === "6543") {
    throw new Error("privilege test refuses the self-hosted production ports (55432/5432/6543)");
  }
}

function workerUrlFrom(url: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = "wag_agent_worker";
  parsed.password = password;
  return parsed.toString();
}

async function expectDenied(promise: Promise<unknown>, label: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `${label} must be denied`).not.toBeNull();
  const message = error instanceof Error ? error.message : String(error);
  expect(message, label).toMatch(/permission denied|must be owner|42501/i);
}

function jobFor(operation: AgentJobPayload["operation"], input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: `priv-exec-${operation}`,
    idempotencyKey: `priv-exec-${operation}`,
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "none",
      operation,
      input,
      origin: { source: "hermes_slack", correlationId: "c", requesterDigest: "r", threadDigest: "t" },
    },
    status: "RUNNING",
    workerId: "priv-worker",
    leaseExpiresAt: new Date(Date.now() + 120_000),
    heartbeatAt: new Date(),
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const python = { decideRoute: async () => ({ status: "ACCEPTED", route: "python", model: "python", reason: "deterministic" }) as const };

describe.skipIf(!enabled)("wag_agent_worker least-privilege (ephemeral PostgreSQL)", () => {
  const password = randomBytes(18).toString("base64url");
  let admin: PrismaClient;

  beforeAll(async () => {
    assertDisposable(adminUrl);
    admin = new PrismaClient({ datasourceUrl: adminUrl });
    await admin.$executeRawUnsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wag_agent_worker') THEN CREATE ROLE wag_agent_worker LOGIN; END IF; END $$;`,
    );
    await admin.$executeRawUnsafe(`ALTER ROLE wag_agent_worker WITH LOGIN PASSWORD '${password}'`);
    execFileSync("./node_modules/.bin/prisma", ["migrate", "deploy", "--schema", "prisma/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: adminUrl, DIRECT_URL: adminUrl },
      stdio: "pipe",
    });
    worker = new PrismaClient({ datasourceUrl: workerUrlFrom(adminUrl, password) });

    // Seed (admin) one partner/seller/deal/campaign for the executor run.
    await admin.$executeRawUnsafe(
      `INSERT INTO "Partner" ("id","name","type","businessNumber","createdAt","updatedAt") VALUES ('priv-partner-1','privilege partner','BRAND','123-45-67890',now(),now()) ON CONFLICT DO NOTHING`,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "Seller" ("id","name","snsType","snsHandle","agencyId","updatedAt") VALUES ('priv-seller-1','privilege seller','instagram','priv_handle','priv-partner-1',now()) ON CONFLICT DO NOTHING`,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "Deal" ("id","dealName","baseMarginPolicy","partnerId","updatedAt") VALUES ('priv-deal-1','privilege deal','FIXED','priv-partner-1',now()) ON CONFLICT DO NOTHING`,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "SalesCampaign" ("id","dealId","sellerId","startDate","endDate","salesChannel","baseNaverLink","generatedTrackingLink","actualSales","totalMarginRate","sellerMarginRate","updatedAt") VALUES ('priv-camp-1','priv-deal-1','priv-seller-1',now() - interval '3 days',now() + interval '7 days','naver','https://example.invalid/base','https://example.invalid/track',1000000,30,10,now()) ON CONFLICT DO NOTHING`,
    );
  }, 180_000);

  afterAll(async () => {
    await worker?.$disconnect();
    await admin?.$disconnect();
  });

  it("can SELECT the granted read scope and sees rows the app wrote (positive control)", async () => {
    await admin.$executeRawUnsafe(
      `INSERT INTO "AgentJob" ("id","idempotencyKey","payload","status","attempt","createdAt","updatedAt") VALUES ('priv-job-1','priv-key-1','{}'::jsonb,'FAILED_FINAL',0,now(),now()) ON CONFLICT DO NOTHING`,
    );
    const jobs = await worker!.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*)::bigint AS count FROM "AgentJob" WHERE "id" = 'priv-job-1'`);
    expect(Number(jobs[0].count)).toBe(1);

    for (const table of ["Deal", "Partner", "SalesCampaign", "Seller", "NaverOrderSnapshot", "CampaignGroup", "ActionProposal", "ActionProposalEvent", "AgentJobEvent"]) {
      await expect(worker!.$queryRawUnsafe(`SELECT count(*) FROM "${table}"`), table).resolves.toBeDefined();
    }
  });

  it("can INSERT and UPDATE AgentJob rows and INSERT proposal rows", async () => {
    await expect(
      worker!.$executeRawUnsafe(
        `INSERT INTO "AgentJob" ("id","idempotencyKey","payload","status","attempt","createdAt","updatedAt") VALUES ('priv-job-2','priv-key-2','{}'::jsonb,'FAILED_FINAL',0,now(),now())`,
      ),
    ).resolves.toBe(1);
    await expect(worker!.$executeRawUnsafe(`UPDATE "AgentJob" SET "workerId" = 'priv-worker' WHERE "id" = 'priv-job-2'`)).resolves.toBe(1);
    await expect(
      worker!.$executeRawUnsafe(`INSERT INTO "AgentJobEvent" ("id","jobId","fromStatus","toStatus","actor","eventCode") VALUES ('priv-evt-1','priv-job-2','QUEUED','CLAIMED','priv-worker','CLAIMED')`),
    ).resolves.toBe(1);
    await expect(
      worker!.$executeRawUnsafe(
        `INSERT INTO "ActionProposal" ("id","requestType","kind","status","title","reviewRequired","createdBy","createdAt","updatedAt") VALUES ('priv-prop-1','crm_mutation','WRITE','PENDING_APPROVAL','privilege probe',true,'AGENT_WORKER',now(),now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      worker!.$executeRawUnsafe(`INSERT INTO "ActionProposalEvent" ("id","proposalId","fromStatus","toStatus","actor") VALUES ('priv-pevt-1','priv-prop-1','DRAFT','PENDING_APPROVAL','AGENT_WORKER')`),
    ).resolves.toBe(1);
  });

  it("cannot UPDATE or DELETE proposals, nor approve through the database", async () => {
    await expectDenied(worker!.$executeRawUnsafe(`UPDATE "ActionProposal" SET "status" = 'APPROVED' WHERE "id" = 'priv-prop-1'`), "UPDATE ActionProposal");
    await expectDenied(worker!.$executeRawUnsafe(`DELETE FROM "ActionProposal" WHERE "id" = 'priv-prop-1'`), "DELETE ActionProposal");
    await expectDenied(worker!.$executeRawUnsafe(`DELETE FROM "AgentJob" WHERE "id" = 'priv-job-2'`), "DELETE AgentJob");
  });

  it("cannot UPDATE or DELETE domain tables", async () => {
    await expectDenied(worker!.$executeRawUnsafe(`UPDATE "Deal" SET "dealName" = 'x' WHERE false`), "UPDATE Deal");
    await expectDenied(worker!.$executeRawUnsafe(`DELETE FROM "Deal" WHERE false`), "DELETE Deal");
    await expectDenied(worker!.$executeRawUnsafe(`UPDATE "SalesCampaign" SET "status" = 'ACTIVE' WHERE false`), "UPDATE SalesCampaign");
    await expectDenied(worker!.$executeRawUnsafe(`DELETE FROM "SalesCampaign" WHERE false`), "DELETE SalesCampaign");
    await expectDenied(worker!.$executeRawUnsafe(`INSERT INTO "Deal" ("id","dealName","createdAt","updatedAt") VALUES ('priv-deal','x',now(),now())`), "INSERT Deal");
    await expectDenied(worker!.$executeRawUnsafe(`TRUNCATE "AgentJobEvent"`), "TRUNCATE AgentJobEvent");
  });

  it("cannot read tables outside the granted scope", async () => {
    await expectDenied(worker!.$queryRawUnsafe(`SELECT count(*) FROM "WorkRecord"`), "SELECT WorkRecord");
    await expectDenied(worker!.$queryRawUnsafe(`SELECT count(*) FROM "_prisma_migrations"`), "SELECT _prisma_migrations");
    for (const table of ["CampaignDeal", "CampaignChecklistItem", "CampaignNote", "CampaignActivity", "SellersHistory", "OrderCampaign"]) {
      await expectDenied(worker!.$queryRawUnsafe(`SELECT count(*) FROM "${table}"`), `SELECT ${table}`);
    }
  });

  it("cannot run schema DDL", async () => {
    await expectDenied(worker!.$executeRawUnsafe(`CREATE TABLE "wag_priv_probe" ("id" integer)`), "CREATE TABLE");
    await expectDenied(worker!.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN "privProbe" text`), "ALTER TABLE Deal");
    await expectDenied(worker!.$executeRawUnsafe(`DROP TABLE "AgentJobEvent"`), "DROP TABLE AgentJobEvent");
    await expectDenied(worker!.$executeRawUnsafe(`CREATE ROLE wag_priv_probe`), "CREATE ROLE");
  });

  it("runs all five executor operations as the worker role", async () => {
    const { executeAgentJob } = await import("@/lib/agent-worker/executor");

    const search = await executeAgentJob(jobFor("search_deals", { query: "privilege" }), python);
    expect(search).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: ["priv-deal-1"] } });

    const pipeline = await executeAgentJob(jobFor("get_pipeline_status", {}), python);
    expect(pipeline).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED" });

    const window = await executeAgentJob(
      jobFor("get_order_snapshot", { startAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), endAt: new Date().toISOString() }),
      python,
    );
    expect(window).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED" });

    const byCampaign = await executeAgentJob(jobFor("get_order_snapshot", { campaignId: "priv-camp-1" }), python);
    expect(byCampaign).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: ["priv-camp-1"] } });

    const financials = await executeAgentJob(jobFor("get_campaign_financials", { campaignId: "priv-camp-1" }), python);
    expect(financials).toMatchObject({ kind: "terminal", toStatus: "SUCCEEDED", result: { evidenceRefs: ["priv-camp-1"], modelUsed: "none" } });
    if (financials.kind !== "terminal") throw new Error("expected terminal");
    expect(financials.result.resultSummary).toMatch(/settlementSales/);

    const proposal = await executeAgentJob(
      jobFor("create_action_proposal", { action: "change_deal_status", dealId: "priv-deal-1", newStatus: "CONFIRMED" }),
      python,
    );
    expect(proposal).toMatchObject({ kind: "terminal", toStatus: "NEEDS_APPROVAL" });
    if (proposal.kind !== "terminal") throw new Error("expected terminal");
    const proposalId = proposal.result.actionProposalId;
    expect(proposalId).toBeTruthy();

    const rows = await admin.$queryRawUnsafe<Array<{ status: string; kind: string; createdBy: string; reviewRequired: boolean }>>(
      `SELECT "status","kind","createdBy","reviewRequired" FROM "ActionProposal" WHERE "id" = '${proposalId}'`,
    );
    expect(rows).toEqual([{ status: "PENDING_APPROVAL", kind: "WRITE", createdBy: "AGENT_WORKER", reviewRequired: true }]);
    const events = await admin.$queryRawUnsafe<Array<{ fromStatus: string | null; toStatus: string; actor: string }>>(
      `SELECT "fromStatus","toStatus","actor" FROM "ActionProposalEvent" WHERE "proposalId" = '${proposalId}'`,
    );
    expect(events).toEqual([{ fromStatus: "DRAFT", toStatus: "PENDING_APPROVAL", actor: "AGENT_WORKER" }]);
  }, 60_000);
});
