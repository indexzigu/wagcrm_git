import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("@/lib/prisma-client", () => ({
  isRemoteDatabaseUrl: vi.fn(() => true),
}));

import { getPrisma } from "@/lib/prisma";
import { isRemoteDatabaseUrl } from "@/lib/prisma-client";
import {
  incidentSignature,
  normalizeIncidentMessage,
  escalatePendingIncidents,
  recordIncidentOccurrence,
  resolveOpenIncidents,
  RETRY_CYCLE_WINDOW_MS,
} from "@/lib/cron-incident";
import { RETRY_DELAYS_SEC } from "@/lib/cron-jobs";

const findFirst = vi.fn();
const findMany = vi.fn();
const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const executeRaw = vi.fn();
const transaction = vi.fn();
const proxyFindMany = vi.fn();

beforeEach(() => {
  findFirst.mockReset();
  findMany.mockReset().mockResolvedValue([]);
  create.mockReset().mockResolvedValue({ id: "new1" });
  update.mockReset().mockResolvedValue({ id: "old1" });
  updateMany.mockReset().mockResolvedValue({ count: 2 });
  executeRaw.mockReset().mockResolvedValue(1);
  proxyFindMany.mockReset().mockResolvedValue([]);
  vi.mocked(isRemoteDatabaseUrl).mockReturnValue(true);
  const tx = { cronIncident: { findFirst, findMany, create, update, updateMany }, $executeRaw: executeRaw };
  // 트랜잭션 클라이언트와 평소 클라이언트를 같은 mock 으로 묶어 기존 단언을 그대로 쓴다.
  transaction.mockReset().mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
  vi.mocked(getPrisma).mockReturnValue({
    ...tx,
    proxyRequestDaily: { findMany: proxyFindMany },
    $transaction: transaction,
  } as unknown as ReturnType<typeof getPrisma>);
});

describe("normalizeIncidentMessage", () => {
  it("숫자·시각·핸들을 자리표시자로 바꾼다", () => {
    expect(normalizeIncidentMessage("대상 12명 전량 실패 2026-10-18T03:00:00Z @someone")).toBe(
      "대상 #명 전량 실패 <t> @<h>",
    );
  });

  it("uuid·긴 hex 는 <id>, 공백은 압축, 200자로 자른다", () => {
    expect(normalizeIncidentMessage("x  550e8400-e29b-41d4-a716-446655440000   y")).toBe("x <id> y");
    expect(normalizeIncidentMessage("z".repeat(500)).length).toBe(200);
  });
});

describe("incidentSignature", () => {
  it("숫자만 다른 메시지는 같은 서명이다", () => {
    const a = incidentSignature({ jobKey: "j", kind: "A", errorKind: "network", message: "실패 3건" });
    const b = incidentSignature({ jobKey: "j", kind: "A", errorKind: "network", message: "실패 9건" });
    expect(a).toBe(b);
    expect(a).toBe("j|A|network|실패 #건");
  });

  it("errorKind 가 없으면 - 로 쓴다", () => {
    expect(incidentSignature({ jobKey: "j", kind: "B", errorKind: null, message: "m" })).toBe("j|B|-|m");
  });
});

describe("recordIncidentOccurrence", () => {
  const input = { jobKey: "j", kind: "A" as const, errorKind: "timeout" as const, message: "실패 3건" };

  it("같은 서명의 열린 사고에는 덧붙인다", async () => {
    findFirst.mockResolvedValue({ id: "old1" });
    const r = await recordIncidentOccurrence(input);
    expect(r).toEqual({ id: "old1", opened: false });
    expect(findFirst).toHaveBeenCalledWith({
      where: { signature: "j|A|timeout|실패 #건", status: { in: ["open", "waiting_owner"] } },
      orderBy: { firstSeenAt: "desc" },
    });
    expect(update.mock.calls[0][0].data.occurrences).toEqual({ increment: 1 });
    expect(update.mock.calls[0][0].data.lastMessage).toBe("실패 3건");
    expect(create).not.toHaveBeenCalled();
  });

  it("재시도 회차의 실패는 열린 사고의 반복 횟수를 올리지 않고 마지막 메시지·시각만 갱신한다(⚙️K1)", async () => {
    findFirst.mockResolvedValue({ id: "old1" });
    const at = new Date("2026-10-21T01:10:00Z");
    const r = await recordIncidentOccurrence({ ...input, message: "실패 4건", at, isRetryAttempt: true });
    expect(r).toEqual({ id: "old1", opened: false });
    const data = update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("occurrences");
    expect(data).toEqual({ lastSeenAt: at, lastMessage: "실패 4건" });
    expect(create).not.toHaveBeenCalled();
  });

  it("재시도 회차라도 열린 사고가 없으면 새로 연다(반복 1)", async () => {
    findFirst.mockResolvedValue(null);
    const r = await recordIncidentOccurrence({ ...input, isRetryAttempt: true });
    expect(r).toEqual({ id: "new1", opened: true });
    expect(create).toHaveBeenCalledOnce();
  });

  it("재시도 회차가 같은 오류 종류·다른 메시지로 실패하면 그 작업의 열린 A 사고에 접는다(새 사고 없음)", async () => {
    // 1번째 조회 = 같은 서명(없음), 2번째 조회 = 그 작업의 열린 A(있음).
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "a1" });
    updateMany.mockResolvedValue({ count: 1 });
    const at = new Date("2026-10-21T01:10:00Z");
    const r = await recordIncidentOccurrence({ ...input, message: "다른 문구로 시간 초과", at, isRetryAttempt: true });
    expect(r).toEqual({ id: "a1", opened: false });
    expect(findFirst.mock.calls[1][0]).toEqual({
      where: { jobKey: "j", kind: "A", status: { in: ["open", "waiting_owner"] } },
      orderBy: { lastSeenAt: "desc" },
    });
    const arg = updateMany.mock.calls[0][0];
    // 그 사이 정상화로 닫힌 사고를 되살리지 않도록 아직 열린 것만 바꾼다.
    expect(arg.where).toEqual({ id: "a1", status: { in: ["open", "waiting_owner"] } });
    expect(arg.data).toEqual({ lastSeenAt: at, lastMessage: "다른 문구로 시간 초과" });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("재시도 회차가 일시 장애가 아닌 종류로 실패하면 접지 않고 새 사고를 연다", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "a1" });
    const r = await recordIncidentOccurrence({ ...input, errorKind: "auth", message: "HTTP 401", isRetryAttempt: true });
    expect(r).toEqual({ id: "new1", opened: true });
    // 작업 단위 조회 자체를 하지 않는다 — 같은 서명 조회 1번뿐.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({ kind: "A", errorKind: "auth" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("재시도 회차인데 그 작업에 열린 A 가 하나도 없으면 반복 1 의 새 사고를 연다", async () => {
    findFirst.mockResolvedValue(null);
    const r = await recordIncidentOccurrence({ ...input, message: "다른 문구", isRetryAttempt: true });
    expect(r).toEqual({ id: "new1", opened: true });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
    // 반복 횟수는 스키마 기본값(1)에 맡긴다 — 따로 올리지 않는다.
    expect(create.mock.calls[0][0].data).not.toHaveProperty("occurrences");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("접으려던 A 가 그 사이 닫혔으면(바뀐 줄 0) 새 사고를 연다", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "a1" });
    updateMany.mockResolvedValue({ count: 0 });
    const r = await recordIncidentOccurrence({ ...input, message: "다른 문구", isRetryAttempt: true });
    expect(r).toEqual({ id: "new1", opened: true });
    expect(create).toHaveBeenCalledOnce();
  });

  it("재시도 회차의 접기는 작업 단위 자문 잠금도 잡는다", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "a1" });
    updateMany.mockResolvedValue({ count: 1 });
    await recordIncidentOccurrence({ ...input, message: "다른 문구", isRetryAttempt: true });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(executeRaw.mock.calls[0][1]).toBe("j|A|timeout|다른 문구");
    expect(executeRaw.mock.calls[1][1]).toBe("job:j|A");
    // 작업 잠금은 작업 단위 조회보다 먼저다.
    expect(executeRaw.mock.invocationCallOrder[1]).toBeLessThan(findFirst.mock.invocationCallOrder[1]);
  });

  it("열린 사고가 없으면 새로 연다", async () => {
    findFirst.mockResolvedValue(null);
    const at = new Date("2026-10-18T00:00:00Z");
    const r = await recordIncidentOccurrence({ ...input, at });
    expect(r).toEqual({ id: "new1", opened: true });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: "open",
      signature: "j|A|timeout|실패 #건",
      kind: "A",
      errorKind: "timeout",
      jobKey: "j",
      firstSeenAt: at,
      lastSeenAt: at,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("lastMessage 는 원문을 1000자로 자른다", async () => {
    findFirst.mockResolvedValue(null);
    await recordIncidentOccurrence({ ...input, message: "b".repeat(1500) });
    expect(create.mock.calls[0][0].data.lastMessage).toHaveLength(1000);
  });

  it("원격 DB 에서는 같은 서명 기록을 자문 잠금 안에서 한다", async () => {
    findFirst.mockResolvedValue(null);
    await recordIncidentOccurrence(input);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = (executeRaw.mock.calls[0][0] as string[]).join("?");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(executeRaw.mock.calls[0][1]).toBe("j|A|timeout|실패 #건");
    // 잠금이 조회·쓰기보다 먼저다.
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[0]);
    expect(findFirst.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it("sqlite 에서는 잠금 없이 기록한다", async () => {
    vi.mocked(isRemoteDatabaseUrl).mockReturnValue(false);
    findFirst.mockResolvedValue(null);
    const r = await recordIncidentOccurrence(input);
    expect(r).toEqual({ id: "new1", opened: true });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("DB 오류는 console.error 후 null", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findFirst.mockRejectedValue(new Error("db down"));
    expect(await recordIncidentOccurrence(input)).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("resolveOpenIncidents", () => {
  const at = new Date("2026-10-18T00:00:00Z");

  it("PR 이 없는 open·waiting_owner 사고만 닫고 개수를 돌려준다", async () => {
    const n = await resolveOpenIncidents({
      jobKey: "j",
      kinds: ["A", "B"],
      evidence: { runAt: at, produced: 5, targets: 5 },
    });
    expect(n).toBe(2);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      jobKey: "j",
      kind: { in: ["A", "B"] },
      status: { in: ["open", "waiting_owner"] },
      prNumber: null,
    });
    expect(arg.data.status).toBe("resolved");
    expect(arg.data.normalizedAt).toBeInstanceOf(Date);
    expect(arg.data.normalizedEvidence).toEqual({ runAt: at.toISOString(), produced: 5, targets: 5 });
  });

  it("재시도 회차(2 이상)의 정상화는 이번 재시도 주기 안에 본 A 에만 회차를 남기고 1층(자동 재시도)으로 찍는다", async () => {
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const n = await resolveOpenIncidents({ jobKey: "j", kinds: ["A"], evidence: { runAt: at, attempt: 2 } });
    expect(n).toBe(1);
    const first = updateMany.mock.calls[0][0];
    expect(first.where).toEqual({
      jobKey: "j",
      kind: "A",
      status: { in: ["open", "waiting_owner"] },
      prNumber: null,
      lastSeenAt: { gte: new Date(at.getTime() - RETRY_CYCLE_WINDOW_MS), lte: at },
    });
    expect(first.data.normalizedEvidence).toEqual({ runAt: at.toISOString(), attempt: 2 });
    expect(first.data.layer).toBe(1);
  });

  it("같은 정상화로 닫히는 B·오래된 조치대기 A 는 회차·층 없이 평소처럼 닫는다", async () => {
    // 재시도 주기 창 안의 A 1건 + 그 밖(어제 본 조치대기 A·B) 2건.
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 2 });
    const n = await resolveOpenIncidents({ jobKey: "j", kinds: ["A", "B"], evidence: { runAt: at, attempt: 3 } });
    expect(n).toBe(3);
    expect(updateMany).toHaveBeenCalledTimes(2);
    const rest = updateMany.mock.calls[1][0];
    // 첫 쓰기로 닫힌 줄은 열린 상태 조건에서 빠지므로, 둘째 쓰기는 남은 열린 사고 전부(B·옛 A)다.
    expect(rest.where).toEqual({
      jobKey: "j",
      kind: { in: ["A", "B"] },
      status: { in: ["open", "waiting_owner"] },
      prNumber: null,
    });
    expect(rest.data.normalizedEvidence).toEqual({ runAt: at.toISOString() });
    expect(rest.data).not.toHaveProperty("layer");
    // 두 쓰기는 한 트랜잭션 안에서 찍힌 것 먼저.
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("A 를 닫지 않는 호출(B 만)은 재시도 회차여도 회차·층을 찍지 않는다", async () => {
    await resolveOpenIncidents({ jobKey: "j", kinds: ["B"], evidence: { runAt: at, attempt: 2 } });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const data = updateMany.mock.calls[0][0].data;
    expect(data.normalizedEvidence).not.toHaveProperty("attempt");
    expect(data).not.toHaveProperty("layer");
  });

  it("재시도 주기 창은 대기 간격 합 + 최장 실행 3회보다 넉넉하다", () => {
    const waitsMs = RETRY_DELAYS_SEC.reduce((s, v) => s + v, 0) * 1000;
    const curlRunsMs = 3 * 900 * 1000;
    const appDownWaitMs = 120 * 1000;
    expect(RETRY_CYCLE_WINDOW_MS).toBeGreaterThan(waitsMs + curlRunsMs + appDownWaitMs);
  });

  it("첫 실행(회차 1)의 정상화는 회차·층을 남기지 않는다", async () => {
    await resolveOpenIncidents({ jobKey: "j", kinds: ["A"], evidence: { runAt: at, attempt: 1 } });
    const data = updateMany.mock.calls[0][0].data;
    expect(data.normalizedEvidence).not.toHaveProperty("attempt");
    expect(data).not.toHaveProperty("layer");
  });

  it("DB 오류는 console.error 후 0", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    updateMany.mockRejectedValue(new Error("db down"));
    expect(await resolveOpenIncidents({ jobKey: "j", kinds: ["A"], evidence: { runAt: at } })).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("escalatePendingIncidents", () => {
  const now = new Date("2026-10-18T09:00:00Z");

  it("open 사고 중 승격 대상만 waiting_owner 로 올리고 조치 문구를 붙인다", async () => {
    findMany.mockResolvedValue([
      { id: "b1", kind: "B", errorKind: null, occurrences: 1 },
      { id: "n1", kind: "A", errorKind: "network", occurrences: 1 },
      { id: "n2", kind: "A", errorKind: "network", occurrences: 2 },
      { id: "p1", kind: "A", errorKind: "proxy_quota", occurrences: 1 },
    ]);
    const n = await escalatePendingIncidents(now);
    expect(n).toBe(3);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ status: "open" });
    const ids = update.mock.calls.map((c) => c[0].where.id);
    expect(ids).toEqual(["b1", "n2", "p1"]);
    const first = update.mock.calls[0][0];
    // 그 사이 닫힌 사고를 되살리지 않도록 open 인 것만 바꾼다.
    expect(first.where).toEqual({ id: "b1", status: "open" });
    expect(first.data.status).toBe("waiting_owner");
    expect(first.data.ownerAction).toMatch(/^대상은 있는데/);
    expect(update.mock.calls[2][0].data.ownerAction).toMatch(/^프록시 월 한도/);
  });

  it("두 번 불러도 이미 올린 사고는 다시 바꾸지 않는다", async () => {
    findMany.mockResolvedValueOnce([{ id: "b1", kind: "B", errorKind: null, occurrences: 1 }]).mockResolvedValueOnce([]);
    expect(await escalatePendingIncidents(now)).toBe(1);
    expect(await escalatePendingIncidents(now)).toBe(0);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("조회 사이에 상태가 바뀐 사고(P2025)는 세지 않고 넘어간다", async () => {
    findMany.mockResolvedValue([
      { id: "b1", kind: "B", errorKind: null, occurrences: 1 },
      { id: "b2", kind: "B", errorKind: null, occurrences: 1 },
    ]);
    update.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "P2025" }));
    expect(await escalatePendingIncidents(now)).toBe(1);
  });

  const at = new Date("2026-10-18T00:30:00Z"); // KST 2026-10-18 09:30

  it("조회에 작업 키·원문·마지막 시각을 함께 가져온다", async () => {
    await escalatePendingIncidents(now);
    expect(findMany.mock.calls[0][0].select).toMatchObject({ jobKey: true, lastMessage: true, lastSeenAt: true });
  });

  it("알려진 원인이면 원인·확신·맞는 할 일·처리 층 2를 기록한다", async () => {
    findMany.mockResolvedValue([
      { id: "t1", jobKey: "refresh-instagram-token", kind: "A", errorKind: "auth", occurrences: 1, lastMessage: "토큰 갱신 실패 (code 190)", lastSeenAt: at },
    ]);
    expect(await escalatePendingIncidents(now)).toBe(1);
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: "waiting_owner",
      cause: "인스타그램 접근 토큰 만료",
      causeConfidence: "확정",
      layer: 2,
    });
    expect(data.ownerAction).toMatch(/^인스타그램 접근 토큰이 만료됐습니다/);
    // 프록시를 안 쓰는 작업은 장부를 읽지 않는다.
    expect(proxyFindMany).not.toHaveBeenCalled();
  });

  it("안 맞으면 지금처럼 종류별 일반 문장이고 원인 칸은 비운다", async () => {
    findMany.mockResolvedValue([
      { id: "u1", jobKey: "capture-stories", kind: "A", errorKind: "unknown", occurrences: 1, lastMessage: "대상 3건 전량 실패(성공 0)", lastSeenAt: at },
    ]);
    expect(await escalatePendingIncidents(now)).toBe(1);
    const data = update.mock.calls[0][0].data;
    expect(data).toEqual({ status: "waiting_owner", ownerAction: "설정의 「자동화 작업 상태」에서 작동 로그를 확인해 주세요." });
  });

  const orderRow = (occurrences: number) => ({
    id: "o1",
    jobKey: "naver-order-sync",
    kind: "A",
    errorKind: "network",
    occurrences,
    lastMessage: "fetch failed",
    lastSeenAt: at,
  });

  it("장부 정황만 있는 일시 장애는 첫 회에 올리지 않는다(장부만으로는 후보라 승격 규칙을 건너뛰지 않는다)", async () => {
    findMany.mockResolvedValue([orderRow(1)]);
    proxyFindMany.mockResolvedValue([{ requests: 30, failures: 30 }]);
    expect(await escalatePendingIncidents(now)).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("장부 정황 + 일시 장애 2회째면 프록시 한도 후보로 올린다", async () => {
    findMany.mockResolvedValue([orderRow(2)]);
    proxyFindMany.mockResolvedValue([
      { requests: 30, failures: 30 },
      { requests: 4, failures: 4 },
    ]);
    expect(await escalatePendingIncidents(now)).toBe(1);
    expect(proxyFindMany.mock.calls[0][0].where).toEqual({ day: "2026-10-18", source: "cron:naver-order-sync" });
    expect(update.mock.calls[0][0].data).toMatchObject({ cause: "프록시 월 한도 소진", causeConfidence: "후보", layer: 2 });
  });

  it("장부 요청이 너무 적으면(1/1) 프록시 한도로 보지 않고 일반 문장을 쓴다", async () => {
    findMany.mockResolvedValue([orderRow(2)]);
    proxyFindMany.mockResolvedValue([{ requests: 1, failures: 1 }]);
    expect(await escalatePendingIncidents(now)).toBe(1);
    expect(update.mock.calls[0][0].data).toEqual({
      status: "waiting_owner",
      ownerAction: "같은 오류가 연속으로 났습니다. 외부 서비스 상태와 서버의 인터넷 연결을 확인해 주세요.",
    });
  });

  it("문구가 407 을 말하는 프록시 한도는 지금처럼 첫 회에 확정으로 올린다", async () => {
    findMany.mockResolvedValue([
      { id: "q1", jobKey: "naver-order-sync", kind: "A", errorKind: "proxy_quota", occurrences: 1, lastMessage: "fetch failed <- Proxy response (407)", lastSeenAt: at },
    ]);
    expect(await escalatePendingIncidents(now)).toBe(1);
    expect(update.mock.calls[0][0].data).toMatchObject({ cause: "프록시 월 한도 소진", causeConfidence: "확정", layer: 2 });
  });

  it("한 사고의 판정이 던져도 나머지 사고는 계속 올린다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockResolvedValue([
      // 깨진 시각 — 장부 날짜 계산(toKstYmd)이 RangeError 를 던진다.
      { ...orderRow(2), id: "bad", lastSeenAt: new Date(Number.NaN) },
      { id: "b1", jobKey: "capture-stories", kind: "B", errorKind: null, occurrences: 1, lastMessage: null, lastSeenAt: at },
    ]);
    expect(await escalatePendingIncidents(now)).toBe(1);
    expect(update.mock.calls.map((c) => c[0].where.id)).toEqual(["b1"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("장부에 성공이 섞였거나 요청이 0이면 프록시 한도가 아니다(일시 장애 1회는 그대로 대기)", async () => {
    findMany.mockResolvedValue([orderRow(1)]);
    proxyFindMany.mockResolvedValue([{ requests: 30, failures: 29 }]);
    expect(await escalatePendingIncidents(now)).toBe(0);
    proxyFindMany.mockResolvedValue([]);
    expect(await escalatePendingIncidents(now)).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("장부 조회가 실패해도 승격은 멈추지 않고 일반 문장을 쓴다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockResolvedValue([
      { id: "o2", jobKey: "naver-settlement-sync", kind: "A", errorKind: "unknown", occurrences: 1, lastMessage: "날짜 2건 실패", lastSeenAt: at },
    ]);
    proxyFindMany.mockRejectedValue(new Error("ledger down"));
    expect(await escalatePendingIncidents(now)).toBe(1);
    expect(update.mock.calls[0][0].data).toEqual({
      status: "waiting_owner",
      ownerAction: "설정의 「자동화 작업 상태」에서 작동 로그를 확인해 주세요.",
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("같은 작업 사고가 여럿이어도 장부는 작업·날짜당 한 번만 읽는다", async () => {
    findMany.mockResolvedValue([
      { id: "x1", jobKey: "collect-qnas", kind: "A", errorKind: "unknown", occurrences: 1, lastMessage: "a", lastSeenAt: at },
      { id: "x2", jobKey: "collect-qnas", kind: "A", errorKind: "unknown", occurrences: 1, lastMessage: "b", lastSeenAt: at },
    ]);
    proxyFindMany.mockResolvedValue([{ requests: 2, failures: 2 }]);
    expect(await escalatePendingIncidents(now)).toBe(2);
    expect(proxyFindMany).toHaveBeenCalledTimes(1);
  });

  it("DB 오류는 던지지 않고 console.error 후 0", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockRejectedValue(new Error("db down"));
    expect(await escalatePendingIncidents(now)).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
