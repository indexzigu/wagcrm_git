import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentJobPayloadSchema, AgentJobResultSchema } from "@/lib/agent-worker/contracts";

type AgentJobRow = {
  id: string;
  idempotencyKey: string;
  payload: unknown;
  status: string;
  workerId: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  attempt: number;
  result: unknown;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AgentJobSqliteClient = {
  agentJob: {
    create(input: { data: Record<string, unknown> }): Promise<AgentJobRow>;
    findUnique(input: { where: { id: string } }): Promise<AgentJobRow | null>;
    findUniqueOrThrow(input: { where: { id: string } }): Promise<AgentJobRow>;
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<AgentJobRow>;
    deleteMany(input: Record<string, never>): Promise<unknown>;
  };
  agentJobEvent: {
    count(input: { where: { jobId: string } }): Promise<number>;
    deleteMany(input: Record<string, never>): Promise<unknown>;
  };
  $disconnect(): Promise<void>;
};

const repositoryRoot = process.cwd();
let temporaryDirectory: string;
let databasePath: string;
let realPrisma: AgentJobSqliteClient | undefined;

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => realPrisma,
}));

vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => true,
}));

function database(): AgentJobSqliteClient {
  if (!realPrisma) {
    throw new Error("SQLite test client was not initialized");
  }
  return realPrisma;
}

function payload() {
  return AgentJobPayloadSchema.parse({
    schemaVersion: 1,
    taskType: "routine",
    skill: "pipeline_status",
    operation: "get_pipeline_status",
    input: {},
    origin: {
      source: "hermes_slack",
      correlationId: "correlation-1",
      requesterDigest: "requester-digest",
      threadDigest: "thread-digest",
    },
  });
}

function result(jobId: string) {
  return AgentJobResultSchema.parse({
    schemaVersion: 1,
    jobId,
    status: "FAILED_FINAL",
    route: "gemini",
    modelUsed: "gemini",
    validationResult: "fail",
    resultSummary: "bounded failure summary",
    actionProposalId: null,
    evidenceRefs: ["evidence-1"],
  });
}

async function createJob(input: {
  status: string;
  workerId?: string | null;
  leaseExpiresAt?: Date | null;
  attempt?: number;
  resultValue?: unknown;
}) {
  return database().agentJob.create({
    data: {
      idempotencyKey: `${input.status}-${crypto.randomUUID()}`,
      payload: JSON.stringify(payload()),
      status: input.status,
      workerId: input.workerId ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      heartbeatAt: input.leaseExpiresAt ?? null,
      attempt: input.attempt ?? 0,
      result: input.resultValue ?? null,
    },
  });
}

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "wag-crm-agent-job-"));
  databasePath = join(temporaryDirectory, "agent-job.db");
  execFileSync(
    "npx",
    ["prisma", "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate", "--accept-data-loss"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
      stdio: "pipe",
    },
  );
  const generatedClientPath = join(repositoryRoot, "prisma", "generated", "prisma-sqlite", "index.js");
  const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
  realPrisma = new PrismaClient({ datasources: { db: { url: `file:${databasePath}` } } });
}, 30_000);

afterAll(async () => {
  await realPrisma?.$disconnect();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  await database().agentJobEvent.deleteMany({});
  await database().agentJob.deleteMany({});
});

describe("AgentJobRepository — SQLite lease and serialization regressions", () => {
  it("requeues a FAILED_RETRYABLE row whose worker died before requeue", async () => {
    const { AgentJobRepository } = await import("../agentJobRepository");
    const now = new Date("2026-09-05T00:00:00.000Z");
    const orphan = await createJob({
      status: "FAILED_RETRYABLE",
      workerId: "worker-a",
      leaseExpiresAt: new Date(now.getTime() - 1),
      attempt: 0,
    });

    const reclaimed = await AgentJobRepository.reclaimExpiredLease(now);
    const row = await database().agentJob.findUniqueOrThrow({ where: { id: orphan.id } });

    expect(reclaimed).toEqual({ jobId: orphan.id, status: "QUEUED", attempt: 1 });
    expect(row).toMatchObject({ status: "QUEUED", workerId: null, leaseExpiresAt: null, attempt: 1 });
    const claimed = await AgentJobRepository.claimNext("worker-b", new Date(now.getTime() + 1));
    expect(claimed?.id).toBe(orphan.id);
  });

  it("leaves a FAILED_RETRYABLE row alone while its worker still holds the lease", async () => {
    const { AgentJobRepository } = await import("../agentJobRepository");
    const now = new Date("2026-09-05T00:00:00.000Z");
    const inFlight = await createJob({
      status: "FAILED_RETRYABLE",
      workerId: "worker-a",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });

    expect(await AgentJobRepository.reclaimExpiredLease(now)).toBeNull();
    const row = await database().agentJob.findUniqueOrThrow({ where: { id: inFlight.id } });
    expect(row.status).toBe("FAILED_RETRYABLE");
  });

  it("rejects a stale worker after lease reclaim and a newer worker claim", async () => {
    const { AgentJobRepository, ConcurrentAgentJobModificationError } = await import("../agentJobRepository");
    const now = new Date("2026-09-02T00:00:00.000Z");
    const created = await createJob({
      status: "RUNNING",
      workerId: "worker-a",
      leaseExpiresAt: new Date(now.getTime() - 1),
    });

    await AgentJobRepository.reclaimExpiredLease(now);
    const claimed = await AgentJobRepository.claimNext("worker-b", new Date(now.getTime() + 1));
    if (!claimed) {
      throw new Error("worker-b failed to claim the reclaimed job");
    }
    await AgentJobRepository.transition({
      jobId: created.id,
      fromStatus: "CLAIMED",
      toStatus: "RUNNING",
      actor: "worker-b",
      eventCode: "STARTED",
      workerId: "worker-b",
      attempt: 1,
      now: new Date(now.getTime() + 1),
    });

    await expect(
      AgentJobRepository.transition({
        jobId: created.id,
        fromStatus: "RUNNING",
        toStatus: "SUCCEEDED",
        actor: "worker-a",
        eventCode: "STALE_SUCCESS",
        workerId: "worker-a",
        attempt: 0,
        now: new Date(now.getTime() + 1),
      }),
    ).rejects.toBeInstanceOf(ConcurrentAgentJobModificationError);

    const stored = await database().agentJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.status).toBe("RUNNING");
    expect(stored.workerId).toBe("worker-b");
    expect(stored.attempt).toBe(1);
    await expect(database().agentJobEvent.count({ where: { jobId: created.id } })).resolves.toBe(3);
  });

  it("uses one capped requeue path for every permitted source status", async () => {
    const { AgentJobRepository } = await import("../agentJobRepository");
    const now = new Date("2026-09-02T00:00:00.000Z");
    const requeueOrigins: Array<"CLAIMED" | "FAILED_RETRYABLE" | "RESOURCE_DEFERRED"> = [
      "CLAIMED",
      "FAILED_RETRYABLE",
      "RESOURCE_DEFERRED",
    ];

    for (const fromStatus of requeueOrigins) {
      const created = await createJob({
        status: fromStatus,
        workerId: "worker-1",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      });
      const requeued = await AgentJobRepository.requeue({
        jobId: created.id,
        fromStatus,
        actor: "worker-1",
        workerId: "worker-1",
        attempt: 0,
        now,
      });

      expect(requeued).toEqual({ jobId: created.id, status: "QUEUED", attempt: 1 });
      await expect(database().agentJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
        status: "QUEUED",
        workerId: null,
        leaseExpiresAt: null,
        attempt: 1,
      });

      const capped = await createJob({
        status: fromStatus,
        workerId: "worker-1",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        attempt: 2,
      });
      await expect(
        AgentJobRepository.requeue({
          jobId: capped.id,
          fromStatus,
          actor: "worker-1",
          workerId: "worker-1",
          attempt: 2,
          now,
        }),
      ).resolves.toEqual({ jobId: capped.id, status: "FAILED_FINAL", attempt: 3 });
    }
  });

  it("rejects an unlisted requeue source without changing its active lease", async () => {
    const { AgentJobRepository } = await import("../agentJobRepository");
    const now = new Date("2026-09-02T00:00:00.000Z");
    const created = await createJob({
      status: "RUNNING",
      workerId: "worker-1",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    const requeue = Reflect.get(AgentJobRepository, "requeue") as (input: unknown) => Promise<unknown>;

    await expect(
      requeue({
        jobId: created.id,
        fromStatus: "RUNNING",
        actor: "worker-1",
        workerId: "worker-1",
        attempt: 0,
        now,
      }),
    ).rejects.toThrow(/requeue source/);

    await expect(database().agentJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
      status: "RUNNING",
      workerId: "worker-1",
      attempt: 0,
    });
    await expect(database().agentJobEvent.count({ where: { jobId: created.id } })).resolves.toBe(0);
  });

  it("persists FAILED_SECURITY through an owned leased transition", async () => {
    const { AgentJobRepository } = await import("../agentJobRepository");
    const now = new Date("2026-09-02T00:00:00.000Z");
    const created = await createJob({
      status: "CLAIMED",
      workerId: "worker-1",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });

    await AgentJobRepository.transition({
      jobId: created.id,
      fromStatus: "CLAIMED",
      toStatus: "FAILED_SECURITY",
      actor: "worker-1",
      eventCode: "ROUTER_OUTPUT_REJECTED",
      workerId: "worker-1",
      attempt: 0,
      now,
    });

    await expect(database().agentJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
      status: "FAILED_SECURITY",
      workerId: null,
      leaseExpiresAt: null,
    });
    await expect(database().agentJobEvent.count({ where: { jobId: created.id } })).resolves.toBe(1);
  });

  it("normalizes SQLite payload and result values at the repository read boundary", async () => {
    const { AgentJobRepository } = await import("../agentJobRepository");
    const created = await createJob({
      status: "FAILED_FINAL",
      resultValue: JSON.stringify(result("placeholder")),
    });
    await database().agentJob.update({
      where: { id: created.id },
      data: { result: JSON.stringify(result(created.id)) },
    });

    const loaded = await AgentJobRepository.findById(created.id);
    expect(loaded?.payload).toEqual(payload());
    expect(loaded?.result).toEqual(result(created.id));
  });
});
