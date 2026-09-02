/**
 * Ephemeral PostgreSQL privilege check for the `wag_agent_worker` role (plan contract 5).
 *
 * Opt-in: set AGENT_WORKER_PRIVILEGE_TEST_ADMIN_URL to a superuser URL of a
 * disposable local PostgreSQL (for example a throw-away `postgres:17` container on a
 * random loopback port). The test creates the worker role, applies every Prisma
 * migration (so the grant block of the AgentJob migration runs for real), then probes
 * the role. It never reads the repository `.env` and refuses URLs that look like the
 * self-hosted production stack.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const adminUrl = process.env.AGENT_WORKER_PRIVILEGE_TEST_ADMIN_URL ?? "";
const enabled = adminUrl.length > 0;

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

describe.skipIf(!enabled)("wag_agent_worker least-privilege (ephemeral PostgreSQL)", () => {
  const password = randomBytes(18).toString("base64url");
  let admin: PrismaClient;
  let worker: PrismaClient;

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
  }, 180_000);

  afterAll(async () => {
    await worker?.$disconnect();
    await admin?.$disconnect();
  });

  it("can SELECT the granted read scope and sees rows the app wrote (positive control)", async () => {
    await admin.$executeRawUnsafe(
      `INSERT INTO "AgentJob" ("id","idempotencyKey","payload","status","attempt","createdAt","updatedAt") VALUES ('priv-job-1','priv-key-1','{}'::jsonb,'QUEUED',0,now(),now()) ON CONFLICT DO NOTHING`,
    );
    const jobs = await worker.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*)::bigint AS count FROM "AgentJob" WHERE "id" = 'priv-job-1'`);
    expect(Number(jobs[0].count)).toBe(1);

    for (const table of ["Deal", "Partner", "SalesCampaign", "Seller", "NaverOrderSnapshot", "CampaignGroup", "ActionProposal", "ActionProposalEvent", "AgentJobEvent"]) {
      await expect(worker.$queryRawUnsafe(`SELECT count(*) FROM "${table}"`), table).resolves.toBeDefined();
    }
  });

  it("can INSERT and UPDATE AgentJob rows and INSERT proposal rows", async () => {
    await expect(
      worker.$executeRawUnsafe(
        `INSERT INTO "AgentJob" ("id","idempotencyKey","payload","status","attempt","createdAt","updatedAt") VALUES ('priv-job-2','priv-key-2','{}'::jsonb,'QUEUED',0,now(),now())`,
      ),
    ).resolves.toBe(1);
    await expect(worker.$executeRawUnsafe(`UPDATE "AgentJob" SET "status" = 'CLAIMED', "workerId" = 'priv-worker' WHERE "id" = 'priv-job-2'`)).resolves.toBe(1);
    await expect(
      worker.$executeRawUnsafe(`INSERT INTO "AgentJobEvent" ("id","jobId","fromStatus","toStatus","actor","eventCode") VALUES ('priv-evt-1','priv-job-2','QUEUED','CLAIMED','priv-worker','CLAIMED')`),
    ).resolves.toBe(1);
    await expect(
      worker.$executeRawUnsafe(
        `INSERT INTO "ActionProposal" ("id","requestType","kind","status","title","reviewRequired","createdBy","createdAt","updatedAt") VALUES ('priv-prop-1','crm_mutation','WRITE','PENDING_APPROVAL','privilege probe',true,'AGENT_WORKER',now(),now())`,
      ),
    ).resolves.toBe(1);
    await expect(
      worker.$executeRawUnsafe(`INSERT INTO "ActionProposalEvent" ("id","proposalId","fromStatus","toStatus","actor") VALUES ('priv-pevt-1','priv-prop-1','DRAFT','PENDING_APPROVAL','AGENT_WORKER')`),
    ).resolves.toBe(1);
  });

  it("cannot UPDATE or DELETE proposals, nor approve through the database", async () => {
    await expectDenied(worker.$executeRawUnsafe(`UPDATE "ActionProposal" SET "status" = 'APPROVED' WHERE "id" = 'priv-prop-1'`), "UPDATE ActionProposal");
    await expectDenied(worker.$executeRawUnsafe(`DELETE FROM "ActionProposal" WHERE "id" = 'priv-prop-1'`), "DELETE ActionProposal");
    await expectDenied(worker.$executeRawUnsafe(`DELETE FROM "AgentJob" WHERE "id" = 'priv-job-2'`), "DELETE AgentJob");
  });

  it("cannot UPDATE or DELETE domain tables", async () => {
    await expectDenied(worker.$executeRawUnsafe(`UPDATE "Deal" SET "dealName" = 'x' WHERE false`), "UPDATE Deal");
    await expectDenied(worker.$executeRawUnsafe(`DELETE FROM "Deal" WHERE false`), "DELETE Deal");
    await expectDenied(worker.$executeRawUnsafe(`UPDATE "SalesCampaign" SET "status" = 'ACTIVE' WHERE false`), "UPDATE SalesCampaign");
    await expectDenied(worker.$executeRawUnsafe(`DELETE FROM "SalesCampaign" WHERE false`), "DELETE SalesCampaign");
    await expectDenied(worker.$executeRawUnsafe(`INSERT INTO "Deal" ("id","dealName","createdAt","updatedAt") VALUES ('priv-deal','x',now(),now())`), "INSERT Deal");
    await expectDenied(worker.$executeRawUnsafe(`TRUNCATE "AgentJobEvent"`), "TRUNCATE AgentJobEvent");
  });

  it("cannot read tables outside the granted scope", async () => {
    await expectDenied(worker.$queryRawUnsafe(`SELECT count(*) FROM "WorkRecord"`), "SELECT WorkRecord");
    await expectDenied(worker.$queryRawUnsafe(`SELECT count(*) FROM "_prisma_migrations"`), "SELECT _prisma_migrations");
  });

  it("cannot run schema DDL", async () => {
    await expectDenied(worker.$executeRawUnsafe(`CREATE TABLE "wag_priv_probe" ("id" integer)`), "CREATE TABLE");
    await expectDenied(worker.$executeRawUnsafe(`ALTER TABLE "Deal" ADD COLUMN "privProbe" text`), "ALTER TABLE Deal");
    await expectDenied(worker.$executeRawUnsafe(`DROP TABLE "AgentJobEvent"`), "DROP TABLE AgentJobEvent");
    await expectDenied(worker.$executeRawUnsafe(`CREATE ROLE wag_priv_probe`), "CREATE ROLE");
  });
});
