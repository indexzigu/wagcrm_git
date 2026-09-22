import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireRoleMock = vi.fn();
const listRecentMock = vi.fn();
vi.mock("@/lib/api-auth", () => ({ requireRole: (role: string) => requireRoleMock(role) }));
vi.mock("@/repositories/agentJobRepository", () => ({
  AgentJobRepository: { listRecent: (...a: unknown[]) => listRecentMock(...a) },
}));

const { GET } = await import("./route");
const req = (q = "") => new NextRequest(`http://localhost/api/agent-jobs${q}`);

const job = (i: number, status = "FAILED_FINAL") => ({
  id: `job-${i}`,
  idempotencyKey: `k${i}`,
  status,
  workerId: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  attempt: 1,
  failureCode: status.startsWith("FAILED") ? "NOT_FOUND" : null,
  payload: {
    schemaVersion: 1,
    taskType: "deterministic",
    skill: "none",
    operation: "search_deals",
    input: { query: "비밀 검색어" },
    origin: { source: "hermes_slack", correlationId: "c", requesterDigest: "r", threadDigest: "t" },
  },
  result:
    status === "SUCCEEDED"
      ? {
          schemaVersion: 1,
          jobId: `job-${i}`,
          status: "SUCCEEDED",
          route: "python",
          modelUsed: "none",
          validationResult: "pass",
          resultSummary: "search_deals: 3 deal(s)",
          actionProposalId: "read-9",
          evidenceRefs: [],
        }
      : null,
  createdAt: new Date(Date.UTC(2026, 8, 22, 0, 0, 59 - i)),
  updatedAt: new Date(),
});

describe("GET /api/agent-jobs", () => {
  beforeEach(() => {
    requireRoleMock.mockReset();
    listRecentMock.mockReset();
    requireRoleMock.mockResolvedValue({ authenticated: true, context: { userId: "u1", role: "admin" } });
  });

  it("admin 전용이다", async () => {
    requireRoleMock.mockResolvedValue({ authenticated: false, response: new Response("no", { status: 403 }) });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(requireRoleMock).toHaveBeenCalledWith("admin");
    expect(listRecentMock).not.toHaveBeenCalled();
  });

  it("기본은 성공 제외, includeSucceeded=1 이면 포함", async () => {
    listRecentMock.mockResolvedValue([]);
    await GET(req());
    expect(listRecentMock).toHaveBeenCalledWith(expect.objectContaining({ includeSucceeded: false, take: 51 }));
    await GET(req("?includeSucceeded=1"));
    expect(listRecentMock).toHaveBeenLastCalledWith(expect.objectContaining({ includeSucceeded: true }));
  });

  it("payload.input 과 origin 은 응답에 싣지 않고, 요약·결과 id 만 싣는다", async () => {
    listRecentMock.mockResolvedValue([job(0, "SUCCEEDED"), job(1)]);
    const body = await (await GET(req("?includeSucceeded=1"))).json();
    expect(body.items[0]).toEqual({
      id: "job-0",
      status: "SUCCEEDED",
      operation: "search_deals",
      taskType: "deterministic",
      createdAt: job(0).createdAt.toISOString(),
      updatedAt: expect.any(String),
      attempt: 1,
      failureCode: null,
      resultStatus: "SUCCEEDED",
      resultSummary: "search_deals: 3 deal(s)",
      actionProposalId: "read-9",
    });
    expect(JSON.stringify(body)).not.toContain("비밀 검색어");
    expect(JSON.stringify(body)).not.toContain("requesterDigest");
    expect(body.items[1]).toEqual(
      expect.objectContaining({ resultStatus: null, resultSummary: null, actionProposalId: null, failureCode: "NOT_FOUND" })
    );
  });

  it("51건이면 50건 + nextBefore", async () => {
    listRecentMock.mockResolvedValue(Array.from({ length: 51 }, (_, i) => job(i)));
    const body = await (await GET(req())).json();
    expect(body.items).toHaveLength(50);
    expect(body.nextBefore).toBe(job(49).createdAt.toISOString());
  });
});
