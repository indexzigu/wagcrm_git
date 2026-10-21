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
    markInboundRejectedMock.mockReset();
    markInboundRejectedMock.mockResolvedValue(undefined);
    findInboundRowMock.mockReset();
    // 기본: 수집 행이 이 기안을 가리킨다.
    findInboundRowMock.mockResolvedValue({ proposalId: "proposal-1" });
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

  it("[캘린더수집] 캘린더에서 온 기안이면 수집 행을 REJECTED 로 표기한다(다시 기안하지 않는다)", async () => {
    findByIdMock.mockResolvedValue({
      id: "proposal-1",
      status: "PENDING_APPROVAL",
      createdBy: "SYSTEM_CALENDAR_INBOUND",
      sourceRef: JSON.stringify({
        calendarInbound: {
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
        },
      }),
    });
    transitionMock.mockResolvedValue({ id: "proposal-1", status: "REJECTED" });

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(200);
    expect(markInboundRejectedMock).toHaveBeenCalledWith("in-1", "proposal-1");
  });

  it("[캘린더수집] 재기안으로 대체된 옛 카드를 반려하면 수집 행은 건드리지 않는다(새 기안이 그 행의 주인)", async () => {
    findByIdMock.mockResolvedValue({
      id: "proposal-1",
      status: "PENDING_APPROVAL",
      createdBy: "SYSTEM_CALENDAR_INBOUND",
      sourceRef: { calendarInbound: INBOUND_REF },
    });
    transitionMock.mockResolvedValue({ id: "proposal-1", status: "REJECTED" });

    for (const row of [{ proposalId: "proposal-new" }, { proposalId: null }, null]) {
      findInboundRowMock.mockResolvedValueOnce(row);
      const res = await POST(makeRequest(), makeParams("proposal-1"));
      expect(res.status).toBe(200);
    }
    expect(findInboundRowMock).toHaveBeenCalledWith("in-1");
    expect(markInboundRejectedMock).not.toHaveBeenCalled();
  });

  it("[캘린더수집] 수집 행 조회가 실패해도 반려 응답은 200 이고 표기는 하지 않는다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findByIdMock.mockResolvedValue({
      id: "proposal-1",
      status: "PENDING_APPROVAL",
      createdBy: "SYSTEM_CALENDAR_INBOUND",
      sourceRef: { calendarInbound: INBOUND_REF },
    });
    transitionMock.mockResolvedValue({ id: "proposal-1", status: "REJECTED" });
    findInboundRowMock.mockRejectedValue(new Error("DB 끊김"));

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(200);
    expect(markInboundRejectedMock).not.toHaveBeenCalled();
  });

  it("[캘린더수집] 표기가 실패해도 반려 응답은 200 이다(반려는 이미 커밋됨)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findByIdMock.mockResolvedValue({
      id: "proposal-1",
      status: "PENDING_APPROVAL",
      createdBy: "SYSTEM_CALENDAR_INBOUND",
      sourceRef: {
        calendarInbound: {
          inboundId: "in-1",
          eventId: "ev-owner",
          calendarId: "primary",
          ledgerKind: "campaign",
          adopt: true,
          summary: "x",
          startDate: "2026-11-03",
          endDate: "2026-11-09",
          htmlLink: null,
          warnings: [],
        },
      },
    });
    transitionMock.mockResolvedValue({ id: "proposal-1", status: "REJECTED" });
    markInboundRejectedMock.mockRejectedValue(new Error("DB 끊김"));

    const res = await POST(makeRequest(), makeParams("proposal-1"));
    expect(res.status).toBe(200);
  });

  it("[캘린더수집] 캘린더 출처가 없으면 표기하지 않는다", async () => {
    findByIdMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL", createdBy: "creator@example.com" });
    transitionMock.mockResolvedValue({ id: "proposal-1", status: "REJECTED" });

    await POST(makeRequest(), makeParams("proposal-1"));
    expect(markInboundRejectedMock).not.toHaveBeenCalled();
    expect(findInboundRowMock).not.toHaveBeenCalled();
  });
});
