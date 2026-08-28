import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// prisma는 모킹 — withSystemTaskStatus의 게이트·기록 순서만 검증
vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));

import { getPrisma } from "@/lib/prisma";
import { withSystemTaskStatus } from "@/lib/system-task-status";

/**
 * 시스템 레이더 공용 기록기 검증:
 * - CRON_SECRET이 일치하는 진짜 크론 호출만 기록한다(프리렌더·무단 접근 오염 차단).
 * - 핸들러 실행 전 RUNNING 시작 마커를 남겨, 플랫폼 타임아웃으로 완주하지 못한
 *   실행(RUNNING 고착)과 아예 호출되지 않은 경우(행 없음)를 구분할 수 있게 한다.
 * - 기록 실패는 크론 본연의 응답을 막지 않는다.
 */

const SECRET = "test-cron-secret";
const upsert = vi.fn();
// ⚠️ 이 mock이 없으면 systemTaskLog.create 가 undefined 라 래퍼의 try/catch 에 삼켜져
// 이력 경로가 **한 줄도 실행되지 않은 채** 테스트가 통과한다(details 회귀를 못 잡는다).
const logCreate = vi.fn();

function makeRequest(auth?: string): Request {
  return new Request("http://localhost/api/cron/price-monitoring", {
    headers: auth ? { authorization: auth } : undefined,
  });
}

function recordedStatuses(): string[] {
  return upsert.mock.calls.map((c) => c[0].update.status);
}

function loggedRuns(): Array<{ status: string; message: string; details: unknown }> {
  return logCreate.mock.calls.map((c) => c[0].data);
}

beforeEach(() => {
  upsert.mockReset().mockResolvedValue({});
  logCreate.mockReset().mockResolvedValue({});
  vi.mocked(getPrisma).mockReturnValue({
    systemTaskStatus: { upsert },
    systemTaskLog: { create: logCreate },
  } as unknown as ReturnType<typeof getPrisma>);
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("withSystemTaskStatus 게이트", () => {
  it("Authorization 헤더가 없으면 기록 없이 핸들러만 실행한다(빌드 프리렌더 경로)", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    const res = await wrapped(makeRequest());

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("시크릿이 불일치하면 기록하지 않는다(무단 접근이 상태를 오염시키지 않음)", async () => {
    const handler = vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    const res = await wrapped(makeRequest("Bearer wrong-secret"));

    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("CRON_SECRET 미설정 환경에서는 헤더가 있어도 기록하지 않는다", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("withSystemTaskStatus 기록", () => {
  it("성공 실행은 RUNNING 시작 마커 후 SUCCESS로 마감한다", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    const res = await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(recordedStatuses()).toEqual(["RUNNING", "SUCCESS"]);
    // RUNNING 마커는 직전 실패 메시지를 지우지 않고(undefined), SUCCESS가 null로 청소한다
    expect(upsert.mock.calls[0][0].update.lastErrorMessage).toBeUndefined();
    expect(upsert.mock.calls[1][0].update.lastErrorMessage).toBeNull();
  });

  it("핸들러가 던지면 ERROR로 기록하고 예외를 다시 던진다", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const wrapped = withSystemTaskStatus("job-a", handler);

    await expect(wrapped(makeRequest(`Bearer ${SECRET}`))).rejects.toThrow("boom");
    expect(recordedStatuses()).toEqual(["RUNNING", "ERROR"]);
    expect(upsert.mock.calls[1][0].update.lastErrorMessage).toBe("boom");
  });

  it("비정상 응답은 본문 error 메시지를 ERROR로 기록한다", async () => {
    const handler = vi.fn(async () => Response.json({ error: "요청 한도 초과" }, { status: 500 }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    const res = await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(500);
    expect(recordedStatuses()).toEqual(["RUNNING", "ERROR"]);
    expect(upsert.mock.calls[1][0].update.lastErrorMessage).toBe("요청 한도 초과");
  });

  it("응답 본문을 실행 이력 details 에 남긴다(무음 실패의 유일한 사후 단서)", async () => {
    const handler = vi.fn(async () =>
      Response.json({ ok: true, activeSellers: 3, storiesSeen: 0, errors: ["fetch a: timeout"] }),
    );
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(loggedRuns()).toHaveLength(1);
    expect(loggedRuns()[0].details).toMatchObject({
      activeSellers: 3,
      storiesSeen: 0,
      errors: ["fetch a: timeout"],
    });
  });

  it("핸들러가 failed 를 선언하면 2xx 여도 ERROR 로 기록한다(HTTP 200 ≠ 성공)", async () => {
    const handler = vi.fn(async () =>
      Response.json({ ok: true, failed: true, failureReason: "대상 4명 전원 조회 실패", handlesFailed: 4 }),
    );
    const wrapped = withSystemTaskStatus("job-a", handler);

    const res = await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200); // 크론 플랫폼에는 정상 응답을 그대로 돌려준다
    expect(recordedStatuses()).toEqual(["RUNNING", "ERROR"]);
    expect(upsert.mock.calls[1][0].update.lastErrorMessage).toBe("대상 4명 전원 조회 실패");
    expect(loggedRuns()[0].details).toMatchObject({ handlesFailed: 4 });
  });

  it("failed 가 false·부재면 개별 errors 가 있어도 SUCCESS 다(상시 노이즈로 빨강 습관화 방지)", async () => {
    const handler = vi.fn(async () =>
      Response.json({ ok: true, failed: false, storiesNew: 12, errors: ["thumb 99: 다운로드 실패"] }),
    );
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(recordedStatuses()).toEqual(["RUNNING", "SUCCESS"]);
    expect(loggedRuns()[0].message).toBe("정상 완료");
  });

  it("failureReason 이 없으면 기본 문구로 기록한다", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true, failed: true }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(recordedStatuses()).toEqual(["RUNNING", "ERROR"]);
    expect(upsert.mock.calls[1][0].update.lastErrorMessage).toContain("산출이 없습니다");
  });

  it("본문이 JSON 이 아니어도 durationMs 는 기록된다(계측이 본문 파싱에 얹혀가지 않음, 기록이 크론을 죽이지 않는다)", async () => {
    const handler = vi.fn(async () => new Response("plain text", { status: 200 }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    const res = await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(recordedStatuses()).toEqual(["RUNNING", "SUCCESS"]);
    const details = loggedRuns()[0].details as { durationMs?: number };
    expect(typeof details.durationMs).toBe("number");
  });

  it("과대 페이로드는 잘라서 저장한다(이력 테이블 비대 방지) — durationMs는 절단돼도 보존된다", async () => {
    const handler = vi.fn(async () =>
      Response.json({ ok: true, blob: "x".repeat(10_000) }),
    );
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    const details = loggedRuns()[0].details as {
      truncated?: boolean;
      preview?: string;
      durationMs?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.preview!.length).toBeLessThanOrEqual(4_000);
    expect(typeof details.durationMs).toBe("number");
  });

  it("기록(upsert) 실패는 삼켜지고 크론 응답은 그대로 반환된다", async () => {
    upsert.mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    const res = await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

/**
 * Vercel Hobby 플랜의 함수 실행 60초 제한이 실제 걸림돌인지 실측하기 위한 계측
 * (2026-08-06). 아래 테스트는 durationMs 가 **실제 핸들러 소요시간**을 반영하는지
 * 확인한다 — 상수(예: 0 또는 고정값)를 하드코딩해도 통과하는 얕은 단언이면 계측이
 * 죽은 채 무음으로 방치될 수 있다(#297 부류 실사고 재발 방지 — 판정 문구가 테스트에
 * 안 잡혀 바뀌어도 스위트가 전부 통과하는 것과 같은 위험).
 *
 * ⚠️ **하한을 "요청한 지연"으로 잡지 말 것 (플레이크 실사고 2026-08-08).** 종전에는
 * `setTimeout(resolve, 30)` 을 주입하고 `durationMs >= 30` 을 단언했는데, CI 에서
 * `expected 29 to be greater than or equal to 30` 으로 간헐 실패했다(로컬도 dev 서버를
 * 켠 채 돌리면 재현 — 부하 의존). 원인은 계측 정밀도가 아니라 **타이머가 실제로 일찍
 * 깨는 것**이다: libuv 는 루프 반복 시작 때 찍은 ms 절단 시각으로 만기를 판정하므로
 * `setTimeout(30)` 은 최대 1ms 조기 발화가 정상이다(유휴 맥에서 3,000회 중 23회 관측,
 * 고해상도 `performance.now` 로도 29.1ms — 즉 `Date.now` 절단 탓이 아니다). "요청한
 * 지연 ≤ 실제 경과"라는 전제 자체가 거짓이라, 임계값만 낮추면 같은 플레이크가 뒤로
 * 미뤄질 뿐이다.
 *
 * 그래서 하한을 **실제로 흐른 시간**으로 바꾼다 — 핸들러가 스스로 잰 경과시간을
 * 하한, 테스트가 잰 전체 경과시간을 상한으로 삼는 샌드위치 단언이다. 래퍼의 측정
 * 구간은 핸들러 구간을 항상 포함하고(startedAt 은 핸들러 호출 전, 종료 시각은 반환
 * 직후) 테스트 구간에 항상 포함되므로, 부하와 무관하게 성립한다(허용오차·임계값 없음).
 * 상수 하드코딩은 여전히 잡힌다 — 0 은 하한에, 고정 큰 값은 상한에 걸린다.
 */
describe("withSystemTaskStatus durationMs 계측", () => {
  it("성공 실행은 handler 소요시간을 durationMs 로 기록한다", async () => {
    let innerElapsedMs = 0;
    const handler = vi.fn(async () => {
      const handlerStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 30));
      innerElapsedMs = Date.now() - handlerStartedAt;
      return Response.json({ ok: true });
    });
    const wrapped = withSystemTaskStatus("job-a", handler);

    const outerStartedAt = Date.now();
    await wrapped(makeRequest(`Bearer ${SECRET}`));
    const outerElapsedMs = Date.now() - outerStartedAt;

    const details = loggedRuns()[0].details as { durationMs?: number };
    expect(typeof details.durationMs).toBe("number");
    // 하한이 0이면 상수 0을 하드코딩해도 통과한다 — 단언이 헛돌지 않게 먼저 고정한다.
    expect(innerElapsedMs).toBeGreaterThan(0);
    expect(details.durationMs).toBeGreaterThanOrEqual(innerElapsedMs);
    expect(details.durationMs).toBeLessThanOrEqual(outerElapsedMs);
  });

  it("핸들러가 예외를 던져도 던지기 직전까지의 durationMs 를 기록한다", async () => {
    let innerElapsedMs = 0;
    const handler = vi.fn(async () => {
      const handlerStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 10));
      innerElapsedMs = Date.now() - handlerStartedAt;
      throw new Error("boom");
    });
    const wrapped = withSystemTaskStatus("job-a", handler);

    const outerStartedAt = Date.now();
    await expect(wrapped(makeRequest(`Bearer ${SECRET}`))).rejects.toThrow("boom");
    const outerElapsedMs = Date.now() - outerStartedAt;

    expect(recordedStatuses()).toEqual(["RUNNING", "ERROR"]);
    const details = loggedRuns()[0].details as { durationMs?: number };
    expect(typeof details.durationMs).toBe("number");
    expect(innerElapsedMs).toBeGreaterThan(0);
    expect(details.durationMs).toBeGreaterThanOrEqual(innerElapsedMs);
    expect(details.durationMs).toBeLessThanOrEqual(outerElapsedMs);
  });

  it("비정상 응답(4xx/5xx)도 durationMs 를 기록한다", async () => {
    const handler = vi.fn(async () => Response.json({ error: "요청 한도 초과" }, { status: 500 }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    const details = loggedRuns()[0].details as { durationMs?: number };
    expect(typeof details.durationMs).toBe("number");
  });

  it("failed:true 선언(2xx) 경로도 durationMs 를 기록한다", async () => {
    const handler = vi.fn(async () =>
      Response.json({ ok: true, failed: true, failureReason: "대상 전원 실패" }),
    );
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    const details = loggedRuns()[0].details as { durationMs?: number };
    expect(typeof details.durationMs).toBe("number");
  });

  it("RUNNING 시작 마커에는 durationMs 를 남기지 않는다(SystemTaskLog에 append 자체를 안 함)", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    // RUNNING은 systemTaskLog.create를 타지 않으므로 로그 이력은 SUCCESS 1건뿐이다.
    expect(loggedRuns()).toHaveLength(1);
    expect(loggedRuns()[0].status).toBe("SUCCESS");
  });
});
