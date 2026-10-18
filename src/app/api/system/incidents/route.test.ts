import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { AUTOMATION_INCIDENT_FIELDS } from "@/lib/automation-incidents";

const requireAuthMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ cronIncident: { findMany: (...args: unknown[]) => findManyMock(...args) } }),
}));

import { GET } from "./route";

const NOW = new Date("2026-10-18T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function req(query: string): Request {
  return new Request(`https://crm.example.com/api/system/incidents${query}`);
}

/** 장부 한 줄 — 화면에 내리면 안 되는 칸(원문 메시지·서명·알림 표시)까지 일부러 채워 둔다. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "i-1",
    jobKey: "naver-order-sync",
    kind: "A",
    errorKind: "proxy_quota",
    status: "waiting_owner",
    ownerAction: "프록시 한도를 확인해 주세요.",
    firstSeenAt: new Date("2026-10-17T00:00:00.000Z"),
    normalizedAt: null,
    occurrences: 2,
    lastMessage: "fetch failed: 407 proxy auth token=secret-placeholder",
    signature: "naver-order-sync|A|proxy_quota|fetch failed",
    suppressedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requireAuthMock.mockReset().mockResolvedValue({ authenticated: true, context: {} });
  findManyMock.mockReset().mockResolvedValue([row()]);
});

describe("GET /api/system/incidents", () => {
  it("세션이 없으면 401 이고 장부를 읽지 않는다", async () => {
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await GET(req("?status=waiting_owner"));
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("조건 없이 부르면 400 — 장부 전체를 내리지 않는다", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?status=everything"))).status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("응답 칸은 정해진 9개뿐이다 — 원문 메시지(lastMessage)·서명은 내려보내지 않는다", async () => {
    findManyMock.mockImplementation(async (args: { select?: Record<string, true> }) => {
      // 라우트가 select 를 빠뜨려도 이 테스트가 잡도록, select 에 없는 칸은 지우지 않고 그대로 돌려준다.
      const full = row();
      if (!args.select) return [full];
      return [Object.fromEntries(Object.keys(args.select).map((k) => [k, full[k as keyof typeof full]]))];
    });
    const res = await GET(req("?status=waiting_owner"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["incidents"]);
    expect(Object.keys(body.incidents[0]).sort()).toEqual([...AUTOMATION_INCIDENT_FIELDS].sort());
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("조치대기 조회는 그 상태만, C(알림 틀림)와 알림 직전에 막힌 사고는 거른다", async () => {
    await GET(req("?status=waiting_owner"));
    const where = findManyMock.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "waiting_owner", kind: { not: "C" }, suppressedAt: null });
  });

  it("작업별 조회는 열린 사고 전부 + 14일 안에 정상화된 사고만", async () => {
    await GET(req("?jobKey=naver-order-sync"));
    const where = findManyMock.mock.calls[0][0].where;
    expect(where).toMatchObject({ jobKey: "naver-order-sync", kind: { not: "C" }, suppressedAt: null });
    expect(where.OR).toEqual([
      { status: { in: ["open", "waiting_owner"] } },
      { status: "resolved", normalizedAt: { gte: new Date(NOW.getTime() - 14 * DAY) } },
    ]);
  });

  it("장부 조회가 실패하면 500 을 돌려주고 로그를 남긴다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findManyMock.mockRejectedValue(new Error("db down"));
    const res = await GET(req("?status=waiting_owner"));
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
