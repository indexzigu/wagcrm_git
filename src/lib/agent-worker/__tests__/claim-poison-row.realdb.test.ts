/**
 * Regression for Task 5 review HIGH-3 (Director ruling 12): one stored row whose
 * payload no longer parses must not stall the queue. Real SQLite, real
 * AgentJobRepository, real worker loop; only the executor is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentJobPayloadSchema } from "@/lib/agent-worker/contracts";
import type { ExecutionOutcome } from "@/lib/agent-worker/executor";

type SqliteClient = {
  agentJob: {
    create(input: { data: Record<string, unknown> }): Promise<{ id: string }>;
    findMany(input: { orderBy: { createdAt: "asc" } }): Promise<Array<{ id: string; status: string; attempt: number; failureCode: string | null }>>;
  };
  agentJobEvent: {
    findMany(input: { where: { jobId: string } }): Promise<Array<{ fromStatus: string | null; toStatus: string; eventCode: string }>>;
  };
  $disconnect(): Promise<void>;
};

const repositoryRoot = process.cwd();
let temporaryDirectory: string;
let realPrisma: SqliteClient | undefined;

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => realPrisma,
}));
vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => true,
}));

function database(): SqliteClient {
  if (!realPrisma) throw new Error("SQLite test client was not initialized");
  return realPrisma;
}

// requesterDigest varies per job: the idempotency key hashes operation+input+requester,
// not correlationId, so identical requesters would collapse into one queue row.
function validPayload(correlationId: string) {
  return AgentJobPayloadSchema.parse({
    schemaVersion: 1,
    taskType: "deterministic",
    skill: "none",
    operation: "get_pipeline_status",
    input: {},
    origin: { source: "hermes_slack", correlationId, requesterDigest: `requester-${correlationId}`, threadDigest: "t" },
  });
}

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "wag-crm-poison-"));
  const databasePath = join(temporaryDirectory, "poison.db");
  execFileSync(
    "npx",
    ["prisma", "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate", "--accept-data-loss"],
    { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: `file:${databasePath}` }, stdio: "pipe" },
  );
  const generatedClientPath = join(repositoryRoot, "prisma", "generated", "prisma-sqlite", "index.js");
  const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
  realPrisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
}, 30_000);

afterAll(async () => {
  await realPrisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("poison row quarantine", () => {
  it("finalizes the unparseable row as FAILED_SECURITY and still runs the five valid jobs queued behind it", async () => {
    const { AgentJobRepository } = await import("@/repositories/agentJobRepository");
    const { createWorkerLoop } = await import("@/lib/agent-worker/worker-loop");

    const poison = await database().agentJob.create({
      data: { idempotencyKey: "poison-key", payload: "{}", status: "QUEUED", attempt: 0 },
    });
    const validIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const submitted = await AgentJobRepository.submit(validPayload(`valid-${index}`));
      validIds.push(submitted.job.id);
    }

    const executed: string[] = [];
    const quarantined = vi.fn();
    const audit = { recordJob: vi.fn(), recordQuarantinedJob: quarantined };
    const loop = createWorkerLoop({
      repository: AgentJobRepository,
      workerId: "worker-poison-test",
      audit,
      pollIntervalMs: 20,
      execute: async (job): Promise<ExecutionOutcome> => {
        executed.push(job.id);
        return {
          kind: "terminal",
          toStatus: "SUCCEEDED",
          route: "python",
          model: "none",
          escalationReason: null,
          errorClass: null,
          result: {
            schemaVersion: 1,
            jobId: job.id,
            status: "SUCCEEDED",
            route: "python",
            modelUsed: "none",
            validationResult: "pass",
            resultSummary: "ok",
            actionProposalId: null,
            evidenceRefs: [],
          },
        };
      },
    });

    loop.start();
    const deadline = Date.now() + 10_000;
    while (executed.length < 5 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await loop.shutdown();

    expect(executed.sort()).toEqual([...validIds].sort());
    const rows = await database().agentJob.findMany({ orderBy: { createdAt: "asc" } });
    const poisonRow = rows.find((row) => row.id === poison.id);
    expect(poisonRow).toMatchObject({ status: "FAILED_SECURITY" });
    for (const id of validIds) {
      expect(rows.find((row) => row.id === id), id).toMatchObject({ status: "SUCCEEDED" });
    }
    const poisonEvents = await database().agentJobEvent.findMany({ where: { jobId: poison.id } });
    expect(poisonEvents.map((event) => event.eventCode)).toEqual(["CLAIMED", "PAYLOAD_INVALID"]);
    expect(quarantined).toHaveBeenCalledTimes(1);
    expect(quarantined).toHaveBeenCalledWith(poison.id, "ZodError", expect.any(Date));
    expect(audit.recordJob).toHaveBeenCalledTimes(5);
  }, 20_000);

  it("stamps ATTEMPTS_EXHAUSTED when the bounded requeue reaches the attempt cap", async () => {
    const { AgentJobRepository } = await import("@/repositories/agentJobRepository");
    const now = new Date();
    const capped = await database().agentJob.create({
      data: {
        idempotencyKey: "capped-key",
        payload: JSON.stringify(validPayload("capped")),
        status: "FAILED_RETRYABLE",
        workerId: "worker-cap",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        attempt: 2,
      },
    });

    await expect(
      AgentJobRepository.requeue({ jobId: capped.id, fromStatus: "FAILED_RETRYABLE", actor: "worker-cap", workerId: "worker-cap", attempt: 2, now }),
    ).resolves.toEqual({ jobId: capped.id, status: "FAILED_FINAL", attempt: 3 });
    const rows = await database().agentJob.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.find((row) => row.id === capped.id)).toMatchObject({ status: "FAILED_FINAL", failureCode: "ATTEMPTS_EXHAUSTED" });
  });
});
