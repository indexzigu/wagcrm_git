import { z } from "zod";
import type { AgentJobRecord, AgentJobRepository } from "@/repositories/agentJobRepository";
import { AgentJobPayloadSchema } from "./contracts";
import { RpcError, type AgentWorkerRpcHandlers, type RpcContext } from "./socket-server";

/**
 * The five UDS methods (plan contract 6) over the Task 4 repository contract.
 *
 * Hermes never sends DB credentials or tokens: the only inputs are the bounded
 * AgentJob payload and opaque job ids. Responses carry only the bounded job view.
 */
export const WAIT_TIMEOUT_MS = 25_000;
export const WAIT_POLL_INTERVAL_MS = 500;

const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "NEEDS_APPROVAL",
  "NEEDS_EXTERNAL_EXECUTOR",
  "FAILED_FINAL",
  "FAILED_SECURITY",
]);

export type AgentJobQueue = Pick<typeof AgentJobRepository, "submit" | "findById">;

export type RpcHandlerOptions = {
  queue: AgentJobQueue;
  workerId: string;
  startedAt: Date;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  activeJobs?: () => number;
};

const submitParamsSchema = z.object({ payload: z.unknown() }).strict();
const jobIdParamsSchema = z.object({ jobId: z.string().trim().min(1).max(128) }).strict();

export type AgentJobView = {
  jobId: string;
  status: string;
  attempt: number;
  failureCode: string | null;
  result: AgentJobRecord["result"];
  createdAt: string;
  updatedAt: string;
};

function toView(job: AgentJobRecord): AgentJobView {
  return {
    jobId: job.id,
    status: job.status,
    attempt: job.attempt,
    failureCode: job.failureCode,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new RpcError("INVALID_PARAMS");
  return parsed.data;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createRpcHandlers(options: RpcHandlerOptions): AgentWorkerRpcHandlers {
  const now = options.now ?? (() => new Date());
  const waitTimeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS;

  const load = async (jobId: string): Promise<AgentJobRecord> => {
    const job = await options.queue.findById(jobId);
    if (!job) throw new RpcError("NOT_FOUND");
    return job;
  };

  return {
    async submit(params) {
      const { payload } = parseParams(submitParamsSchema, params);
      const parsedPayload = AgentJobPayloadSchema.safeParse(payload);
      if (!parsedPayload.success) throw new RpcError("INVALID_PAYLOAD");
      const submitted = await options.queue.submit(parsedPayload.data, now());
      return { jobId: submitted.job.id, created: submitted.created, status: submitted.job.status };
    },

    async get(params) {
      const { jobId } = parseParams(jobIdParamsSchema, params);
      return toView(await load(jobId));
    },

    async wait(params, context: RpcContext) {
      const { jobId } = parseParams(jobIdParamsSchema, params);
      const deadline = now().getTime() + waitTimeoutMs;
      for (;;) {
        const job = await load(jobId);
        const settled = TERMINAL_STATUSES.has(job.status);
        if (settled || context.signal.aborted || now().getTime() >= deadline) {
          return { ...toView(job), settled };
        }
        await sleep(pollIntervalMs, context.signal);
      }
    },

    async cancel_unclaimed(params) {
      parseParams(jobIdParamsSchema, params);
      // The frozen AgentJob state machine (plan contract 4 / Task 4) has no
      // QUEUED -> cancelled transition, so this method cannot be honored without a
      // Task 4 contract change. It fails closed instead of bypassing the repository.
      throw new RpcError("CANCEL_UNSUPPORTED_BY_QUEUE_CONTRACT");
    },

    async health() {
      return {
        ok: true,
        workerId: options.workerId,
        activeJobs: options.activeJobs?.() ?? 0,
        uptimeMs: Math.max(0, now().getTime() - options.startedAt.getTime()),
      };
    },
  };
}
