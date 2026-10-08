// 정산 금액 수정 자동 실행 크론 계약.
//   ① 인증 — 공유 시크릿 SSOT(`@/lib/cron-auth`). 미인증이면 회차를 돌리지 않는다
//   ② 관측 — withSystemTaskStatus("agent-auto-execute") 로 감싸고, 빈 회차는 `quiet: true`
//   ③ 회차 안 처리 전부가 오류면 `failed: true`(레이더 빨강)
import { beforeEach, describe, expect, it, vi } from "vitest";

const passMock = vi.fn();
vi.mock("@/lib/agent/auto-execute/settlement-auto-execute", () => ({
  runSettlementAutoExecutePass: (...a: unknown[]) => passMock(...a),
}));
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: vi.fn() }));
const { wrapped } = vi.hoisted(() => ({ wrapped: [] as string[] }));
vi.mock("@/lib/system-task-status", () => ({
  withSystemTaskStatus: (jobKey: string, fn: (request: Request) => Promise<Response>) => {
    wrapped.push(jobKey);
    return (request: Request) => fn(request);
  },
}));

import { GET } from "../route";
import { verifyCronAuth } from "@/lib/cron-auth";

const req = () => new Request("http://t/api/cron/agent-auto-execute");

function pass(over: Record<string, unknown> = {}) {
  return {
    mode: "on",
    ran: true,
    lockBusy: false,
    candidates: 0,
    recorded: 0,
    verdicts: {},
    executed: 0,
    executionFailed: 0,
    skipped: 0,
    swept: 0,
    errors: 0,
    deferred: 0,
    quiet: true,
    ...over,
  };
}

beforeEach(() => {
  passMock.mockReset();
  vi.mocked(verifyCronAuth).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("agent-auto-execute 크론", () => {
  it("관측 래퍼에 잡 키로 감싼다", () => {
    expect(wrapped).toContain("agent-auto-execute");
  });

  it("미인증이면 401 이고 회차를 돌리지 않는다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(passMock).not.toHaveBeenCalled();
  });

  it("빈 회차는 quiet:true 를 그대로 싣는다(이력 줄 생략 신호)", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    passMock.mockResolvedValue(pass());
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ ok: true, quiet: true });
    expect(body.failed).toBeUndefined();
  });

  it("처리가 전부 오류로 끝나면 failed:true 로 실질 실패를 선언한다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    passMock.mockResolvedValue(pass({ errors: 2, quiet: false }));
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ failed: true, quiet: false });
  });

  it("일부만 오류면 실패 선언하지 않는다(상시 노이즈로 빨강 습관화 방지)", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(true);
    passMock.mockResolvedValue(pass({ errors: 1, executed: 1, quiet: false }));
    const body = await (await GET(req())).json();
    expect(body.failed).toBeUndefined();
  });
});
