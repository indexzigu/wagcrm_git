// [캘린더수집] 수집 스캔 크론 계약.
//   ① 인증 — 공유 시크릿 SSOT(`@/lib/cron-auth`). 미인증이면 스캔을 돌리지 않는다
//   ② 관측 — withSystemTaskStatus("calendar-inbound-scan") 로 감싸고, 할 일이 없던 회차는 `quiet: true`
//   ③ 후보 조회·연결 실패(ok:false)·처리 전부 오류는 `failed: true`(레이더 빨강)
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanSummary } from "@/lib/calendar-inbound/scan";

const scanMock = vi.fn();
vi.mock("@/lib/calendar-inbound/scan", () => ({
  runCalendarInboundScan: (...a: unknown[]) => scanMock(...a),
}));
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: vi.fn() }));
const { wrapped } = vi.hoisted(() => ({ wrapped: [] as string[] }));
vi.mock("@/lib/system-task-status", () => ({
  withSystemTaskStatus: (jobKey: string, fn: (request: Request) => Promise<Response>) => {
    wrapped.push(jobKey);
    return (request: Request) => fn(request);
  },
}));

import { GET, maxDuration } from "../route";
import { verifyCronAuth } from "@/lib/cron-auth";

const req = () => new Request("http://t/api/cron/calendar-inbound-scan");

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
    awaitingHint: 0,
    localResolved: 0,
    geminiResolved: 0,
    alreadyHandled: 0,
    errors: 0,
    ...over,
  };
}

beforeEach(() => {
  scanMock.mockReset();
  vi.mocked(verifyCronAuth).mockReset();
});

describe("calendar-inbound-scan 크론", () => {
  it("관측 래퍼에 잡 키로 감싸고 실행 상한은 300초다", () => {
    expect(wrapped).toContain("calendar-inbound-scan");
    expect(maxDuration).toBe(300);
  });

  it("미인증이면 401 이고 스캔을 돌리지 않는다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it("성공하면 요약을 그대로 싣는다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    scanMock.mockResolvedValue(summary({ scanned: 5, newOrChanged: 2, proposed: 1, skippedUnparsed: 1 }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 5, proposed: 1, skippedUnparsed: 1, quiet: false });
    expect(body.failed).toBeUndefined();
  });

  it("손댄 일정이 없는 회차는 quiet:true(이력 줄 생략 신호)", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    scanMock.mockResolvedValue(summary({ scanned: 3, crmOwned: 2, alreadyHandled: 1 }));
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ ok: true, quiet: true });
  });

  it("다른 회차가 도는 중(busy)이면 조용한 성공이다(빨강 아님)", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    scanMock.mockResolvedValue(summary({ skipped: "busy" }));
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ ok: true, skipped: "busy", quiet: true });
    expect(body.failed).toBeUndefined();
  });

  it("캘린더 연결이 없으면 failed:true 로 빨강을 선언한다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    scanMock.mockResolvedValue(summary({ ok: false, skipped: "not_connected" }));
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ failed: true, quiet: false });
    expect(body.failureReason).toContain("연결");
  });

  it("후보 조회가 실패하면 failed:true 와 사유를 싣는다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    scanMock.mockResolvedValue(summary({ ok: false, error: "boom" }));
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ failed: true });
    expect(body.failureReason).toContain("boom");
  });

  it("손댄 일정이 전부 오류로 끝나면 failed:true, 일부만 오류면 아니다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    scanMock.mockResolvedValue(summary({ newOrChanged: 2, errors: 2 }));
    expect((await (await GET(req())).json()).failed).toBe(true);
    scanMock.mockResolvedValue(summary({ newOrChanged: 2, errors: 1, proposed: 1 }));
    expect((await (await GET(req())).json()).failed).toBeUndefined();    // 해석 대기로 남긴 것도 결론이다 — Gemini 일괄 호출이 예외로 끝나 해석 대기로 둔 회차는 빨강이 아니다.
    scanMock.mockResolvedValue(summary({ newOrChanged: 2, errors: 1, awaitingHint: 2 }));
    expect((await (await GET(req())).json()).failed).toBeUndefined();
  });
});
