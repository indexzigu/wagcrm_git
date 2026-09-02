import { describe, expect, it } from "vitest";
import {
  AgentJobPayloadSchema,
  AgentJobResultSchema,
  MAX_RESULT_SUMMARY_CHARS,
  createAgentJobIdempotencyKey,
  isAgentJobTransitionAllowed,
  serializeAgentJobJson,
} from "../contracts";

const payload = {
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
} as const;

describe("AgentJob contracts", () => {
  it("accepts the bounded structured payload and produces a stable 10-minute idempotency key", () => {
    expect(AgentJobPayloadSchema.parse(payload)).toEqual(payload);

    const first = createAgentJobIdempotencyKey(payload, new Date("2026-09-02T00:01:00.000Z"));
    const sameBucket = createAgentJobIdempotencyKey(payload, new Date("2026-09-02T00:09:59.000Z"));
    expect(first).toBe(sameBucket);
  });

  it("rejects secret-like structured input instead of accepting it into the durable queue", () => {
    expect(
      AgentJobPayloadSchema.safeParse({
        ...payload,
        input: { apiToken: "not-for-storage" },
      }).success,
    ).toBe(false);
  });

  it("caps durable result summaries and evidence references", () => {
    expect(
      AgentJobResultSchema.safeParse({
        schemaVersion: 1,
        jobId: "job-1",
        status: "SUCCEEDED",
        route: "gemini",
        modelUsed: "gemini",
        validationResult: "pass",
        resultSummary: "x".repeat(MAX_RESULT_SUMMARY_CHARS + 1),
        actionProposalId: null,
        evidenceRefs: Array.from({ length: 11 }, (_, index) => `evidence-${index}`),
      }).success,
    ).toBe(false);
  });

  it("allows only the locked AgentJob state transitions", () => {
    expect(isAgentJobTransitionAllowed("QUEUED", "CLAIMED")).toBe(true);
    expect(isAgentJobTransitionAllowed("RUNNING", "QUEUED")).toBe(false);
    expect(isAgentJobTransitionAllowed("CLAIMED", "FAILED_SECURITY")).toBe(true);
    expect(isAgentJobTransitionAllowed("RUNNING", "FAILED_SECURITY")).toBe(true);
    expect(isAgentJobTransitionAllowed("SUCCEEDED", "QUEUED")).toBe(false);
    expect(isAgentJobTransitionAllowed("NEEDS_EXTERNAL_EXECUTOR", "RUNNING")).toBe(false);
  });

  it("uses bounded JSON text for the SQLite mirror without changing the payload shape", () => {
    expect(serializeAgentJobJson(payload, true)).toBe(JSON.stringify(payload));
  });
});
