import { describe, expect, it } from "vitest";
import {
  AGENT_WORKER_AUDIT_FIELDS,
  AgentWorkerAuditRecordSchema,
  createAuditLogger,
  errorClassOf,
} from "../audit";

const SENTINELS = {
  input: "SENTINEL_RAW_INPUT_9f1c",
  result: "SENTINEL_RAW_RESULT_2b7e",
  prompt: "SENTINEL_PROMPT_TEXT_55aa",
  toolOutput: "SENTINEL_TOOL_OUTPUT_d00d",
  frame: "SENTINEL_SOCKET_FRAME_c0de",
  errorMessage: "SENTINEL_ERROR_MESSAGE password=hunter2",
};

describe("agent worker audit", () => {
  it("accepts exactly the frozen field set and rejects any extra field", () => {
    expect([...AGENT_WORKER_AUDIT_FIELDS].sort()).toEqual(
      [
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
      ].sort(),
    );
    const record = {
      jobId: "job-1",
      taskType: "routine",
      route: "python",
      model: "python",
      skill: "none",
      validationResult: "pass",
      escalationReason: null,
      correction: false,
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:00:01.000Z",
      errorClass: null,
    };
    expect(AgentWorkerAuditRecordSchema.safeParse(record).success).toBe(true);
    expect(AgentWorkerAuditRecordSchema.safeParse({ ...record, rawInput: "x" }).success).toBe(false);
    expect(AgentWorkerAuditRecordSchema.safeParse({ ...record, errorMessage: "x" }).success).toBe(false);
  });

  it("never emits raw input, result, prompt, tool output, socket frame, or error message", () => {
    const lines: string[] = [];
    const audit = createAuditLogger((line) => lines.push(line));
    const error = new Error(SENTINELS.errorMessage);
    error.name = "QueryFailedError";

    audit.recordJob({
      job: {
        id: "job-1",
        payload: {
          schemaVersion: 1,
          taskType: "deterministic",
          skill: "none",
          operation: "search_deals",
          input: { query: SENTINELS.input, prompt: SENTINELS.prompt },
          origin: {
            source: "hermes_slack",
            correlationId: "c",
            requesterDigest: "r",
            threadDigest: "t",
          },
        },
      },
      route: "python",
      model: "python",
      validationResult: "fail",
      escalationReason: null,
      correction: false,
      startedAt: new Date("2026-09-02T00:00:00.000Z"),
      finishedAt: new Date("2026-09-02T00:00:01.000Z"),
      error,
      resultSummary: SENTINELS.result,
      toolOutput: SENTINELS.toolOutput,
      socketFrame: SENTINELS.frame,
    } as never);
    audit.recordConnectionRejected("PEER_UID_MISMATCH", new Date("2026-09-02T00:00:02.000Z"));
    audit.recordQuarantinedJob("poison-1", "ZodError", new Date("2026-09-02T00:00:03.000Z"));

    expect(lines).toHaveLength(3);
    const third = JSON.parse(lines[2]);
    expect(Object.keys(third).sort()).toEqual([...AGENT_WORKER_AUDIT_FIELDS].sort());
    expect(third).toMatchObject({ jobId: "poison-1", errorClass: "ZodError", validationResult: "fail", taskType: null });
    const joined = lines.join("\n");
    for (const sentinel of Object.values(SENTINELS)) {
      expect(joined).not.toContain(sentinel);
    }
    expect(joined).not.toContain("hunter2");
    const first = JSON.parse(lines[0]);
    expect(Object.keys(first).sort()).toEqual([...AGENT_WORKER_AUDIT_FIELDS].sort());
    expect(first).toMatchObject({
      jobId: "job-1",
      taskType: "deterministic",
      skill: "none",
      route: "python",
      model: "python",
      validationResult: "fail",
      errorClass: "QueryFailedError",
    });
    const second = JSON.parse(lines[1]);
    expect(Object.keys(second).sort()).toEqual([...AGENT_WORKER_AUDIT_FIELDS].sort());
    expect(second).toMatchObject({ jobId: null, errorClass: "PEER_UID_MISMATCH", validationResult: "not_validated" });
  });

  it("derives an error class from the error name only", () => {
    const named = new Error("secret text");
    named.name = "SocketPathError";
    expect(errorClassOf(named)).toBe("SocketPathError");
    expect(errorClassOf(new TypeError("secret text"))).toBe("TypeError");
    expect(errorClassOf("plain string with secret")).toBe("UnknownError");
    expect(errorClassOf(null)).toBe("UnknownError");
  });
});
