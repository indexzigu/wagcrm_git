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
} from "@/lib/cron-incident";

const findFirst = vi.fn();
const findMany = vi.fn();
const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const executeRaw = vi.fn();
const transaction = vi.fn();

beforeEach(() => {
  findFirst.mockReset();
  findMany.mockReset().mockResolvedValue([]);
  create.mockReset().mockResolvedValue({ id: "new1" });
  update.mockReset().mockResolvedValue({ id: "old1" });
  updateMany.mockReset().mockResolvedValue({ count: 2 });
  executeRaw.mockReset().mockResolvedValue(1);
  vi.mocked(isRemoteDatabaseUrl).mockReturnValue(true);
  const tx = { cronIncident: { findFirst, findMany, create, update, updateMany }, $executeRaw: executeRaw };
  // 트랜잭션 클라이언트와 평소 클라이언트를 같은 mock 으로 묶어 기존 단언을 그대로 쓴다.
  transaction.mockReset().mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
  vi.mocked(getPrisma).mockReturnValue({
    ...tx,
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

  it("재시도 회차(2 이상)의 정상화는 증거에 회차를 남기고 1층(자동 재시도)으로 찍는다", async () => {
    await resolveOpenIncidents({ jobKey: "j", kinds: ["A"], evidence: { runAt: at, attempt: 2 } });
    const data = updateMany.mock.calls[0][0].data;
    expect(data.normalizedEvidence).toEqual({ runAt: at.toISOString(), attempt: 2 });
    expect(data.layer).toBe(1);
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

  it("DB 오류는 던지지 않고 console.error 후 0", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findMany.mockRejectedValue(new Error("db down"));
    expect(await escalatePendingIncidents(now)).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
