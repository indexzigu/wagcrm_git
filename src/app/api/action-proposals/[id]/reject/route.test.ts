/**
 * POST /api/action-proposals/[id]/reject — 반려 (청사진 §2).
 * requireRole("admin") + 조건부 PENDING_APPROVAL→REJECTED. 쓰기 없음.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireRoleMock = vi.fn();
const findByIdMock = vi.fn();
const transitionMock = vi.fn();

class FakeConcurrentModificationError extends Error {}

vi.mock("@/lib/api-auth", () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
    transition: (...args: unknown[]) => transitionMock(...args),
  },
  ConcurrentModificationError: FakeConcurrentModificationError,
}));

const { POST } = await import("./route");

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest() {
  return new NextRequest("http://localhost/api/action-proposals/proposal-1/reject", { method: "POST" });
}

describe("POST /api/action-proposals/[id]/reject", () => {
  beforeEach(() => {
    requireRoleMock.mockReset();
    findByIdMock.mockReset();
    transitionMock.mockReset();
    requireRoleMock.mockResolvedValue({
      authenticated: true,
      context: { userId: "approver@example.com", role: "admin" },
    });
  });

  it("admin이 아니면 403을 반환한다", async () => {
    requireRoleMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(403);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("존재하지 않으면 404를 반환한다", async () => {
    findByIdMock.mockResolvedValue(null);
    const res = await POST(makeRequest(), makeParams("proposal-x"));
    expect(res.status).toBe(404);
  });

  it("정상 반려: PENDING_APPROVAL -> REJECTED 조건부 전이 후 200을 반환한다", async () => {
    findByIdMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL", createdBy: "creator@example.com" });
    transitionMock.mockResolvedValue({ id: "proposal-1", status: "REJECTED" });

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.proposal.status).toBe("REJECTED");
    expect(transitionMock).toHaveBeenCalledWith(
      "proposal-1",
      "REJECTED",
      expect.objectContaining({ expectedFrom: "PENDING_APPROVAL" })
    );
  });

  it("이미 처리된 기안(동시 반려/승인)이면 409를 반환한다", async () => {
    findByIdMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL", createdBy: "creator@example.com" });
    transitionMock.mockRejectedValue(new FakeConcurrentModificationError("이미 처리됨"));

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(409);
  });

  it("자기 기안도 반려는 허용한다 (self-approval 게이트는 approve에만 적용)", async () => {
    findByIdMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL", createdBy: "approver@example.com" });
    transitionMock.mockResolvedValue({ id: "proposal-1", status: "REJECTED" });

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(200);
  });
});
