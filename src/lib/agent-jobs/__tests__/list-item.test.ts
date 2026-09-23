import { describe, expect, it } from "vitest";
import { toListItem } from "../list-item";
import type { AgentJobListRow, AgentJobRecord } from "@/repositories/agentJobRepository";

function makeJob(overrides: Partial<AgentJobRecord> = {}): AgentJobRecord {
  return {
    id: "job-1",
    idempotencyKey: "k1",
    status: "SUCCEEDED",
    workerId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attempt: 1,
    failureCode: null,
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
    updatedAt: new Date("2026-09-22T00:01:00.000Z"),
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "none",
      operation: "search_deals",
      input: { query: "비밀 검색어" },
      origin: {
        source: "hermes_slack",
        correlationId: "c",
        requesterDigest: "r",
        threadDigest: "t",
      },
    },
    result: {
      schemaVersion: 1,
      jobId: "job-1",
      status: "SUCCEEDED",
      route: "python",
      modelUsed: "none",
      validationResult: "pass",
      resultSummary: "search_deals: 3 deal(s)",
      actionProposalId: "read-9",
      evidenceRefs: [],
    },
    ...overrides,
  } as AgentJobRecord;
}

describe("toListItem", () => {
  it("payload.input·origin 은 드롭하고 요약·결과 id 만 싣는다", () => {
    const item = toListItem(makeJob());

    expect(item).toEqual({
      id: "job-1",
      status: "SUCCEEDED",
      operation: "search_deals",
      taskType: "deterministic",
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:01:00.000Z",
      attempt: 1,
      failureCode: null,
      resultStatus: "SUCCEEDED",
      resultSummary: "search_deals: 3 deal(s)",
      actionProposalId: "read-9",
      payloadUnreadable: false,
    });
    expect(JSON.stringify(item)).not.toContain("비밀 검색어");
    expect(JSON.stringify(item)).not.toContain("requesterDigest");
  });

  it("result 가 없으면 resultStatus·resultSummary·actionProposalId 를 null 로 채운다", () => {
    const item = toListItem(makeJob({ result: null, status: "FAILED_FINAL", failureCode: "NOT_FOUND" }));

    expect(item.resultStatus).toBeNull();
    expect(item.resultSummary).toBeNull();
    expect(item.actionProposalId).toBeNull();
    expect(item.failureCode).toBe("NOT_FOUND");
    expect(item.payloadUnreadable).toBe(false);
  });

  it("degraded 행(poison payload)은 operation·taskType을 unknown으로, payloadUnreadable을 true로 채운다", () => {
    const degradedRow: AgentJobListRow = {
      degraded: true,
      id: "poison-1",
      status: "FAILED_SECURITY",
      attempt: 1,
      failureCode: "PAYLOAD_INVALID",
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
      updatedAt: new Date("2026-09-22T00:00:00.000Z"),
    };

    const item = toListItem(degradedRow);

    expect(item).toEqual({
      id: "poison-1",
      status: "FAILED_SECURITY",
      operation: "unknown",
      taskType: "unknown",
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
      attempt: 1,
      failureCode: "PAYLOAD_INVALID",
      resultStatus: null,
      resultSummary: null,
      actionProposalId: null,
      payloadUnreadable: true,
    });
  });
});
