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

  // 봉투가 깊이 2로 열리면서 시크릿 검사도 재귀(`inputKeyPaths`)로 함께 깊어졌다.
  // 최상위만 보던 검사를 그대로 두고 봉투만 열면 `input.partner.password` 가 통과한다.
  //
  // ⚠️ `success === false` 만 보면 이 테스트는 **헛돈다.** 모든 operation 스키마가
  // `.strict()` 라 시크릿 유사 키는 「모르는 칸」으로도 거부되기 때문에, 재귀 검사를
  // 통째로 지워도 초록으로 남는다. 그래서 거부됐다는 사실이 아니라 **그 경로에서 시크릿
  // 사유로 거부됐는지**를 짚는다. 배열 분기는 재귀에서 가장 빠뜨리기 쉬운 갈래라 따로 센다.
  it.each([
    [
      "중첩 객체 안",
      "create_action_proposal",
      { action: "create_partner", partner: { name: "테스트", type: "BRAND", password: "x" } },
      "input.partner.password",
    ],
    [
      "배열 안 객체",
      "create_action_proposal",
      {
        action: "create_partner",
        partner: { name: "테스트", type: "BRAND" },
        contacts: [{ name: "담당", api_key: "x" }],
      },
      "input.contacts.0.api_key",
    ],
    [
      "배열 안 객체(다른 operation)",
      "search_deals",
      { query: [{ authorization: "Bearer x" }] },
      "input.query.0.authorization",
    ],
  ])("flags a secret-like key nested %s at its own path", (_label, operation, input, path) => {
    const result = AgentJobPayloadSchema.safeParse({ ...payload, operation, input });
    expect(result.success).toBe(false);
    const secretIssues = result.success
      ? []
      : result.error.issues.filter((issue) => issue.message.includes("secret-like"));
    expect(secretIssues.map((issue) => issue.path.join("."))).toContain(path);
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
