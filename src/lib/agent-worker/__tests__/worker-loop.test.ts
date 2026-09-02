import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_JOB_HEARTBEAT_MS,
  AGENT_JOB_LEASE_MS,
  AGENT_JOB_MAX_ATTEMPTS,
  AGENT_JOB_MAX_RUNTIME_MS,
} from "../contracts";
import { ConcurrentAgentJobModificationError, type AgentJobRecord } from "@/repositories/agentJobRepository";
import type { ExecutionOutcome } from "../executor";
import {
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_WORKER_HEARTBEAT_MS,
  DEFAULT_WORKER_LEASE_MS,
  DEFAULT_WORKER_MAX_ATTEMPTS,
  DEFAULT_WORKER_RUNTIME_TIMEOUT_MS,
  createWorkerLoop,
  type WorkerLoopRepository,
} from "../worker-loop";

function job(id: string, attempt = 0): AgentJobRecord {
  return {
    id,
    idempotencyKey: `key-${id}`,
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "none",
      operation: "get_pipeline_status",
      input: {},
      origin: { source: "hermes_slack", correlationId: "c", requesterDigest: "r", threadDigest: "t" },
    },
    status: "CLAIMED",
    workerId: "worker-1",
    leaseExpiresAt: new Date(Date.now() + AGENT_JOB_LEASE_MS),
    heartbeatAt: new Date(),
    attempt,
    result: null,
    failureCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function succeeded(id: string): ExecutionOutcome {
  return {
    kind: "terminal",
    toStatus: "SUCCEEDED",
    route: "python",
    model: "python",
    escalationReason: null,
    errorClass: null,
    result: {
      schemaVersion: 1,
      jobId: id,
      status: "SUCCEEDED",
      route: "python",
      modelUsed: "python",
      validationResult: "pass",
      resultSummary: "ok",
      actionProposalId: null,
      evidenceRefs: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function build(queue: AgentJobRecord[], execute: ReturnType<typeof vi.fn>) {
  const repository = {
    claimNext: vi.fn(async () => queue.shift() ?? null),
    reclaimExpiredLease: vi.fn(async () => null),
    heartbeat: vi.fn(async () => ({ count: 1 })),
    requeue: vi.fn(async (input: { jobId: string; attempt: number }) => ({ jobId: input.jobId, status: "QUEUED" as const, attempt: input.attempt + 1 })),
    transition: vi.fn(async (input: { jobId: string; toStatus: string }) => ({ jobId: input.jobId, status: input.toStatus })),
  };
  const audit = { recordJob: vi.fn() };
  const loop = createWorkerLoop({
    repository: repository as unknown as WorkerLoopRepository,
    execute: execute as never,
    audit,
    workerId: "worker-1",
    pollIntervalMs: 1_000,
  });
  return { repository, audit, loop };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("worker loop defaults", () => {
  it("pins the frozen concurrency, heartbeat, lease, runtime timeout, and attempt cap", () => {
    expect(DEFAULT_WORKER_CONCURRENCY).toBe(2);
    expect(DEFAULT_WORKER_HEARTBEAT_MS).toBe(30_000);
    expect(DEFAULT_WORKER_HEARTBEAT_MS).toBe(AGENT_JOB_HEARTBEAT_MS);
    expect(DEFAULT_WORKER_LEASE_MS).toBe(120_000);
    expect(DEFAULT_WORKER_LEASE_MS).toBe(AGENT_JOB_LEASE_MS);
    expect(DEFAULT_WORKER_RUNTIME_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_WORKER_RUNTIME_TIMEOUT_MS).toBe(AGENT_JOB_MAX_RUNTIME_MS);
    expect(DEFAULT_WORKER_MAX_ATTEMPTS).toBe(3);
    expect(DEFAULT_WORKER_MAX_ATTEMPTS).toBe(AGENT_JOB_MAX_ATTEMPTS);
  });
});

describe("worker loop durable processing", () => {
  it("claims at most two jobs concurrently and picks up the third only after one finishes", async () => {
    const first = deferred<ExecutionOutcome>();
    const execute = vi.fn((current: AgentJobRecord) => (current.id === "a" ? first.promise : new Promise<ExecutionOutcome>(() => {})));
    const { repository, loop } = build([job("a"), job("b"), job("c")], execute);

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(repository.claimNext).toHaveBeenCalledTimes(2);
    expect(loop.activeCount()).toBe(2);
    expect(repository.reclaimExpiredLease).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(repository.claimNext).toHaveBeenCalledTimes(2);

    first.resolve(succeeded("a"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(repository.claimNext).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(3);
    await loop.shutdown();
  });

  it("moves an owned job CLAIMED -> RUNNING -> SUCCEEDED through the leased CAS contract and audits it", async () => {
    const execute = vi.fn(async () => succeeded("a"));
    const { repository, audit, loop } = build([job("a", 1)], execute);

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(repository.transition).toHaveBeenNthCalledWith(1, expect.objectContaining({ jobId: "a", fromStatus: "CLAIMED", toStatus: "RUNNING", workerId: "worker-1", attempt: 1, eventCode: "STARTED" }));
    expect(repository.transition).toHaveBeenNthCalledWith(2, expect.objectContaining({ jobId: "a", fromStatus: "RUNNING", toStatus: "SUCCEEDED", workerId: "worker-1", attempt: 1, result: expect.objectContaining({ status: "SUCCEEDED" }) }));
    expect(audit.recordJob).toHaveBeenCalledWith(expect.objectContaining({ job: expect.objectContaining({ id: "a" }), route: "python", model: "python", validationResult: "pass", correction: false }));
    await loop.shutdown();
  });

  it("heartbeats every 30 s while a job runs and stops afterwards", async () => {
    const pending = deferred<ExecutionOutcome>();
    const execute = vi.fn(() => pending.promise);
    const { repository, loop } = build([job("a")], execute);

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(AGENT_JOB_HEARTBEAT_MS);
    expect(repository.heartbeat).toHaveBeenCalledTimes(1);
    expect(repository.heartbeat).toHaveBeenCalledWith("a", "worker-1", expect.any(Date));
    await vi.advanceTimersByTimeAsync(AGENT_JOB_HEARTBEAT_MS);
    expect(repository.heartbeat).toHaveBeenCalledTimes(2);

    pending.resolve(succeeded("a"));
    await vi.advanceTimersByTimeAsync(AGENT_JOB_HEARTBEAT_MS * 3);
    expect(repository.heartbeat).toHaveBeenCalledTimes(2);
    await loop.shutdown();
  });

  it("aborts at the 300 s runtime timeout and requeues through the bounded retry contract", async () => {
    const execute = vi.fn((_job: AgentJobRecord, signal: AbortSignal) =>
      new Promise<ExecutionOutcome>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    const { repository, audit, loop } = build([job("a")], execute);

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(AGENT_JOB_MAX_RUNTIME_MS);

    expect(repository.transition).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "a", fromStatus: "RUNNING", toStatus: "FAILED_RETRYABLE", eventCode: "RUNTIME_TIMEOUT", workerId: "worker-1", attempt: 0 }));
    expect(repository.requeue).toHaveBeenCalledWith(expect.objectContaining({ jobId: "a", fromStatus: "FAILED_RETRYABLE", workerId: "worker-1", attempt: 0, actor: "worker-1" }));
    expect(audit.recordJob).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ name: "RuntimeTimeoutError" }) }));
    await loop.shutdown();
  });

  it("turns a retryable outcome into FAILED_RETRYABLE plus requeue", async () => {
    const execute = vi.fn(async () => ({ kind: "retryable", errorClass: "QUERY_FAILED", route: "python", model: "python" }) as ExecutionOutcome);
    const { repository, loop } = build([job("a", 2)], execute);

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(repository.transition).toHaveBeenLastCalledWith(expect.objectContaining({ fromStatus: "RUNNING", toStatus: "FAILED_RETRYABLE", eventCode: "QUERY_FAILED", attempt: 2 }));
    expect(repository.requeue).toHaveBeenCalledWith(expect.objectContaining({ jobId: "a", fromStatus: "FAILED_RETRYABLE", attempt: 2 }));
    await loop.shutdown();
  });

  it("persists a security outcome as FAILED_SECURITY without requeue", async () => {
    const execute = vi.fn(async () => ({ kind: "security", errorClass: "ROUTER_REJECTED" }) as ExecutionOutcome);
    const { repository, loop } = build([job("a")], execute);

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(repository.transition).toHaveBeenLastCalledWith(expect.objectContaining({ fromStatus: "RUNNING", toStatus: "FAILED_SECURITY", eventCode: "ROUTER_REJECTED" }));
    expect(repository.requeue).not.toHaveBeenCalled();
    await loop.shutdown();
  });

  it("stops the job when a heartbeat shows the lease is no longer owned", async () => {
    const execute = vi.fn((_job: AgentJobRecord, signal: AbortSignal) =>
      new Promise<ExecutionOutcome>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    const { repository, audit, loop } = build([job("a")], execute);
    repository.heartbeat.mockResolvedValue({ count: 0 });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(AGENT_JOB_HEARTBEAT_MS);

    expect(repository.transition).toHaveBeenCalledTimes(1);
    expect(repository.requeue).not.toHaveBeenCalled();
    expect(audit.recordJob).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ name: "LeaseLostError" }) }));
    expect(loop.activeCount()).toBe(0);
    await loop.shutdown();
  });

  it("swallows nothing: a concurrent-modification rejection on the terminal write is audited as its error class", async () => {
    const execute = vi.fn(async () => succeeded("a"));
    const { repository, audit, loop } = build([job("a")], execute);
    repository.transition.mockImplementation(async (input: { jobId: string; toStatus: string }) => {
      if (input.toStatus === "SUCCEEDED") throw new ConcurrentAgentJobModificationError(input.jobId);
      return { jobId: input.jobId, status: input.toStatus };
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(audit.recordJob).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ name: "ConcurrentAgentJobModificationError" }) }));
    expect(loop.activeCount()).toBe(0);
    await loop.shutdown();
  });

  it("shutdown releases only the leases this worker owns and stops claiming", async () => {
    const execute = vi.fn((_job: AgentJobRecord, signal: AbortSignal) =>
      new Promise<ExecutionOutcome>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    const { repository, loop } = build([job("a", 1)], execute);

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.activeCount()).toBe(1);
    const claimsBeforeShutdown = repository.claimNext.mock.calls.length;

    const shutdown = loop.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    await shutdown;

    expect(repository.transition).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "a", fromStatus: "RUNNING", toStatus: "FAILED_RETRYABLE", eventCode: "WORKER_SHUTDOWN", workerId: "worker-1", attempt: 1 }));
    expect(repository.requeue).toHaveBeenCalledTimes(1);
    expect(repository.requeue).toHaveBeenCalledWith(expect.objectContaining({ jobId: "a", workerId: "worker-1", attempt: 1 }));
    expect(loop.activeCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(repository.claimNext).toHaveBeenCalledTimes(claimsBeforeShutdown);
  });
});
