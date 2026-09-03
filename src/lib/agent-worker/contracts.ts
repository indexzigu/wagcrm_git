import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";

export const AGENT_JOB_LEASE_MS = 120_000;
export const AGENT_JOB_HEARTBEAT_MS = 30_000;
export const AGENT_JOB_MAX_ATTEMPTS = 3;
export const AGENT_JOB_MAX_RUNTIME_MS = 300_000;
export const AGENT_JOB_IDEMPOTENCY_BUCKET_MS = 10 * 60_000;
export const MAX_RESULT_SUMMARY_CHARS = 2_000;
export const MAX_EVIDENCE_REFS = 10;
export const MAX_AGENT_JOB_JSON_BYTES = 16 * 1024;

export const AgentJobStatusSchema = z.enum([
  "QUEUED",
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "NEEDS_APPROVAL",
  "NEEDS_EXTERNAL_EXECUTOR",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "RESOURCE_DEFERRED",
  "FAILED_SECURITY",
]);

export type AgentJobStatus = z.infer<typeof AgentJobStatusSchema>;

export const AgentJobTaskTypeSchema = z.enum([
  "deterministic",
  "long_context",
  "bulk",
  "routine",
  "research",
]);

export const AgentJobOperationSchema = z.enum([
  "search_deals",
  "get_pipeline_status",
  "get_order_snapshot",
  "get_campaign_financials",
  "create_action_proposal",
]);

export const AgentJobRouteSchema = z.enum([
  "python",
  "gemini",
  "gpt_luna",
  "director",
  "local_shadow",
  "local",
]);

export type AgentJobRoute = z.infer<typeof AgentJobRouteSchema>;

const scalarInputValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const scalarInputSchema = z.record(z.string(), scalarInputValueSchema);
const opaqueIdSchema = z.string().trim().min(1).max(128);
const isoDateSchema = z.iso.datetime({ offset: true });

const searchDealsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(160).optional(),
    status: z.string().trim().min(1).max(64).optional(),
    partnerId: opaqueIdSchema.optional(),
  })
  .strict();

const pipelineStatusInputSchema = z.object({}).strict();

const orderSnapshotInputSchema = z
  .object({
    campaignId: opaqueIdSchema.optional(),
    startAt: isoDateSchema.optional(),
    endAt: isoDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startAt && value.endAt && value.startAt > value.endAt) {
      context.addIssue({ code: "custom", message: "startAt must not be later than endAt" });
    }
  });

const campaignFinancialsInputSchema = z
  .object({
    campaignId: opaqueIdSchema,
  })
  .strict();

const createActionProposalInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("add_entity_memo"),
      entityType: z.enum(["PARTNER", "SELLER", "DEAL", "CAMPAIGN"]),
      entityId: opaqueIdSchema,
      content: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("change_deal_status"),
      dealId: opaqueIdSchema,
      newStatus: z.enum([
        "SOURCING",
        "NEGOTIATING",
        "SAMPLE_TESTING",
        "CONFIRMED",
        "ARCHIVED",
        "DROPPED",
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("confirm_settlement"),
      campaignId: opaqueIdSchema,
      target: z.enum(["deposit", "payout"]),
    })
    .strict(),
]);

const operationInputSchemas = {
  search_deals: searchDealsInputSchema,
  get_pipeline_status: pipelineStatusInputSchema,
  get_order_snapshot: orderSnapshotInputSchema,
  get_campaign_financials: campaignFinancialsInputSchema,
  create_action_proposal: createActionProposalInputSchema,
};

const secretLikeInputKey = /(?:api[_-]?key|authorization|credential|password|secret|token)/i;

export const AgentJobPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskType: AgentJobTaskTypeSchema,
    skill: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    operation: AgentJobOperationSchema,
    input: scalarInputSchema,
    origin: z
      .object({
        source: z.literal("hermes_slack"),
        correlationId: opaqueIdSchema,
        requesterDigest: z.string().trim().min(1).max(128),
        threadDigest: z.string().trim().min(1).max(128),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of Object.keys(value.input)) {
      if (secretLikeInputKey.test(key)) {
        context.addIssue({
          code: "custom",
          path: ["input", key],
          message: "secret-like input cannot be persisted in AgentJob",
        });
      }
    }

    const parsed = operationInputSchemas[value.operation].safeParse(value.input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          ...issue,
          path: ["input", ...issue.path],
        });
      }
    }
  });

export type AgentJobPayload = z.infer<typeof AgentJobPayloadSchema>;

export const AgentJobResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: opaqueIdSchema,
    status: z.enum(["SUCCEEDED", "NEEDS_APPROVAL", "NEEDS_EXTERNAL_EXECUTOR", "FAILED_FINAL"]),
    route: AgentJobRouteSchema,
    modelUsed: z.string().trim().min(1).max(128),
    validationResult: z.enum(["pass", "fail", "not_validated"]),
    resultSummary: z.string().trim().min(1).max(MAX_RESULT_SUMMARY_CHARS),
    actionProposalId: opaqueIdSchema.nullable(),
    evidenceRefs: z.array(z.string().trim().min(1).max(256)).max(MAX_EVIDENCE_REFS),
  })
  .strict();

export type AgentJobResult = z.infer<typeof AgentJobResultSchema>;

const allowedTransitions: Record<AgentJobStatus, readonly AgentJobStatus[]> = {
  QUEUED: ["CLAIMED"],
  CLAIMED: ["RUNNING", "RESOURCE_DEFERRED", "FAILED_FINAL", "FAILED_SECURITY"],
  RUNNING: [
    "SUCCEEDED",
    "NEEDS_APPROVAL",
    "NEEDS_EXTERNAL_EXECUTOR",
    "FAILED_RETRYABLE",
    "FAILED_FINAL",
    "RESOURCE_DEFERRED",
    "FAILED_SECURITY",
  ],
  SUCCEEDED: [],
  NEEDS_APPROVAL: [],
  NEEDS_EXTERNAL_EXECUTOR: [],
  FAILED_RETRYABLE: [],
  FAILED_FINAL: [],
  RESOURCE_DEFERRED: [],
  FAILED_SECURITY: [],
};

export function isAgentJobTransitionAllowed(
  fromStatus: AgentJobStatus,
  toStatus: AgentJobStatus,
): boolean {
  return allowedTransitions[fromStatus].some((candidate) => candidate === toStatus);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalize(nestedValue)}`)
    .join(",")}}`;
}

export function createAgentJobIdempotencyKey(payload: AgentJobPayload, now: Date): string {
  const bucket = Math.floor(now.getTime() / AGENT_JOB_IDEMPOTENCY_BUCKET_MS);
  const source = [
    payload.schemaVersion,
    payload.operation,
    canonicalize(payload.input),
    payload.origin.requesterDigest,
    bucket,
  ].join("|");

  return createHash("sha256").update(source).digest("hex");
}

/** Serializes only Zod-validated payload/result data and enforces the durable queue byte cap. */
export function serializeAgentJobJson<T extends AgentJobPayload | AgentJobResult>(
  value: T,
  useSqlite: boolean,
): T | string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AGENT_JOB_JSON_BYTES) {
    throw new Error(`AgentJob JSON exceeds ${MAX_AGENT_JOB_JSON_BYTES} bytes`);
  }
  return useSqlite ? serialized : value;
}
