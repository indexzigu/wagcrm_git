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
  recordIncidentOccurrence,
  resolveOpenIncidents,
} from "@/lib/cron-incident";

const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const executeRaw = vi.fn();
const transaction = vi.fn();

beforeEach(() => {
  findFirst.mockReset();
  create.mockReset().mockResolvedValue({ id: "new1" });
  update.mockReset().mockResolvedValue({ id: "old1" });
  updateMany.mockReset().mockResolvedValue({ count: 2 });
  executeRaw.mockReset().mockResolvedValue(1);
  vi.mocked(isRemoteDatabaseUrl).mockReturnValue(true);
  const tx = { cronIncident: { findFirst, create, update, updateMany }, $executeRaw: executeRaw };
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

  it("open 사고만 닫고 개수를 돌려준다", async () => {
    const n = await resolveOpenIncidents({
      jobKey: "j",
      kinds: ["A", "B"],
      evidence: { runAt: at, produced: 5, targets: 5 },
    });
    expect(n).toBe(2);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ jobKey: "j", kind: { in: ["A", "B"] }, status: "open" });
    expect(arg.data.status).toBe("resolved");
    expect(arg.data.normalizedAt).toBeInstanceOf(Date);
    expect(arg.data.normalizedEvidence).toEqual({ runAt: at.toISOString(), produced: 5, targets: 5 });
  });

  it("DB 오류는 console.error 후 0", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    updateMany.mockRejectedValue(new Error("db down"));
    expect(await resolveOpenIncidents({ jobKey: "j", kinds: ["A"], evidence: { runAt: at } })).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
