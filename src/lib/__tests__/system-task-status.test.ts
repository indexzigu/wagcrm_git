import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// prisma는 모킹 — withSystemTaskStatus의 게이트·기록 순서만 검증
vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));
vi.mock("@/lib/prisma-client", () => ({
  isRemoteDatabaseUrl: vi.fn(() => false),
}));

import { getPrisma } from "@/lib/prisma";
import { capDetailsForLog, withSystemTaskStatus } from "@/lib/system-task-status";

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
const logFindMany = vi.fn();
const incidentFindFirst = vi.fn();
const incidentCreate = vi.fn();
const incidentUpdate = vi.fn();
const incidentUpdateMany = vi.fn();

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
  logFindMany.mockReset().mockResolvedValue([]);
  incidentFindFirst.mockReset().mockResolvedValue(null);
  incidentCreate.mockReset().mockResolvedValue({ id: "inc-1" });
  incidentUpdate.mockReset().mockResolvedValue({});
  incidentUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  const incidentDb = {
    findFirst: incidentFindFirst,
    create: incidentCreate,
    update: incidentUpdate,
    updateMany: incidentUpdateMany,
  };
  vi.mocked(getPrisma).mockReturnValue({
    $transaction: async (cb: (t: unknown) => unknown) => cb({ cronIncident: incidentDb, $executeRaw: vi.fn() }),
    systemTaskStatus: { upsert },
    systemTaskLog: { create: logCreate, findMany: logFindMany },
    cronIncident: {
      findFirst: incidentFindFirst,
      create: incidentCreate,
      update: incidentUpdate,
      updateMany: incidentUpdateMany,
    },
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
    // RUNNING 마커는 직전 실패 종류(lastErrorKind)도 지우지 않는다
    expect(upsert.mock.calls[0][0].update.lastErrorKind).toBeUndefined();
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

  it("quiet:true 성공 회차는 상태만 갱신하고 이력 줄을 남기지 않는다(분 단위 잡의 빈 회차)", async () => {
    const wrapped = withSystemTaskStatus("job-a", vi.fn(async () => Response.json({ ok: true, quiet: true })));

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(recordedStatuses()).toEqual(["RUNNING", "SUCCESS"]);
    expect(logCreate).not.toHaveBeenCalled();
  });

  it("quiet 이어도 실패 선언은 언제나 이력에 남는다", async () => {
    const wrapped = withSystemTaskStatus(
      "job-a",
      vi.fn(async () => Response.json({ ok: false, quiet: true, failed: true, failureReason: "전부 오류" })),
    );

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(recordedStatuses()).toEqual(["RUNNING", "ERROR"]);
    expect(loggedRuns()).toHaveLength(1);
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

  it("과대 페이로드는 줄여서 저장한다(이력 테이블 비대 방지) — 요약과 durationMs는 보존된다", async () => {
    const handler = vi.fn(async () =>
      Response.json({ ok: true, failed: true, blob: "x".repeat(10_000) }),
    );
    const wrapped = withSystemTaskStatus("job-a", handler);

    await wrapped(makeRequest(`Bearer ${SECRET}`));

    const details = loggedRuns()[0].details as Record<string, unknown>;
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(4_000);
    // ⚠️ 종전 계약은 `{ truncated: true, preview: "<잘린 문자열>" }` 였다(T-084 에서 교체).
    // 그 preview 는 JSON 중간에서 끊긴 조각이라 못 읽었고, 그 자리에 있던 요약 필드가
    // 통째로 사라졌다. 지금은 **덩치만 줄이고 요약은 남기며**, 무엇을 얼마나 덜어냈는지를
    // `detailsTrimmed` 에 적는다(잡이 쓰는 `truncated` 와 이름이 겹치지 않게).
    expect(details.ok).toBe(true);
    expect(details.failed).toBe(true);
    expect(details.detailsTrimmed).toEqual({ blob: expect.any(Number) });
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

/**
 * 사고 장부 연결(설계 §B·⚙️J8) — 래퍼가 실패를 사고 A 로, 「대상은 있었는데 산출 0」 연속을
 * 사고 B 로 열고, 정상 실행에서 닫는다. 사고 기록은 응답·상태 기록을 막지 않는다.
 */
describe("withSystemTaskStatus 사고 장부", () => {
  /** 산출 선언(`output`)이 있는 작업 — B 판정 대상. */
  const DECLARED_JOB = "collect-instagram";

  /** 이력 조회 모킹: 방금 남긴 SUCCESS 줄(현재 회차)을 맨 앞에, 그 뒤에 직전 이력을 붙인다. */
  function historyWithCurrent(previous: unknown[]) {
    logFindMany.mockImplementation(async () => {
      const current = logCreate.mock.calls.at(-1)?.[0].data;
      return [current, ...previous.map((details) => ({ status: "SUCCESS", details }))].filter(Boolean);
    });
  }

  function createdIncidents(): Array<{ kind: string; errorKind: string | null; jobKey: string }> {
    return incidentCreate.mock.calls.map((c) => c[0].data);
  }

  it("throw 된 오류의 원인 사슬과 종류를 기록한다", async () => {
    const cause = new Error("Proxy response (407) !== 200 when HTTP Tunneling");
    const handler = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause });
    });
    const wrapped = withSystemTaskStatus("job-a", handler);

    await expect(wrapped(makeRequest(`Bearer ${SECRET}`))).rejects.toThrow("fetch failed");

    const update = upsert.mock.calls[1][0].update;
    expect(update.lastErrorMessage).toContain("Proxy response (407)");
    expect(update.lastErrorKind).toBe("proxy_quota");
    expect(logCreate.mock.calls[0][0].data.errorKind).toBe("proxy_quota");
    expect(createdIncidents()).toEqual([expect.objectContaining({ kind: "A", errorKind: "proxy_quota", jobKey: "job-a" })]);
  });

  it("failed:true 본문도 A 사고를 연다", async () => {
    const handler = vi.fn(async () =>
      Response.json({ ok: true, failed: true, failureReason: "대상 4명 전원 조회 실패" }),
    );
    await withSystemTaskStatus("job-a", handler)(makeRequest(`Bearer ${SECRET}`));

    expect(createdIncidents()).toEqual([expect.objectContaining({ kind: "A", errorKind: "unknown" })]);
    expect(upsert.mock.calls[1][0].update.lastErrorKind).toBe("unknown");
  });

  it("비정상 응답은 HTTP 상태로도 종류를 가르고 A 사고를 연다", async () => {
    const handler = vi.fn(async () => Response.json({ error: "요청 한도 초과" }, { status: 429 }));
    await withSystemTaskStatus("job-a", handler)(makeRequest(`Bearer ${SECRET}`));

    expect(createdIncidents()).toEqual([expect.objectContaining({ kind: "A", errorKind: "rate_limit" })]);
  });

  it("성공하면 열린 A 사고를 닫고 종류 표시를 지운다(산출 판정이 없는 작업이라 B 도 함께)", async () => {
    await withSystemTaskStatus("job-a", vi.fn(async () => Response.json({ ok: true })))(
      makeRequest(`Bearer ${SECRET}`),
    );

    expect(incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ jobKey: "job-a", kind: { in: ["A", "B"] } }) }),
    );
    expect(upsert.mock.calls[1][0].update.lastErrorKind).toBeNull();
    expect(incidentCreate).not.toHaveBeenCalled();
  });

  it("산출 선언 작업이 연속 2회 대상>0·산출0 이면 B 사고를 연다", async () => {
    historyWithCurrent([{ targets: 3, produced: 0 }]);
    const handler = vi.fn(async () => Response.json({ ok: true, failed: false, targets: 3, produced: 0 }));
    await withSystemTaskStatus(DECLARED_JOB, handler)(makeRequest(`Bearer ${SECRET}`));

    expect(logFindMany).toHaveBeenCalledWith({
      where: { jobKey: DECLARED_JOB, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 2,
    });
    expect(createdIncidents()).toEqual([expect.objectContaining({ kind: "B", errorKind: null, jobKey: DECLARED_JOB })]);
    expect(incidentCreate.mock.calls[0][0].data.lastMessage).toBe("인스타 지표 대상 3건인데 산출 0");
  });

  it("스토리 수집은 판정 면제라 조회 성공·저장 0 이 연속이어도 B 사고를 열지 않는다(셀러가 스토리를 안 올린 날이 정상)", async () => {
    historyWithCurrent([{ ok: true, failed: false, targets: 5, produced: 0 }]);
    const handler = vi.fn(async () => Response.json({ ok: true, failed: false, targets: 5, produced: 0 }));
    await withSystemTaskStatus("capture-stories", handler)(makeRequest(`Bearer ${SECRET}`));

    expect(recordedStatuses()).toEqual(["RUNNING", "SUCCESS"]);
    expect(incidentCreate).not.toHaveBeenCalled();
    expect(logFindMany).not.toHaveBeenCalled();
  });

  it("판정 면제 작업이 성공하면 남아 있던 B 사고도 A 와 함께 닫는다(면제 전에 열린 거짓 경보 정리)", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true, failed: false, targets: 1, produced: 0 }));
    await withSystemTaskStatus("capture-stories", handler)(makeRequest(`Bearer ${SECRET}`));

    expect(incidentUpdateMany).toHaveBeenCalledTimes(1);
    expect(incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ jobKey: "capture-stories", kind: { in: ["A", "B"] } }) }),
    );
  });

  it("산출 선언 작업의 성공은 A 만 닫고, B 는 산출이 생겨야 닫는다", async () => {
    historyWithCurrent([{ targets: 3, produced: 1 }]);
    const handler = vi.fn(async () => Response.json({ ok: true, targets: 3, produced: 0 }));
    await withSystemTaskStatus(DECLARED_JOB, handler)(makeRequest(`Bearer ${SECRET}`));

    expect(incidentUpdateMany).toHaveBeenCalledTimes(1);
    expect(incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: { in: ["A"] } }) }),
    );
  });

  it("직전 회차에 산출이 있었으면 B 사고를 열지 않는다", async () => {
    historyWithCurrent([{ targets: 3, produced: 1 }]);
    const handler = vi.fn(async () => Response.json({ ok: true, targets: 3, produced: 0 }));
    await withSystemTaskStatus(DECLARED_JOB, handler)(makeRequest(`Bearer ${SECRET}`));

    expect(incidentCreate).not.toHaveBeenCalled();
  });

  it("이력이 연속 횟수만큼 쌓이지 않았으면(첫 회차) B 사고를 열지 않는다", async () => {
    historyWithCurrent([]);
    const handler = vi.fn(async () => Response.json({ ok: true, targets: 3, produced: 0 }));
    await withSystemTaskStatus(DECLARED_JOB, handler)(makeRequest(`Bearer ${SECRET}`));

    expect(incidentCreate).not.toHaveBeenCalled();
  });

  it("이력 details 가 문자열(sqlite)이어도 읽고, 못 읽는 줄은 산출 0 으로 치지 않는다", async () => {
    historyWithCurrent([JSON.stringify({ targets: 2, produced: 0 })]);
    const handler = vi.fn(async () => Response.json({ ok: true, targets: 3, produced: 0 }));
    await withSystemTaskStatus(DECLARED_JOB, handler)(makeRequest(`Bearer ${SECRET}`));
    expect(createdIncidents()).toEqual([expect.objectContaining({ kind: "B" })]);

    incidentCreate.mockClear();
    historyWithCurrent(["{not json"]);
    await withSystemTaskStatus(DECLARED_JOB, handler)(makeRequest(`Bearer ${SECRET}`));
    expect(incidentCreate).not.toHaveBeenCalled();
  });

  it("산출 선언이 없는 작업은 대상>0·산출0 이어도 B 판정을 하지 않는다", async () => {
    historyWithCurrent([{ targets: 3, produced: 0 }]);
    const handler = vi.fn(async () => Response.json({ ok: true, targets: 3, produced: 0 }));
    await withSystemTaskStatus("job-a", handler)(makeRequest(`Bearer ${SECRET}`));

    expect(logFindMany).not.toHaveBeenCalled();
    expect(incidentCreate).not.toHaveBeenCalled();
  });

  it("대상이 0이면 B 사고를 열지도 닫지도 않는다", async () => {
    historyWithCurrent([{ targets: 0, produced: 0 }]);
    const handler = vi.fn(async () => Response.json({ ok: true, targets: 0, produced: 0 }));
    await withSystemTaskStatus(DECLARED_JOB, handler)(makeRequest(`Bearer ${SECRET}`));

    expect(incidentCreate).not.toHaveBeenCalled();
    expect(logFindMany).not.toHaveBeenCalled();
    const kindsClosed = incidentUpdateMany.mock.calls.map((c) => c[0].where.kind.in);
    expect(kindsClosed).toEqual([["A"]]);
    expect(upsert.mock.calls[1][0].update.lastProducedAt).toBeUndefined();
  });

  it("산출이 생기면 B 사고를 닫고 lastProducedAt 을 남긴다", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true, targets: 3, produced: 2 }));
    await withSystemTaskStatus(DECLARED_JOB, handler)(makeRequest(`Bearer ${SECRET}`));

    const closedB = incidentUpdateMany.mock.calls.find((c) => c[0].where.kind.in.includes("B"));
    expect(closedB?.[0].where).toMatchObject({ jobKey: DECLARED_JOB, kind: { in: ["B"] } });
    expect(closedB?.[0].data.normalizedEvidence).toMatchObject({ produced: 2, targets: 3 });
    expect(upsert.mock.calls[1][0].update.lastProducedAt).toBeInstanceOf(Date);
    expect(incidentCreate).not.toHaveBeenCalled();
  });

  it("사고 기록 실패가 응답을 막지 않는다", async () => {
    incidentFindFirst.mockRejectedValue(new Error("incident table down"));
    incidentUpdateMany.mockRejectedValue(new Error("incident table down"));
    logFindMany.mockRejectedValue(new Error("history down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = { ok: true, failed: true, failureReason: "전부 실패" };
    const wrapped = withSystemTaskStatus(DECLARED_JOB, vi.fn(async () => Response.json(body)));

    const res = await wrapped(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(upsert).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    // 성공 경로(닫기·B 이력 조회 실패)도 같다.
    const okBody = { ok: true, targets: 3, produced: 0 };
    const okRes = await withSystemTaskStatus(DECLARED_JOB, vi.fn(async () => Response.json(okBody)))(
      makeRequest(`Bearer ${SECRET}`),
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual(okBody);
    consoleError.mockRestore();
  });
});

describe("withSystemTaskStatus 일시 장애 재시도", () => {
  /** 재시도 1회 작업 / 2회 작업 / 안 함 작업(cron-jobs.ts `retry`). */
  const ONCE_JOB = "naver-order-sync";
  const TWICE_JOB = "capture-stories";
  const NEVER_JOB = "collect-youtube";

  function cronRequest(attempt?: string, auth: string | null = `Bearer ${SECRET}`): Request {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    if (attempt != null) headers["X-Cron-Attempt"] = attempt;
    return new Request("http://localhost/api/cron/x", { headers });
  }

  const upstream503 = () => vi.fn(async () => Response.json({ error: "네이버 서버 오류" }, { status: 503 }));

  it("일시 장애 + 정책 1회 작업의 첫 실패는 재시도 대기 600초를 응답 헤더로 알리고 상태·본문은 그대로다", async () => {
    const res = await withSystemTaskStatus(ONCE_JOB, upstream503())(cronRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBe("600");
    expect(await res.json()).toEqual({ error: "네이버 서버 오류" });
    expect(recordedStatuses()).toEqual(["RUNNING", "ERROR"]);
  });

  it("정책 1회 작업의 2회차 실패는 더 재시도하지 않는다", async () => {
    const res = await withSystemTaskStatus(ONCE_JOB, upstream503())(cronRequest("2"));
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBeNull();
  });

  it("정책 2회 작업의 2회차 실패는 1800초 뒤 한 번 더", async () => {
    const res = await withSystemTaskStatus(TWICE_JOB, upstream503())(cronRequest("2"));
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBe("1800");
  });

  it("failed:true(200) 실질 실패도 일시 장애면 헤더를 붙인다", async () => {
    const handler = vi.fn(async () => Response.json({ ok: true, failed: true, failureReason: "fetch failed <- ECONNRESET" }));
    const res = await withSystemTaskStatus(ONCE_JOB, handler)(cronRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBe("600");
  });

  it("프록시 한도 소진은 재시도하지 않는다", async () => {
    const handler = vi.fn(async () =>
      Response.json({ error: "fetch failed <- Proxy response (407) !== 200 when HTTP Tunneling" }, { status: 500 }),
    );
    const res = await withSystemTaskStatus(ONCE_JOB, handler)(cronRequest());
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBeNull();
  });

  it("「안 함」 작업은 일시 장애여도 헤더를 받지 않는다", async () => {
    const res = await withSystemTaskStatus(NEVER_JOB, upstream503())(cronRequest());
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBeNull();
  });

  it("성공 응답에는 헤더를 붙이지 않는다", async () => {
    const res = await withSystemTaskStatus(ONCE_JOB, vi.fn(async () => Response.json({ ok: true })))(cronRequest());
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBeNull();
  });

  it("수동 실행(기록 게이트 미통과)은 실패해도 헤더를 붙이지 않는다", async () => {
    const res = await withSystemTaskStatus(ONCE_JOB, upstream503())(cronRequest("1", null));
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("회차 헤더가 숫자가 아니면 첫 실행으로, 3을 넘으면 3으로 본다", async () => {
    const garbled = await withSystemTaskStatus(ONCE_JOB, upstream503())(cronRequest("abc"));
    expect(garbled.headers.get("X-Cron-Retry-After-Sec")).toBe("600");
    const huge = await withSystemTaskStatus(TWICE_JOB, upstream503())(cronRequest("99"));
    expect(huge.headers.get("X-Cron-Retry-After-Sec")).toBeNull();
  });

  it("핸들러 예외 + 재시도 예약이면 원 예외를 console.error 로 남기고 500 JSON 에 헤더를 실어 돌려준다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new TypeError("fetch failed", { cause: new Error("connect ECONNRESET") });
    const handler = vi.fn(async () => {
      throw thrown;
    });
    const res = await withSystemTaskStatus(ONCE_JOB, handler)(cronRequest());

    expect(res.status).toBe(500);
    expect(res.headers.get("X-Cron-Retry-After-Sec")).toBe("600");
    expect((await res.json()).error).toContain("ECONNRESET");
    expect(spy.mock.calls.some((call) => call.includes(thrown))).toBe(true);
    expect(recordedStatuses()).toEqual(["RUNNING", "ERROR"]);
    spy.mockRestore();
  });

  it("핸들러 예외인데 재시도가 없으면(마지막 회차) 지금처럼 예외를 다시 던진다", async () => {
    const handler = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNRESET") });
    });
    await expect(withSystemTaskStatus(ONCE_JOB, handler)(cronRequest("2"))).rejects.toThrow("fetch failed");
  });

  it("재시도 회차의 실패는 열린 사고의 반복 횟수를 올리지 않는다(오너 알림 기준 불변)", async () => {
    incidentFindFirst.mockResolvedValue({ id: "inc-open" });
    await withSystemTaskStatus(TWICE_JOB, upstream503())(cronRequest("2"));

    expect(incidentUpdate).toHaveBeenCalledOnce();
    expect(incidentUpdate.mock.calls[0][0].data).not.toHaveProperty("occurrences");
  });

  it("첫 실행 실패는 지금처럼 반복 횟수를 올린다", async () => {
    incidentFindFirst.mockResolvedValue({ id: "inc-open" });
    await withSystemTaskStatus(TWICE_JOB, upstream503())(cronRequest());

    expect(incidentUpdate.mock.calls[0][0].data.occurrences).toEqual({ increment: 1 });
  });

  it("재시도 회차가 성공하면 정상화 증거에 회차와 1층을 남긴다", async () => {
    await withSystemTaskStatus(ONCE_JOB, vi.fn(async () => Response.json({ ok: true })))(cronRequest("2"));

    const data = incidentUpdateMany.mock.calls[0][0].data;
    expect(data.normalizedEvidence.attempt).toBe(2);
    expect(data.layer).toBe(1);
  });

  it("첫 실행 성공은 정상화 증거에 회차를 남기지 않는다", async () => {
    await withSystemTaskStatus(ONCE_JOB, vi.fn(async () => Response.json({ ok: true })))(cronRequest());

    const data = incidentUpdateMany.mock.calls[0][0].data;
    expect(data.normalizedEvidence).not.toHaveProperty("attempt");
    expect(data).not.toHaveProperty("layer");
  });
});

describe("capDetailsForLog — 산출 판정 숫자 보존", () => {
  it("과대 페이로드를 줄여도 targets·produced 는 그대로 남는다(B 판정이 이력에서 읽는다)", () => {
    const capped = capDetailsForLog({
      ok: true,
      targets: 42,
      produced: 0,
      errors: Array.from({ length: 200 }, (_, i) => `seller-${i}: 응답 형식 변경 ${"x".repeat(80)}`),
      blob: "y".repeat(20_000),
      nested: { list: Array.from({ length: 300 }, (_, i) => ({ id: i, note: "z".repeat(50) })) },
    }) as Record<string, unknown>;

    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
    expect(capped.targets).toBe(42);
    expect(capped.produced).toBe(0);
  });
});
