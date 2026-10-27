// 결재 대기 알림 목록(outbox) 크론 계약.
//   ① 인증 — 공유 시크릿 SSOT(`@/lib/cron-auth`). 미인증이면 DB 를 읽지 않는다
//   ② GET — 쓰기 기안 · 결재 대기 · 미알림 · 올라온 지 5분 지난 것만 묻는다(정산 자동 실행이 먼저 처리할 틈)
//   ③ GET — 3건까지는 기안마다 대상 이름을 풀어 1통씩, 4건부터는 이름 조회 없이 묶음 1통
//   ④ POST — 지정한 기안의 미알림 칸만 지금 시각으로 바꾼다, 모르는 칸·모양은 400
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/agent/resolve-entity-label", () => ({
  resolveEntityLabel: vi.fn(),
  resolveProposalArgLabels: vi.fn(),
}));

import * as routeModule from "../route";
import { GET, POST } from "../route";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getPrisma } from "@/lib/prisma";
import { resolveEntityLabel, resolveProposalArgLabels } from "@/lib/agent/resolve-entity-label";

const NOW = new Date("2026-10-27T01:30:00Z"); // KST 10:30

const findMany = vi.fn();
const updateMany = vi.fn();

const get = () => new Request("http://t/api/cron/approval-outbox");
const post = (body: unknown) =>
  new Request("http://t/api/cron/approval-outbox", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `기안 ${id}`,
    resultSummary: `기안 ${id} 내용`,
    payload: { action: "add_entity_memo", args: {} },
    createdBy: "AGENT_WORKER",
    createdAt: new Date("2026-10-27T01:00:00Z"),
    targetEntityType: "SELLER",
    targetEntityId: `s-${id}`,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com");
  findMany.mockReset().mockResolvedValue([]);
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  vi.mocked(verifyCronAuth).mockReset().mockReturnValue(true);
  vi.mocked(resolveEntityLabel).mockReset().mockResolvedValue("테스트셀러");
  vi.mocked(resolveProposalArgLabels).mockReset().mockResolvedValue(null);
  vi.mocked(getPrisma).mockReturnValue({
    actionProposal: { findMany, updateMany },
  } as unknown as ReturnType<typeof getPrisma>);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("approval-outbox 크론", () => {
  it("세그먼트 설정(dynamic)을 내보내지 않는다 — cacheComponents 빌드가 거부한다", () => {
    expect("dynamic" in routeModule).toBe(false);
  });

  it("미인증이면 GET·POST 모두 401 이고 DB 를 읽지 않는다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(false);
    expect((await GET(get())).status).toBe(401);
    expect((await POST(post({ acks: [] }))).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("쓰기 기안 · 결재 대기 · 미알림 · 5분 지난 것만 오래된 순으로 묻는다", async () => {
    await GET(get());
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      ownerNotifiedAt: null,
      createdAt: { lte: new Date(NOW.getTime() - 5 * 60 * 1000) },
    });
    expect(args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("보낼 것이 없으면 빈 목록", async () => {
    const res = await GET(get());
    expect(await res.json()).toEqual({ ok: true, messages: [] });
  });

  it("3건까지는 대상 이름을 풀어 기안마다 1통 — 내용·링크가 실린다", async () => {
    findMany.mockResolvedValue([row("a"), row("b")]);
    const body = await (await GET(get())).json();
    expect(body.messages.map((m: { key: string }) => m.key)).toEqual(["approval-a", "approval-b"]);
    expect(body.messages[0]).toMatchObject({ icon: "📝", ackField: "ownerNotifiedAt", proposalIds: ["a"] });
    expect(body.messages[0].detail).toContain("대상: 셀러 테스트셀러");
    expect(body.messages[0].detail).toContain("기안 a 내용");
    expect(body.messages[0].detail).toContain("열기: https://crm.example.com/approvals/a");
    expect(resolveEntityLabel).toHaveBeenCalledWith("SELLER", "s-a");
  });

  it("sqlite 문자열 payload 도 역직렬화해 종류를 읽는다", async () => {
    findMany.mockResolvedValue([row("a", { payload: JSON.stringify({ action: "confirm_settlement", args: {} }) })]);
    const body = await (await GET(get())).json();
    expect(body.messages[0].detail.split("\n")[0]).toBe("정산 확정");
  });

  it("4건부터는 이름 조회 없이 묶음 1통으로 전부 싣는다", async () => {
    findMany.mockResolvedValue(["a", "b", "c", "d"].map((id) => row(id)));
    const body = await (await GET(get())).json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ title: "결재 대기 4건", proposalIds: ["a", "b", "c", "d"] });
    expect(resolveEntityLabel).not.toHaveBeenCalled();
  });

  it("조회가 실패하면 500 · ok:false", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    const res = await GET(get());
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it("POST 는 지정한 기안의 미알림 칸만 지금 시각으로 찍는다(중복 id 는 한 번)", async () => {
    updateMany.mockResolvedValue({ count: 2 });
    const res = await POST(post({ acks: [{ proposalIds: ["a", "b"], ackField: "ownerNotifiedAt" }, { proposalIds: ["a"], ackField: "ownerNotifiedAt" }] }));
    expect(await res.json()).toEqual({ ok: true, updated: 2 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] }, ownerNotifiedAt: null },
      data: { ownerNotifiedAt: NOW },
    });
  });

  it("POST 의 빈 확인은 DB 를 건드리지 않는다", async () => {
    expect(await (await POST(post({ acks: [] }))).json()).toEqual({ ok: true, updated: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON 아님", "not json"],
    ["acks 없음", {}],
    ["사고 칸", { acks: [{ proposalIds: ["a"], ackField: "alertedAt" }] }],
    ["사고 id 칸 이름", { acks: [{ incidentIds: ["a"], ackField: "ownerNotifiedAt" }] }],
    ["id 가 문자열 아님", { acks: [{ proposalIds: [1], ackField: "ownerNotifiedAt" }] }],
  ])("POST 형식 오류(%s)는 400 이고 아무것도 바꾸지 않는다", async (_label, body) => {
    expect((await POST(post(body))).status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
