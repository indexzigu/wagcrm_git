import type { AgentJobRecord, AgentJobRepository } from "@/repositories/agentJobRepository";
import {
  AGENT_JOB_HEARTBEAT_MS,
  AGENT_JOB_LEASE_MS,
  AGENT_JOB_MAX_ATTEMPTS,
  AGENT_JOB_MAX_RUNTIME_MS,
  type AgentJobRoute,
} from "./contracts";
import type { AgentWorkerAuditLogger } from "./audit";
import type { ExecutionOutcome } from "./executor";

/**
 * Durable processing loop over the Task 4 repository contract.
 *
 * concurrency 2 · heartbeat 30 s · lease 120 s · runtime timeout 300 s · max 3 attempts.
 * Every state change goes through `AgentJobRepository` (owner/attempt/lease CAS,
 * bounded requeue). Shutdown releases only leases this worker owns.
 */
export const DEFAULT_WORKER_CONCURRENCY = 2;
export const DEFAULT_WORKER_HEARTBEAT_MS = AGENT_JOB_HEARTBEAT_MS;
export const DEFAULT_WORKER_LEASE_MS = AGENT_JOB_LEASE_MS;
export const DEFAULT_WORKER_RUNTIME_TIMEOUT_MS = AGENT_JOB_MAX_RUNTIME_MS;
export const DEFAULT_WORKER_MAX_ATTEMPTS = AGENT_JOB_MAX_ATTEMPTS;
export const DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000;

export type WorkerLoopRepository = Pick<
  typeof AgentJobRepository,
  "claimNext" | "reclaimExpiredLease" | "heartbeat" | "requeue" | "transition"
>;

export type WorkerLoopOptions = {
  repository: WorkerLoopRepository;
  execute: (job: AgentJobRecord, signal: AbortSignal) => Promise<ExecutionOutcome>;
  audit: Pick<AgentWorkerAuditLogger, "recordJob" | "recordQuarantinedJob">;
  workerId: string;
  concurrency?: number;
  heartbeatMs?: number;
  runtimeTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  /** Receives only an error class for loop-level failures (claim/reclaim). */
  onLoopError?: (errorClass: string) => void;
  /**
   * Receives only an error class when the audit sink itself fails. The worker must
   * then shut down deliberately (fail closed) instead of dying on an unhandled
   * rejection (Task 5 review LOW-2).
   */
  onFatal?: (errorClass: string) => void;
};

export type WorkerLoop = {
  start(): void;
  shutdown(): Promise<void>;
  activeCount(): number;
};

class RuntimeTimeoutError extends Error {
  constructor() {
    super("agent job exceeded its runtime budget");
    this.name = "RuntimeTimeoutError";
  }
}

class LeaseLostError extends Error {
  constructor() {
    super("agent job lease is no longer owned by this worker");
    this.name = "LeaseLostError";
  }
}

class WorkerShutdownError extends Error {
  constructor() {
    super("worker is shutting down");
    this.name = "WorkerShutdownError";
  }
}

type ActiveJob = {
  job: AgentJobRecord;
  controller: AbortController;
  done: Promise<void>;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export function createWorkerLoop(options: WorkerLoopOptions): WorkerLoop {
  const now = options.now ?? (() => new Date());
  const concurrency = options.concurrency ?? DEFAULT_WORKER_CONCURRENCY;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_WORKER_HEARTBEAT_MS;
  const runtimeTimeoutMs = options.runtimeTimeoutMs ?? DEFAULT_WORKER_RUNTIME_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  const { repository, workerId } = options;

  const active = new Map<string, ActiveJob>();
  let stopping = false;
  const safeAudit = (write: () => void) => {
    try {
      write();
    } catch (error) {
      options.onFatal?.(errorName(error));
    }
  };
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const leaseIdentity = (job: AgentJobRecord) => ({ workerId, attempt: job.attempt, now: now() });

  const releaseRetryable = async (job: AgentJobRecord, eventCode: string) => {
    await repository.transition({
      jobId: job.id,
      fromStatus: "RUNNING",
      toStatus: "FAILED_RETRYABLE",
      actor: workerId,
      eventCode,
      ...leaseIdentity(job),
    });
    await repository.requeue({
      jobId: job.id,
      fromStatus: "FAILED_RETRYABLE",
      actor: workerId,
      ...leaseIdentity(job),
    });
  };

  const runJob = async (job: AgentJobRecord, controller: AbortController): Promise<void> => {
    const startedAt = now();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const abort = (reason: Error) => controller.abort(reason);
    const audit = (fields: {
      route: AgentJobRoute | null;
      model: string | null;
      validationResult: "pass" | "fail" | "not_validated";
      escalationReason: string | null;
      error?: unknown;
    }) =>
      safeAudit(() =>
        options.audit.recordJob({
          job,
          route: fields.route,
          model: fields.model,
          validationResult: fields.validationResult,
          escalationReason: fields.escalationReason,
          correction: false,
          startedAt,
          finishedAt: now(),
          error: fields.error,
        }),
      );

    try {
      await repository.transition({
        jobId: job.id,
        fromStatus: "CLAIMED",
        toStatus: "RUNNING",
        actor: workerId,
        eventCode: "STARTED",
        ...leaseIdentity(job),
      });

      heartbeat = setInterval(() => {
        void repository
          .heartbeat(job.id, workerId, now())
          .then((updated) => {
            if (updated.count !== 1) abort(new LeaseLostError());
          })
          .catch((error: unknown) => abort(error instanceof Error ? error : new Error(errorName(error))));
      }, heartbeatMs);
      timeout = setTimeout(() => abort(new RuntimeTimeoutError()), runtimeTimeoutMs);

      const outcome = await Promise.race<ExecutionOutcome>([
        options.execute(job, controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        }),
      ]);

      if (outcome.kind === "terminal") {
        await repository.transition({
          jobId: job.id,
          fromStatus: "RUNNING",
          toStatus: outcome.toStatus,
          actor: workerId,
          eventCode: outcome.toStatus,
          result: outcome.result,
          ...leaseIdentity(job),
        });
        audit({
          route: outcome.route,
          model: outcome.model,
          validationResult: outcome.result.validationResult,
          escalationReason: outcome.escalationReason,
          error: outcome.errorClass ? Object.assign(new Error(outcome.errorClass), { name: outcome.errorClass }) : undefined,
        });
        return;
      }
      if (outcome.kind === "security") {
        await repository.transition({
          jobId: job.id,
          fromStatus: "RUNNING",
          toStatus: "FAILED_SECURITY",
          actor: workerId,
          eventCode: outcome.errorClass,
          ...leaseIdentity(job),
        });
        audit({
          route: null,
          model: null,
          validationResult: "not_validated",
          escalationReason: null,
          error: Object.assign(new Error(outcome.errorClass), { name: outcome.errorClass }),
        });
        return;
      }
      await releaseRetryable(job, outcome.errorClass);
      audit({
        route: outcome.route,
        model: outcome.model,
        validationResult: "fail",
        escalationReason: null,
        error: Object.assign(new Error(outcome.errorClass), { name: outcome.errorClass }),
      });
    } catch (error) {
      // The abort reason (timeout / lease lost / shutdown) outranks whatever the
      // executor threw while unwinding from that abort.
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
      if (reason instanceof LeaseLostError) {
        // The lease belongs to someone else now; no state write is ours to make.
        audit({ route: null, model: null, validationResult: "not_validated", escalationReason: null, error: reason });
        return;
      }
      if (reason instanceof RuntimeTimeoutError || reason instanceof WorkerShutdownError) {
        const eventCode = reason instanceof RuntimeTimeoutError ? "RUNTIME_TIMEOUT" : "WORKER_SHUTDOWN";
        try {
          await releaseRetryable(job, eventCode);
        } catch (releaseError) {
          audit({ route: null, model: null, validationResult: "not_validated", escalationReason: null, error: releaseError });
          return;
        }
        audit({ route: null, model: null, validationResult: "not_validated", escalationReason: null, error: reason });
        return;
      }
      // Any other failure (including ConcurrentAgentJobModificationError on the
      // terminal write) is surfaced by class; the lease CAS already protected the row.
      audit({ route: null, model: null, validationResult: "not_validated", escalationReason: null, error: reason });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
    }
  };

  const launch = (job: AgentJobRecord) => {
    const controller = new AbortController();
    const entry: ActiveJob = {
      job,
      controller,
      done: runJob(job, controller).finally(() => {
        active.delete(job.id);
      }),
    };
    active.set(job.id, entry);
  };

  const tick = async () => {
    if (stopping) return;
    try {
      await repository.reclaimExpiredLease(now());
      while (!stopping && active.size < concurrency) {
        const job = await repository.claimNext(workerId, now(), (jobId, errorClass) =>
          safeAudit(() => options.audit.recordQuarantinedJob(jobId, errorClass, now())),
        );
        if (!job) break;
        launch(job);
      }
    } catch (error) {
      options.onLoopError?.(errorName(error));
    }
    if (!stopping) pollTimer = setTimeout(() => void tick(), pollIntervalMs);
  };

  return {
    start() {
      if (pollTimer !== null || stopping) return;
      pollTimer = setTimeout(() => void tick(), 0);
    },
    async shutdown() {
      stopping = true;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      const pending = [...active.values()];
      for (const entry of pending) {
        entry.controller.abort(new WorkerShutdownError());
      }
      await Promise.allSettled(pending.map((entry) => entry.done));
    },
    activeCount: () => active.size,
  };
}
