// 사고 알림 목록(outbox) 크론 계약.
//   ① 인증 — 공유 시크릿 SSOT(`@/lib/cron-auth`). 미인증이면 DB 를 읽지 않는다
//   ② immediate — 알림 직전 재확인으로 이미 정상화된 건은 보내지 않고 닫은 뒤 C 사고를 남긴다
//   ③ immediate — 알렸던 사고가 정상화되면 정상화 메시지를 만든다
//   ④ digest — 막은 개수는 KST 전날 08:00 ~ 오늘 08:00, 정상화 목록은 그 창 끝 기준 7일 안의 미요약분
//   ⑤ POST — 지정한 사고의 지정한 칸만 지금 시각으로 바꾼다, 모르는 칸은 400
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/cron-incident", () => ({
  escalatePendingIncidents: vi.fn(),
  recordIncidentOccurrence: vi.fn(),
  resolveOpenIncidents: vi.fn(),
}));

import * as routeModule from "../route";
import { GET, POST } from "../route";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getPrisma } from "@/lib/prisma";
import { escalatePendingIncidents, recordIncidentOccurrence, resolveOpenIncidents } from "@/lib/cron-incident";

const NOW = new Date("2026-10-18T00:30:00Z"); // KST 09:30

const incidentFindMany = vi.fn();
const incidentUpdate = vi.fn();
const incidentUpdateMany = vi.fn();
const incidentCount = vi.fn();
const statusFindMany = vi.fn();

const get = (mode: string) => new Request(`http://t/api/cron/incident-outbox?mode=${mode}`);
const post = (body: unknown) =>
  new Request("http://t/api/cron/incident-outbox", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function row(over: Record<string, unknown> = {}) {
  return {
    id: "inc1",
    jobKey: "naver-settlement-sync",
    kind: "A",
    errorKind: "network",
    status: "waiting_owner",
    firstSeenAt: new Date("2026-10-17T18:00:00Z"),
    lastSeenAt: new Date("2026-10-17T22:00:00Z"),
    ownerAction: "외부 서비스 상태를 확인해 주세요.",
    prNumber: null,
    normalizedAt: null,
    normalizedEvidence: null,
    actions: null,
    alertedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  incidentFindMany.mockReset().mockResolvedValue([]);
  incidentUpdate.mockReset().mockResolvedValue({});
  incidentUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  incidentCount.mockReset().mockResolvedValue(0);
  statusFindMany.mockReset().mockResolvedValue([]);
  vi.mocked(verifyCronAuth).mockReset().mockReturnValue(true);
  vi.mocked(escalatePendingIncidents).mockReset().mockResolvedValue(0);
  vi.mocked(recordIncidentOccurrence).mockReset().mockResolvedValue({ id: "c1", opened: true });
  vi.mocked(resolveOpenIncidents).mockReset().mockResolvedValue(1);
  vi.mocked(getPrisma).mockReturnValue({
    cronIncident: {
      findMany: incidentFindMany,
      update: incidentUpdate,
      updateMany: incidentUpdateMany,
      count: incidentCount,
    },
    systemTaskStatus: { findMany: statusFindMany },
  } as unknown as ReturnType<typeof getPrisma>);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** findMany 호출을 조회 조건으로 갈라 응답한다 — 재확인 대상(waiting_owner·미알림) / 정상화 알림 대상 */
function routeFindMany(waiting: unknown[], recovered: unknown[]) {
  incidentFindMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.status === "waiting_owner") return waiting;
    if (where.status === "resolved") return recovered;
    return [];
  });
}

describe("incident-outbox 크론", () => {
  it("세그먼트 설정(dynamic)을 내보내지 않는다 — cacheComponents 빌드가 거부한다, GET 은 기본이 동적", () => {
    expect("dynamic" in routeModule).toBe(false);
  });

  it("미인증이면 GET·POST 모두 401 이고 DB 를 읽지 않는다", async () => {
    vi.mocked(verifyCronAuth).mockReturnValue(false);
    expect((await GET(get("immediate"))).status).toBe(401);
    expect((await POST(post({ acks: [] }))).status).toBe(401);
    expect(incidentFindMany).not.toHaveBeenCalled();
    expect(escalatePendingIncidents).not.toHaveBeenCalled();
  });

  it("모르는 mode 는 400", async () => {
    expect((await GET(get("weekly"))).status).toBe(400);
  });

  it("immediate: 승격을 먼저 돌리고, 미알림 조치대기 사고를 즉시 알림으로 만든다", async () => {
    routeFindMany([row()], []);
    statusFindMany.mockResolvedValue([
      { jobKey: "naver-settlement-sync", status: "ERROR", lastRunAt: new Date("2026-10-17T22:00:00Z") },
    ]);
    const body = await (await GET(get("immediate"))).json();
    expect(escalatePendingIncidents).toHaveBeenCalledTimes(1);
    expect(body.ok).toBe(true);
    expect(body.messages).toEqual([
      {
        key: "incident-inc1",
        icon: "🙋",
        title: "네이버 정산 동기화 조치대기",
        detail: "원인: 네트워크 끊김\n조치: 외부 서비스 상태를 확인해 주세요.",
        ackField: "alertedAt",
        incidentIds: ["inc1"],
      },
    ]);
    expect(incidentUpdate).not.toHaveBeenCalled();
  });

  it("immediate: 마지막 발생 뒤 성공한 작업은 보내지 않고 사고를 막힘으로 닫고 C 사고를 남긴다", async () => {
    const lastRunAt = new Date("2026-10-18T00:00:00Z");
    routeFindMany([row()], []);
    statusFindMany.mockResolvedValue([{ jobKey: "naver-settlement-sync", status: "SUCCESS", lastRunAt }]);
    const body = await (await GET(get("immediate"))).json();
    expect(body.messages).toEqual([]);
    expect(incidentUpdate).toHaveBeenCalledWith({
      where: { id: "inc1", status: "waiting_owner", prNumber: null },
      data: {
        status: "resolved",
        suppressedAt: NOW,
        normalizedAt: NOW,
        normalizedEvidence: { runAt: lastRunAt.toISOString(), suppressed: true },
      },
    });
    expect(recordIncidentOccurrence).toHaveBeenCalledWith({
      jobKey: "naver-settlement-sync",
      kind: "C",
      errorKind: null,
      message: "알림 직전 정상화 확인",
    });
    expect(resolveOpenIncidents).toHaveBeenCalledWith({
      jobKey: "naver-settlement-sync",
      kinds: ["C"],
      evidence: { runAt: lastRunAt },
    });
  });

  it("immediate: 성공 기록이어도 마지막 발생보다 이르면 막지 않는다", async () => {
    routeFindMany([row()], []);
    statusFindMany.mockResolvedValue([
      { jobKey: "naver-settlement-sync", status: "SUCCESS", lastRunAt: new Date("2026-10-17T21:00:00Z") },
    ]);
    const body = await (await GET(get("immediate"))).json();
    expect(body.messages).toHaveLength(1);
    expect(recordIncidentOccurrence).not.toHaveBeenCalled();
  });

  it.each([
    ["산출 시각이 마지막 발생보다 이르다", new Date("2026-10-17T21:00:00Z")],
    ["산출 기록이 없다", null],
  ])("immediate: B 는 SUCCESS·새 실행이어도 %s면 막지 않고 보낸다", async (_label, lastProducedAt) => {
    routeFindMany([row({ kind: "B", errorKind: null })], []);
    statusFindMany.mockResolvedValue([
      {
        jobKey: "naver-settlement-sync",
        status: "SUCCESS",
        lastRunAt: new Date("2026-10-18T00:00:00Z"),
        lastProducedAt,
      },
    ]);
    const body = await (await GET(get("immediate"))).json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].ackField).toBe("alertedAt");
    expect(incidentUpdate).not.toHaveBeenCalled();
    expect(recordIncidentOccurrence).not.toHaveBeenCalled();
  });

  it("immediate: B 는 마지막 발생 뒤 실제 산출이 생겼으면 막고 C 사고를 남긴다", async () => {
    const lastProducedAt = new Date("2026-10-18T00:00:00Z");
    routeFindMany([row({ kind: "B", errorKind: null })], []);
    statusFindMany.mockResolvedValue([
      { jobKey: "naver-settlement-sync", status: "SUCCESS", lastRunAt: lastProducedAt, lastProducedAt },
    ]);
    const body = await (await GET(get("immediate"))).json();
    expect(body.messages).toEqual([]);
    expect(incidentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inc1", status: "waiting_owner", prNumber: null },
        data: expect.objectContaining({
          normalizedEvidence: { runAt: lastProducedAt.toISOString(), suppressed: true },
        }),
      }),
    );
    expect(recordIncidentOccurrence).toHaveBeenCalledWith(expect.objectContaining({ kind: "C" }));
    expect(resolveOpenIncidents).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["C"] }));
  });

  it.each(["A", "B"])("immediate: PR 이 붙은 %s 사고는 정상 실행이 있어도 막지 않는다", async (kind) => {
    const later = new Date("2026-10-18T00:00:00Z");
    routeFindMany([row({ kind, errorKind: kind === "B" ? null : "network", prNumber: 7 })], []);
    statusFindMany.mockResolvedValue([
      { jobKey: "naver-settlement-sync", status: "SUCCESS", lastRunAt: later, lastProducedAt: later },
    ]);
    const body = await (await GET(get("immediate"))).json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].detail).toContain("PR #7");
    expect(incidentUpdate).not.toHaveBeenCalled();
    expect(recordIncidentOccurrence).not.toHaveBeenCalled();
  });

  it("immediate: 알렸던 사고가 정상화되면 정상화 메시지, KNOWN_JOBS 에 없는 작업은 「알 수 없음」", async () => {
    routeFindMany(
      [],
      [
        row({
          id: "inc9",
          jobKey: "unlisted-job",
          status: "resolved",
          alertedAt: new Date("2026-10-17T22:30:00Z"),
          normalizedAt: new Date("2026-10-18T00:10:00Z"),
          normalizedEvidence: { runAt: "2026-10-18T00:05:00.000Z" },
        }),
      ],
    );
    const body = await (await GET(get("immediate"))).json();
    expect(body.messages).toEqual([
      {
        key: "incident-inc9-ok",
        icon: "✅",
        title: "알 수 없음 정상화",
        detail: "09:05 실행부터 정상입니다.",
        ackField: "recoveryAlertedAt",
        incidentIds: ["inc9"],
      },
    ]);
    const recoveryQuery = incidentFindMany.mock.calls.find(([a]) => a.where.status === "resolved")![0];
    expect(recoveryQuery.where).toMatchObject({
      alertedAt: { not: null },
      recoveryAlertedAt: null,
      suppressedAt: null,
    });
  });

  it("digest: KST 전날 08:00 ~ 오늘 08:00 창으로 정상화·조치대기·막은 건을 묶는다", async () => {
    routeFindMany(
      [row({ id: "w1", kind: "B", errorKind: null })],
      [row({ id: "r1", status: "resolved", normalizedAt: new Date("2026-10-17T21:15:00Z") })],
    );
    incidentCount.mockResolvedValue(2);
    const body = await (await GET(get("digest"))).json();
    expect(escalatePendingIncidents).not.toHaveBeenCalled();
    expect(body.messages).toEqual([
      {
        key: "digest-incident",
        icon: "📋",
        title: "지난 24시간 자동화 작업",
        detail: [
          "정상화 1건",
          "10-18 03:00 네이버 정산 동기화 · 네트워크 끊김 · 정상화 06:15",
          "조치대기 1건",
          "네이버 정산 동기화 · 결과 0건",
          "알림 직전에 정상화돼 보내지 않은 건 2건",
        ].join("\n"),
        ackField: "digestedAt",
        incidentIds: ["r1"],
      },
    ]);
    const start = new Date("2026-10-16T23:00:00Z");
    const end = new Date("2026-10-17T23:00:00Z");
    const resolvedQuery = incidentFindMany.mock.calls.find(([a]) => a.where.status === "resolved")![0];
    // 정상화 목록의 하한은 7일 전이다 — 08:00 회차를 놓친 날의 정상화가 다음 날 요약에 실린다(digestedAt null 로 한 번만).
    // 「막은 건」 개수는 24시간 창 그대로다(개수라 따로 확인 칸이 없다).
    expect(resolvedQuery.where).toMatchObject({
      normalizedAt: { gte: new Date("2026-10-10T23:00:00Z"), lt: end },
      digestedAt: null,
      suppressedAt: null,
      kind: { not: "C" },
    });
    expect(incidentCount).toHaveBeenCalledWith({ where: { suppressedAt: { gte: start, lt: end } } });
  });

  it("digest: 08:00 회차를 놓친 전전날 정상화도 날짜와 함께 싣는다", async () => {
    routeFindMany([], [row({ id: "r0", status: "resolved", firstSeenAt: new Date("2026-10-15T18:00:00Z"), normalizedAt: new Date("2026-10-15T21:15:00Z") })]);
    const body = await (await GET(get("digest"))).json();
    expect(body.messages[0].detail).toBe("정상화 1건\n10-16 03:00 네이버 정산 동기화 · 네트워크 끊김 · 정상화 06:15");
    expect(body.messages[0].incidentIds).toEqual(["r0"]);
  });

  it("목록에 없는 작업은 영문 키 대신 화면과 같은 「알 수 없음」으로 부른다", async () => {
    routeFindMany([row({ jobKey: "retired-job-key" })], []);
    const body = await (await GET(get("immediate"))).json();
    expect(body.messages[0].title).toBe("알 수 없음 조치대기");
    expect(JSON.stringify(body.messages)).not.toContain("retired-job-key");
  });

  it("digest: 보낼 것이 없으면 빈 목록", async () => {
    incidentCount.mockResolvedValue(4);
    const body = await (await GET(get("digest"))).json();
    expect(body).toEqual({ ok: true, messages: [] });
  });

  it("DB 오류는 500 과 console.error(조용히 빈 목록으로 숨기지 않는다)", async () => {
    incidentFindMany.mockRejectedValue(new Error("db down"));
    const res = await GET(get("digest"));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
  });

  it("POST: 지정한 사고의 지정한 칸만 지금 시각으로 바꾼다", async () => {
    const res = await POST(
      post({
        acks: [
          { incidentIds: ["a", "b"], ackField: "alertedAt" },
          { incidentIds: ["c"], ackField: "digestedAt" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(incidentUpdateMany).toHaveBeenCalledTimes(2);
    expect(incidentUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ["a", "b"] }, alertedAt: null },
      data: { alertedAt: NOW },
    });
    expect(incidentUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ["c"] }, digestedAt: null },
      data: { digestedAt: NOW },
    });
    expect(await res.json()).toEqual({ ok: true, updated: 2 });
  });

  it.each([
    ["모르는 칸", { acks: [{ incidentIds: ["a"], ackField: "status" }] }],
    ["acks 가 배열이 아님", { acks: "x" }],
    ["incidentIds 가 배열이 아님", { acks: [{ incidentIds: "a", ackField: "alertedAt" }] }],
    ["incidentIds 에 문자열이 아닌 값", { acks: [{ incidentIds: [1], ackField: "alertedAt" }] }],
    ["JSON 이 아님", "not json"],
  ])("POST: %s 이면 400 이고 아무것도 바꾸지 않는다", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(incidentUpdateMany).not.toHaveBeenCalled();
  });
});
