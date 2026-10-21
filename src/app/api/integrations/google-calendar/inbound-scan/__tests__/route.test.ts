// [캘린더수집] 「캘린더에서 가져오기」 수동 실행 라우트 계약.
//   ① 인증 — 형제 라우트(sync·reconcile)와 같은 `requireAuth`. 미인증이면 스캔을 돌리지 않는다
//   ② 크론과 같은 `runCalendarInboundScan` 을 부르고 요약을 그대로 돌려준다
//   ③ 연결 없음 401 · 조회 실패 502 — 화면이 토스트 문구를 고른다
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { ScanSummary } from "@/lib/calendar-inbound/scan";

const requireAuthMock = vi.fn();
vi.mock("@/lib/api-auth", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));
const scanMock = vi.fn();
vi.mock("@/lib/calendar-inbound/scan", () => ({
  runCalendarInboundScan: (...a: unknown[]) => scanMock(...a),
}));

const { POST } = await import("../route");

const admin = { authenticated: true, context: { userId: "owner@example.com", role: "admin" } };

function summary(over: Partial<ScanSummary> = {}): ScanSummary {
  return {
    ok: true,
    scanned: 0,
    crmOwned: 0,
    newOrChanged: 0,
    proposed: 0,
    skippedUnparsed: 0,
    adoptedNoop: 0,
    dropped: 0,
    hintDeferred: 0,
    alreadyHandled: 0,
    errors: 0,
    ...over,
  };
}

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue(admin);
  scanMock.mockReset();
});

describe("POST /api/integrations/google-calendar/inbound-scan", () => {
  it("미인증이면 401 이고 스캔을 돌리지 않는다", async () => {
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await POST();
    expect(res.status).toBe(401);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it("성공하면 스캔 요약을 돌려준다", async () => {
    scanMock.mockResolvedValue(summary({ scanned: 4, proposed: 2, skippedUnparsed: 1, alreadyHandled: 1 }));
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, proposed: 2, skippedUnparsed: 1, alreadyHandled: 1 });
    expect(scanMock).toHaveBeenCalledTimes(1);
  });

  it("캘린더 연결이 없으면 401 과 안내 문구", async () => {
    scanMock.mockResolvedValue(summary({ ok: false, skipped: "not_connected" }));
    const res = await POST();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.skipped).toBe("not_connected");
    expect(body.error).toContain("연결");
  });

  it("후보 조회가 실패하면 502 와 사유", async () => {
    scanMock.mockResolvedValue(summary({ ok: false, error: "boom" }));
    const res = await POST();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("boom");
  });

  it("예상 못 한 예외는 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    scanMock.mockRejectedValue(new Error("db down"));
    const res = await POST();
    expect(res.status).toBe(500);
  });
});
