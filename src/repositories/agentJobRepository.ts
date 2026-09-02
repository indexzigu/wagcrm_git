import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import {
  AGENT_JOB_LEASE_MS,
  AGENT_JOB_MAX_ATTEMPTS,
  AgentJobPayloadSchema,
  AgentJobResultSchema,
  type AgentJobPayload,
  type AgentJobResult,
  type AgentJobStatus,
  createAgentJobIdempotencyKey,
  isAgentJobTransitionAllowed,
  serializeAgentJobJson,
} from "@/lib/agent-worker/contracts";
import type { Prisma } from "@prisma/client";

type AgentJobEventInput = {
  jobId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  eventCode: string;
};

type AgentJobTransitionBase = {
  jobId: string;
  toStatus: AgentJobStatus;
  actor: string;
  eventCode: string;
  result?: unknown;
};

type LeasedAgentJobTransitionInput = AgentJobTransitionBase & {
  fromStatus: "CLAIMED" | "RUNNING";
  workerId: string;
  attempt: number;
  now: Date;
};

type NonLeasedAgentJobTransitionInput = AgentJobTransitionBase & {
  fromStatus: Exclude<AgentJobStatus, "CLAIMED" | "RUNNING">;
};

export type AgentJobTransitionInput =
  | LeasedAgentJobTransitionInput
  | NonLeasedAgentJobTransitionInput;

export type AgentJobRequeueInput = {
  jobId: string;
  fromStatus: "CLAIMED" | "FAILED_RETRYABLE" | "RESOURCE_DEFERRED";
  actor: string;
  workerId: string;
  attempt: number;
  now: Date;
};

type PersistedAgentJob = {
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

export type AgentJobRecord = Omit<PersistedAgentJob, "payload" | "result"> & {
  payload: AgentJobPayload;
  result: AgentJobResult | null;
};

export class ConcurrentAgentJobModificationError extends Error {
  constructor(jobId: string) {
    super(`AgentJob ${jobId} was modified concurrently`);
    this.name = "ConcurrentAgentJobModificationError";
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function agentJobEventData(input: AgentJobEventInput) {
  return {
    jobId: input.jobId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actor: input.actor,
    eventCode: input.eventCode,
  };
}

function parseStoredJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function parseStoredPayload(value: unknown): AgentJobPayload {
  const payload = AgentJobPayloadSchema.parse(parseStoredJson(value));
  serializeAgentJobJson(payload, false);
  return payload;
}

function parseStoredResult(value: unknown): AgentJobResult | null {
  if (value === null) {
    return null;
  }
  const result = AgentJobResultSchema.parse(parseStoredJson(value));
  serializeAgentJobJson(result, false);
  return result;
}

function normalizeAgentJob(job: PersistedAgentJob): AgentJobRecord {
  return {
    id: job.id,
    idempotencyKey: job.idempotencyKey,
    payload: parseStoredPayload(job.payload),
    status: job.status,
    workerId: job.workerId,
    leaseExpiresAt: job.leaseExpiresAt,
    heartbeatAt: job.heartbeatAt,
    attempt: job.attempt,
    result: parseStoredResult(job.result),
    failureCode: job.failureCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function isValidLeaseInput(input: {
  workerId: string;
  attempt: number;
  now: Date;
}): boolean {
  return (
    input.workerId.trim().length > 0 &&
    Number.isInteger(input.attempt) &&
    input.attempt >= 0 &&
    Number.isFinite(input.now.getTime())
  );
}

function isRequeueOrigin(status: string): status is AgentJobRequeueInput["fromStatus"] {
  return status === "CLAIMED" || status === "FAILED_RETRYABLE" || status === "RESOURCE_DEFERRED";
}

export class AgentJobRepository {
  static async submit(payload: unknown, now = new Date()) {
    const parsedPayload = AgentJobPayloadSchema.parse(payload);
    const idempotencyKey = createAgentJobIdempotencyKey(parsedPayload, now);
    const prisma = getPrisma();

    try {
      const job = await prisma.agentJob.create({
        data: {
          idempotencyKey,
          payload: serializeAgentJobJson(parsedPayload, isSqliteDatabaseUrl()),
        },
      });
      return { created: true, job: normalizeAgentJob(job) };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const job = await prisma.agentJob.findUnique({ where: { idempotencyKey } });
      if (!job) {
        throw new Error(`AgentJob idempotency row disappeared: ${idempotencyKey}`);
      }
      return { created: false, job: normalizeAgentJob(job) };
    }
  }

  /**
   * Claims the oldest eligible QUEUED row through the status+lease CAS and only then
   * normalizes its payload. A row whose stored payload no longer parses (a poison row)
   * is finalized CLAIMED -> FAILED_SECURITY with an event through the same leased CAS,
   * reported via `onQuarantined` (error class only) and skipped, so one bad row can
   * never stall the queue (Task 5 review HIGH-3, Director ruling 12).
   */
  static async claimNext(
    workerId: string,
    now = new Date(),
    onQuarantined?: (jobId: string, errorClass: string) => void,
  ) {
    const claimed = await AgentJobRepository.claimNextRaw(workerId, now);
    if (!claimed) {
      return null;
    }
    try {
      return normalizeAgentJob(claimed);
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : "UnknownError";
      await AgentJobRepository.transition({
        jobId: claimed.id,
        fromStatus: "CLAIMED",
        toStatus: "FAILED_SECURITY",
        actor: workerId,
        eventCode: "PAYLOAD_INVALID",
        workerId,
        attempt: claimed.attempt,
        now,
      });
      onQuarantined?.(claimed.id, errorClass);
      return null;
    }
  }

  private static async claimNextRaw(workerId: string, now: Date): Promise<PersistedAgentJob | null> {
    const leaseExpiresAt = new Date(now.getTime() + AGENT_JOB_LEASE_MS);
    const prisma = getPrisma();

    return prisma.$transaction(async (tx) => {
      const candidate = await tx.agentJob.findFirst({
        where: {
          status: "QUEUED",
          leaseExpiresAt: null,
          attempt: { lt: AGENT_JOB_MAX_ATTEMPTS },
        },
        orderBy: { createdAt: "asc" },
      });
      if (!candidate) {
        return null;
      }

      const claim = await tx.agentJob.updateMany({
        where: {
          id: candidate.id,
          status: "QUEUED",
          leaseExpiresAt: null,
          attempt: { lt: AGENT_JOB_MAX_ATTEMPTS },
        },
        data: {
          status: "CLAIMED",
          workerId,
          leaseExpiresAt,
          heartbeatAt: now,
        },
      });
      if (claim.count !== 1) {
        return null;
      }

      await tx.agentJobEvent.create({
        data: agentJobEventData({
          jobId: candidate.id,
          fromStatus: "QUEUED",
          toStatus: "CLAIMED",
          actor: workerId,
          eventCode: "CLAIMED",
        }),
      });

      return {
        ...candidate,
        status: "CLAIMED",
        workerId,
        leaseExpiresAt,
        heartbeatAt: now,
      };
    });
  }

  static async reclaimExpiredLease(now = new Date()) {
    const prisma = getPrisma();

    return prisma.$transaction(async (tx) => {
      const candidate = await tx.agentJob.findFirst({
        where: {
          status: { in: ["CLAIMED", "RUNNING"] },
          leaseExpiresAt: { lt: now },
        },
        orderBy: { leaseExpiresAt: "asc" },
      });
      if (!candidate) {
        return null;
      }

      const nextAttempt = candidate.attempt + 1;
      const toStatus = nextAttempt >= AGENT_JOB_MAX_ATTEMPTS ? "FAILED_FINAL" : "QUEUED";
      const reclaimed = await tx.agentJob.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attempt: candidate.attempt,
          leaseExpiresAt: { lt: now },
        },
        data: {
          status: toStatus,
          workerId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          attempt: { increment: 1 },
          failureCode: "LEASE_EXPIRED",
        },
      });
      if (reclaimed.count !== 1) {
        return null;
      }

      await tx.agentJobEvent.create({
        data: agentJobEventData({
          jobId: candidate.id,
          fromStatus: candidate.status,
          toStatus,
          actor: "SYSTEM",
          eventCode: "LEASE_EXPIRED",
        }),
      });

      return { jobId: candidate.id, status: toStatus, attempt: nextAttempt };
    });
  }

  static async heartbeat(jobId: string, workerId: string, now = new Date()) {
    return getPrisma().agentJob.updateMany({
      where: {
        id: jobId,
        workerId,
        status: { in: ["CLAIMED", "RUNNING"] },
        leaseExpiresAt: { gt: now },
      },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + AGENT_JOB_LEASE_MS),
      },
    });
  }

  static async requeue(input: AgentJobRequeueInput) {
    if (!isRequeueOrigin(input.fromStatus)) {
      throw new Error("AgentJob requeue source is not allowed");
    }
    if (!isValidLeaseInput(input)) {
      throw new Error("AgentJob requeue requires a valid current lease identity");
    }
    const prisma = getPrisma();

    return prisma.$transaction(async (tx) => {
      const candidate = await tx.agentJob.findFirst({
        where: {
          id: input.jobId,
          status: input.fromStatus,
          workerId: input.workerId,
          attempt: input.attempt,
          leaseExpiresAt: { gt: input.now },
        },
      });
      if (!candidate) {
        return null;
      }

      const nextAttempt = candidate.attempt + 1;
      const toStatus = nextAttempt >= AGENT_JOB_MAX_ATTEMPTS ? "FAILED_FINAL" : "QUEUED";
      const requeued = await tx.agentJob.updateMany({
        where: {
          id: input.jobId,
          status: input.fromStatus,
          workerId: input.workerId,
          attempt: input.attempt,
          leaseExpiresAt: { gt: input.now },
        },
        data: {
          status: toStatus,
          workerId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          attempt: { increment: 1 },
          ...(toStatus === "FAILED_FINAL" ? { failureCode: "ATTEMPTS_EXHAUSTED" } : {}),
        },
      });
      if (requeued.count !== 1) {
        return null;
      }

      await tx.agentJobEvent.create({
        data: agentJobEventData({
          jobId: input.jobId,
          fromStatus: input.fromStatus,
          toStatus,
          actor: input.actor,
          eventCode: toStatus === "QUEUED" ? "RETRY_QUEUED" : "ATTEMPT_LIMIT_REACHED",
        }),
      });

      return { jobId: input.jobId, status: toStatus, attempt: nextAttempt };
    });
  }

  static async transition(input: AgentJobTransitionInput) {
    if (!isAgentJobTransitionAllowed(input.fromStatus, input.toStatus)) {
      throw new Error(`Illegal AgentJob transition: ${input.fromStatus} -> ${input.toStatus}`);
    }
    if (
      (input.fromStatus === "CLAIMED" || input.fromStatus === "RUNNING") &&
      !isValidLeaseInput(input)
    ) {
      throw new Error("AgentJob leased transition requires a valid current lease identity");
    }

    const parsedResult = input.result === undefined ? undefined : AgentJobResultSchema.parse(input.result);
    if (parsedResult && (parsedResult.jobId !== input.jobId || parsedResult.status !== input.toStatus)) {
      throw new Error("AgentJob result does not match the requested terminal transition");
    }

    const queueRelease = input.toStatus === "QUEUED";
    const terminal = [
      "SUCCEEDED",
      "NEEDS_APPROVAL",
      "NEEDS_EXTERNAL_EXECUTOR",
      "FAILED_FINAL",
      "FAILED_SECURITY",
    ].some((status) => status === input.toStatus);

    const result = parsedResult
      ? serializeAgentJobJson(parsedResult, isSqliteDatabaseUrl())
      : undefined;
    const leaseWhere =
      input.fromStatus === "CLAIMED" || input.fromStatus === "RUNNING"
        ? {
            workerId: input.workerId,
            attempt: input.attempt,
            leaseExpiresAt: { gt: input.now },
          }
        : {};
    const prisma = getPrisma();

    return prisma.$transaction(async (tx) => {
      const updated = await tx.agentJob.updateMany({
        where: { id: input.jobId, status: input.fromStatus, ...leaseWhere },
        data: {
          status: input.toStatus,
          ...(result === undefined ? {} : { result }),
          ...(queueRelease || terminal
            ? { workerId: null, leaseExpiresAt: null, heartbeatAt: null }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new ConcurrentAgentJobModificationError(input.jobId);
      }

      await tx.agentJobEvent.create({
        data: agentJobEventData({
          jobId: input.jobId,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          actor: input.actor,
          eventCode: input.eventCode,
        }),
      });

      return { jobId: input.jobId, status: input.toStatus };
    });
  }

  static async findById(id: string) {
    const job = await getPrisma().agentJob.findUnique({ where: { id } });
    return job ? normalizeAgentJob(job) : null;
  }
}

export type AgentJobTransactionClient = Prisma.TransactionClient;
