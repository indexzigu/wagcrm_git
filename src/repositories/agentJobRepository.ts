import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import {
  AGENT_JOB_LEASE_MS,
  AGENT_JOB_MAX_ATTEMPTS,
  AgentJobPayloadSchema,
  AgentJobResultSchema,
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

export type AgentJobTransitionInput = {
  jobId: string;
  fromStatus: AgentJobStatus;
  toStatus: AgentJobStatus;
  actor: string;
  eventCode: string;
  result?: unknown;
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
      return { created: true, job };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const job = await prisma.agentJob.findUnique({ where: { idempotencyKey } });
      if (!job) {
        throw new Error(`AgentJob idempotency row disappeared: ${idempotencyKey}`);
      }
      return { created: false, job };
    }
  }

  static async claimNext(workerId: string, now = new Date()) {
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

      return { ...candidate, status: "CLAIMED", workerId, leaseExpiresAt, heartbeatAt: now };
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

  static async requeueRetryable(jobId: string, actor: string) {
    const prisma = getPrisma();

    return prisma.$transaction(async (tx) => {
      const candidate = await tx.agentJob.findFirst({
        where: { id: jobId, status: "FAILED_RETRYABLE" },
      });
      if (!candidate) {
        return null;
      }

      const nextAttempt = candidate.attempt + 1;
      const toStatus = nextAttempt >= AGENT_JOB_MAX_ATTEMPTS ? "FAILED_FINAL" : "QUEUED";
      const requeued = await tx.agentJob.updateMany({
        where: { id: jobId, status: "FAILED_RETRYABLE", attempt: candidate.attempt },
        data: {
          status: toStatus,
          workerId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          attempt: { increment: 1 },
        },
      });
      if (requeued.count !== 1) {
        return null;
      }

      await tx.agentJobEvent.create({
        data: agentJobEventData({
          jobId,
          fromStatus: "FAILED_RETRYABLE",
          toStatus,
          actor,
          eventCode: toStatus === "QUEUED" ? "RETRY_QUEUED" : "ATTEMPT_LIMIT_REACHED",
        }),
      });

      return { jobId, status: toStatus, attempt: nextAttempt };
    });
  }

  static async transition(input: AgentJobTransitionInput) {
    if (!isAgentJobTransitionAllowed(input.fromStatus, input.toStatus)) {
      throw new Error(`Illegal AgentJob transition: ${input.fromStatus} -> ${input.toStatus}`);
    }
    if (input.fromStatus === "FAILED_RETRYABLE" && input.toStatus === "QUEUED") {
      throw new Error("Use requeueRetryable to enforce the AgentJob attempt cap");
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
    const prisma = getPrisma();

    return prisma.$transaction(async (tx) => {
      const updated = await tx.agentJob.updateMany({
        where: { id: input.jobId, status: input.fromStatus },
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
    return getPrisma().agentJob.findUnique({ where: { id } });
  }
}

export type AgentJobTransactionClient = Prisma.TransactionClient;
