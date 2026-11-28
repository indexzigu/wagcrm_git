/**
 * POST /api/action-proposals/[id]/close — 실패 기안 종결.
 * requireRole("admin") + FAILED→REJECTED 전용 경로(`closeFailed`, note = FAILED_CLOSE_NOTE). 쓰기 없음.
 * 캘린더 출신이면 수집 행도 반려로 적는다(반려와 같은 규칙 — 이 기안을 가리킬 때만).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireRoleMock = vi.fn();
const findByIdMock = vi.fn();
const closeFailedMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
    closeFailed: (...args: unknown[]) => closeFailedMock(...args),
  },
  ConcurrentModificationError: class extends Error {},
  FAILED_CLOSE_NOTE: "실패 기안 종결(오너)",
}));

const markInboundRejectedMock = vi.fn();
const findInboundRowMock = vi.fn();
vi.mock("@/lib/calendar-inbound/adopt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar-inbound/adopt")>();
  return {
    ...actual,
    markInboundRejected: (...args: unknown[]) => markInboundRejectedMock(...args),
    findInboundRow: (...args: unknown[]) => findInboundRowMock(...args),
  };
});

const { POST } = await import("./route");

const INBOUND_REF = {
  inboundId: "in-1",
  eventId: "ev-owner",
  calendarId: "primary",
  ledgerKind: "campaign",
  adopt: true,
  summary: "샘플셀러 테스트브랜드 2차",
  startDate: "2026-11-03",
  endDate: "2026-11-09",
  htmlLink: null,
  warnings: [],
};

function call(id = "proposal-1") {
  return POST(new NextRequest(`http://localhost/api/action-proposals/${id}/close`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

describe("POST /api/action-proposals/[id]/close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({ authenticated: true, context: { userId: "owner@example.com", role: "admin" } });
    findByIdMock.mockResolvedValue({ id: "proposal-1", status: "FAILED", sourceRef: null });
    closeFailedMock.mockResolvedValue(true);
    findInboundRowMock.mockResolvedValue({ proposalId: "proposal-1" });
    markInboundRejectedMock.mockResolvedValue(undefined);
  });

  it("admin 이 아니면 게이트 응답을 그대로 돌려주고 아무것도 쓰지 않는다", async () => {
    requireRoleMock.mockResolvedValue({
      authenticated: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });
    const res = await call();
    expect(res.status).toBe(403);
    expect(closeFailedMock).not.toHaveBeenCalled();
  });

  it("실패 기안을 오너 이름과 종결 note 로 닫는다", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(closeFailedMock).toHaveBeenCalledWith("proposal-1", {
      actor: "owner@example.com",
      note: "실패 기안 종결(오너)",
    });
  });

  it("없는 기안이면 404", async () => {
    findByIdMock.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(closeFailedMock).not.toHaveBeenCalled();
  });

  it("그 사이 실패 상태가 아니게 됐으면(재시도 등) 409", async () => {
    closeFailedMock.mockResolvedValue(false);
    const res = await call();
    expect(res.status).toBe(409);
    expect(markInboundRejectedMock).not.toHaveBeenCalled();
  });

  it("캘린더 출신이면 수집 행을 반려로 적는다 — 이 기안을 가리킬 때만", async () => {
    findByIdMock.mockResolvedValue({ id: "proposal-1", status: "FAILED", sourceRef: { calendarInbound: INBOUND_REF } });
    await call();
    expect(markInboundRejectedMock).toHaveBeenCalledWith("in-1", "proposal-1");

    markInboundRejectedMock.mockClear();
    findInboundRowMock.mockResolvedValue({ proposalId: "newer-proposal" });
    await call();
    expect(markInboundRejectedMock).not.toHaveBeenCalled();
  });

  it("예상 못 한 오류는 500", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    closeFailedMock.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
  });
});
