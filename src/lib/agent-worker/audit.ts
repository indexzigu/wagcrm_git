import { appendFileSync, mkdirSync, openSync, closeSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentJobPayload, AgentJobRoute } from "./contracts";

/**
 * Agent worker audit (plan Task 5, frozen field set).
 *
 * Only these fields are ever written. Raw input, raw result, prompts, tool output,
 * socket frames, and raw error messages never reach this module's output: the
 * record is rebuilt field by field from typed inputs and an error is reduced to
 * its class name.
 */
export const AGENT_WORKER_AUDIT_FIELDS = [
  "jobId",
  "taskType",
  "route",
  "model",
  "skill",
  "validationResult",
  "escalationReason",
  "correction",
  "startedAt",
  "finishedAt",
  "errorClass",
] as const;

const bounded = (max: number) => z.string().min(1).max(max);
const isoInstant = z.iso.datetime({ offset: false });

export const AgentWorkerAuditRecordSchema = z
  .object({
    jobId: bounded(128).nullable(),
    taskType: z.enum(["deterministic", "long_context", "bulk", "routine", "research"]).nullable(),
    route: z.enum(["python", "gemini", "gpt_luna", "director", "local_shadow", "local"]).nullable(),
    model: bounded(128).nullable(),
    skill: bounded(64).nullable(),
    validationResult: z.enum(["pass", "fail", "not_validated"]),
    escalationReason: bounded(64).nullable(),
    correction: z.boolean(),
    startedAt: isoInstant,
    finishedAt: isoInstant,
    errorClass: bounded(128).nullable(),
  })
  .strict();

export type AgentWorkerAuditRecord = z.infer<typeof AgentWorkerAuditRecordSchema>;

export type AuditJobInput = {
  job: { id: string; payload: Pick<AgentJobPayload, "taskType" | "skill"> };
  route: AgentJobRoute | null;
  model: string | null;
  validationResult: AgentWorkerAuditRecord["validationResult"];
  escalationReason: string | null;
  correction: boolean;
  startedAt: Date;
  finishedAt: Date;
  error?: unknown;
};

export type AuditSink = (line: string) => void;

export type AgentWorkerAuditLogger = {
  recordJob(input: AuditJobInput): void;
  recordConnectionRejected(errorClass: string, now?: Date): void;
  /** A claimed row whose stored payload failed validation and was finalized FAILED_SECURITY. */
  recordQuarantinedJob(jobId: string, errorClass: string, now?: Date): void;
};

/** Error class = the error's `name` only; messages are never propagated. */
export function errorClassOf(error: unknown): string {
  if (error instanceof Error && typeof error.name === "string" && error.name.trim().length > 0) {
    return error.name.slice(0, 128);
  }
  return "UnknownError";
}

function clip(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

export function createAuditLogger(sink: AuditSink): AgentWorkerAuditLogger {
  const emit = (candidate: AgentWorkerAuditRecord) => {
    const record = AgentWorkerAuditRecordSchema.parse(candidate);
    sink(JSON.stringify(record));
  };

  return {
    recordJob(input) {
      emit({
        jobId: input.job.id,
        taskType: input.job.payload.taskType,
        route: input.route,
        model: clip(input.model, 128),
        skill: clip(input.job.payload.skill, 64),
        validationResult: input.validationResult,
        escalationReason: clip(input.escalationReason, 64),
        correction: input.correction,
        startedAt: input.startedAt.toISOString(),
        finishedAt: input.finishedAt.toISOString(),
        errorClass: input.error === undefined || input.error === null ? null : errorClassOf(input.error),
      });
    },
    recordQuarantinedJob(jobId, errorClass, now = new Date()) {
      const at = now.toISOString();
      emit({
        jobId: clip(jobId, 128),
        taskType: null,
        route: null,
        model: null,
        skill: null,
        validationResult: "fail",
        escalationReason: null,
        correction: false,
        startedAt: at,
        finishedAt: at,
        errorClass: clip(errorClass, 128) ?? "UnknownError",
      });
    },
    recordConnectionRejected(errorClass, now = new Date()) {
      const at = now.toISOString();
      emit({
        jobId: null,
        taskType: null,
        route: null,
        model: null,
        skill: null,
        validationResult: "not_validated",
        escalationReason: null,
        correction: false,
        startedAt: at,
        finishedAt: at,
        errorClass: clip(errorClass, 128) ?? "UnknownError",
      });
    },
  };
}

/** Append-only JSONL sink; the file is created 0600 inside an existing 0700 directory. */
export function createFileAuditSink(filePath: string): AuditSink {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (!existsSync(filePath)) {
    closeSync(openSync(filePath, "a", 0o600));
  }
  chmodSync(filePath, 0o600);
  return (line) => {
    appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
  };
}
