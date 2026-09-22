import { beforeEach, describe, expect, it, vi } from "vitest";

const proposalCreateMock = vi.fn();
const proposalEventCreateMock = vi.fn();
const transactionMock = vi.fn();
const tx = {
  actionProposal: { create: proposalCreateMock, update: vi.fn(), updateMany: vi.fn() },
  actionProposalEvent: { create: proposalEventCreateMock },
};
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ $transaction: (callback: unknown) => transactionMock(callback) }),
}));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));

import { MAX_READ_RESULT_BYTES, boundStructuredResult, recordReadResult } from "../read-result-record";

const now = new Date("2026-09-22T03:00:00.000Z");

beforeEach(() => {
  for (const mock of [proposalCreateMock, proposalEventCreateMock, transactionMock]) mock.mockReset();
  transactionMock.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
  proposalCreateMock.mockResolvedValue({ id: "read-1" });
  proposalEventCreateMock.mockResolvedValue({ id: "event-1" });
});

describe("recordReadResult", () => {
  it("INSERTs a READ/EXECUTED proposal plus one DRAFT→EXECUTED event in one transaction and returns the id", async () => {
    const id = await recordReadResult(
      "search_deals",
      {
        title: "딜 검색 2건",
        resultSummary: "search_deals: 2 deal(s)\nA id=d1\nB id=d2",
        structuredResult: { items: [{ id: "d1" }, { id: "d2" }], truncated: false },
        dataSources: ["Deal"],
        query: { query: "vita" },
      },
      now,
    );
    expect(id).toBe("read-1");
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(proposalCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestType: "data_query",
        kind: "READ",
        status: "EXECUTED",
        reviewRequired: false,
        createdBy: "AGENT_WORKER",
        executedBy: "AGENT_WORKER",
        executedAt: now,
        title: "딜 검색 2건",
        resultSummary: "search_deals: 2 deal(s)\nA id=d1\nB id=d2",
      }),
    });
    const data = proposalCreateMock.mock.calls[0][0].data as Record<string, unknown>;
    // 원격 DB 이므로 Json 필드는 객체 그대로 저장된다 — 모양을 그대로 단언한다.
    expect(data.structuredResult).toEqual({
      operation: "search_deals",
      jobId: null,
      query: { query: "vita" },
      truncated: false,
      data: { items: [{ id: "d1" }, { id: "d2" }], truncated: false },
    });
    expect(data.dataSources).toEqual(["Deal"]);
    expect(proposalEventCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ proposalId: "read-1", fromStatus: "DRAFT", toStatus: "EXECUTED", actor: "AGENT_WORKER" }),
    });
    expect(tx.actionProposal.update).not.toHaveBeenCalled();
    expect(tx.actionProposal.updateMany).not.toHaveBeenCalled();
  });

  it("truncates the title to 200 chars", async () => {
    await recordReadResult(
      "search_deals",
      { title: "x".repeat(300), resultSummary: "s", structuredResult: null, dataSources: [], query: {} },
      now,
    );
    const data = proposalCreateMock.mock.calls[0][0].data as { title: string };
    expect(data.title).toHaveLength(200);
  });

  it("replaces an oversized structuredResult with a truncation marker instead of a cut JSON", async () => {
    const big = { rows: Array.from({ length: 4000 }, (_, i) => ({ id: `row-${i}`, name: "n".repeat(20) })) };
    const bounded = boundStructuredResult(big);
    expect(bounded.truncated).toBe(true);
    expect(bounded.value).toEqual({ truncated: true, bytes: expect.any(Number) });
    expect((bounded.value as { bytes: number }).bytes).toBeGreaterThan(MAX_READ_RESULT_BYTES);

    await recordReadResult("search_deals", { title: "t", resultSummary: "s", structuredResult: big, dataSources: [], query: {} }, now);
    const data = proposalCreateMock.mock.calls[0][0].data as { structuredResult: { truncated: boolean; data: unknown } };
    expect(data.structuredResult.truncated).toBe(true);
    expect(data.structuredResult.data).toEqual({ truncated: true, bytes: expect.any(Number) });
  });

  it("keeps a small structuredResult intact", () => {
    expect(boundStructuredResult({ a: 1 })).toEqual({ value: { a: 1 }, truncated: false });
  });

  it("stores the given jobId, and stores null when it is omitted (duplicate-card identification)", async () => {
    await recordReadResult(
      "search_deals",
      { title: "t", resultSummary: "s", structuredResult: { items: [] }, dataSources: [], query: {} },
      now,
      { jobId: "job-1" },
    );
    const withJobId = proposalCreateMock.mock.calls[0][0].data as { structuredResult: { jobId: string | null } };
    expect(withJobId.structuredResult.jobId).toBe("job-1");

    await recordReadResult(
      "search_deals",
      { title: "t", resultSummary: "s", structuredResult: { items: [] }, dataSources: [], query: {} },
      now,
    );
    const withoutJobId = proposalCreateMock.mock.calls[1][0].data as { structuredResult: { jobId: string | null } };
    expect(withoutJobId.structuredResult.jobId).toBeNull();
  });

  it("propagates a database failure (no swallowing)", async () => {
    proposalCreateMock.mockRejectedValue(new Error("boom"));
    await expect(
      recordReadResult("search_deals", { title: "t", resultSummary: "s", structuredResult: null, dataSources: [], query: {} }, now),
    ).rejects.toThrow("boom");
  });
});
