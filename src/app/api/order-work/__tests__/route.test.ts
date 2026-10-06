import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/order-work — 실패 응답에 내부 오류 문구를 싣지 않는다(리뷰 C6). DB·드라이버 오류는 접속 대상
// 같은 내부 정보를 담을 수 있어 서버 로그에만 남기고, 화면에는 정해진 한국어 문구만 보낸다.

const loadMock = vi.fn();
vi.mock("@/lib/api-auth", () => ({
  requireAuth: async () => ({ authenticated: true, context: {} }),
}));
vi.mock("@/lib/order-converter/order-work-summary", () => ({
  loadOrderWorkSummary: () => loadMock(),
}));

const { GET } = await import("../route");

describe("GET /api/order-work", () => {
  beforeEach(() => {
    loadMock.mockReset();
  });

  it("집계 결과를 그대로 내려준다", async () => {
    loadMock.mockResolvedValue({ total: 3 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 3 });
  });

  it("실패하면 500 + 일반 문구만 — 원인 문구는 응답에 없고 서버 로그에만 남는다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:55432 password=secret"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/오늘 처리할 주문을 집계하지 못했습니다/);
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|55432|secret/);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
