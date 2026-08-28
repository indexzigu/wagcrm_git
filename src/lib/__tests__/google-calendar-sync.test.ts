import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 헬퍼는 prisma를 쓰지 않지만 모듈 최상단 import가 실행되므로 stub 처리
vi.mock("../prisma", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("../google-calendar", () => ({
  getGoogleCalendarAccessToken: vi.fn(),
  getGoogleCalendarConnectionStatus: vi.fn(),
  getFinanceCalendarId: vi.fn(),
  GOOGLE_CALENDAR_PROVIDER: "google-calendar",
}));

import {
  getFinanceCalendarId,
  getGoogleCalendarAccessToken,
  getGoogleCalendarConnectionStatus,
} from "../google-calendar";
import { getPrisma } from "../prisma";
import {
  deleteCalendarEventsByIds,
  deleteCampaignCalendarEvents,
  scanOrphanCalendarEvents,
  syncAllCampaignsToCalendar,
  syncCampaignToCalendar,
  syncGroupToCalendar,
} from "../google-calendar-sync";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
    connected: true,
  } as never);
  vi.mocked(getGoogleCalendarAccessToken).mockResolvedValue("token-1");
  vi.mocked(getFinanceCalendarId).mockResolvedValue(null);
  fetchMock.mockResolvedValue({ ok: true, status: 204 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncGroupToCalendar (CG-3 그룹 이벤트 장부)", () => {
  function makeFakePrisma(group: unknown) {
    return {
      campaignGroup: {
        findUnique: vi.fn().mockResolvedValue(group),
        update: vi.fn().mockResolvedValue({}),
      },
      salesCampaign: {
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
    };
  }

  function stubCalendarApi() {
    let createdCount = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        createdCount += 1;
        return { ok: true, json: async () => ({ id: `ev-new-${createdCount}` }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    });
  }

  const baseGroup = {
    id: "g1",
    name: "가온 앰플 외 1건",
    expectedDepositDate: new Date("2026-08-10T00:00:00.000Z"),
    expectedPayoutDate: new Date("2026-08-15T00:00:00.000Z"),
    expectedSupplierPayoutDate: null,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    calendarEventIds: null,
    seller: { name: "김본명", alias: "가온" },
    members: [
      {
        id: "c1",
        status: "PREPARATION",
        salesChannel: "SELLER_MALL",
        startDate: new Date("2026-08-01T00:00:00.000Z"),
        endDate: new Date("2026-08-03T00:00:00.000Z"),
        calendarEventIds: JSON.stringify({ campaign: "m1-old", deposit: "m1-dep" }),
        deal: { dealName: "앰플" },
      },
      {
        id: "c2",
        status: "PREPARATION",
        salesChannel: "SELLER_MALL",
        startDate: new Date("2026-08-02T00:00:00.000Z"),
        endDate: new Date("2026-08-05T00:00:00.000Z"),
        calendarEventIds: null,
        deal: { dealName: "선크림" },
      },
    ],
  };

  it("멤버 개별 이벤트를 정리하고 그룹당 3개 이벤트를 만들어 그룹 장부에 저장한다", async () => {
    const fakePrisma = makeFakePrisma(baseGroup);
    vi.mocked(getPrisma).mockReturnValue(fakePrisma as never);
    stubCalendarApi();

    const result = await syncGroupToCalendar("g1");
    expect(result).toEqual({ ok: true });

    // 멤버 c1의 기존 이벤트 2개 삭제 + 멤버 장부 비움
    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls.map(([url]) => url as string)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/events/m1-old"),
        expect.stringContaining("/events/m1-dep"),
      ]),
    );
    expect(fakePrisma.salesCampaign.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { calendarEventIds: null },
    });

    // 그룹당 3개 이벤트 생성(기간 롤업 + 입금 + 출금)
    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(3);
    const bodies = postCalls.map(([, init]) =>
      JSON.parse((init as RequestInit).body as string),
    );
    const periodEvent = bodies.find((b) => b.summary === "가온 앰플 외 1건");
    expect(periodEvent.start.date).toBe("2026-08-01"); // min(startDate)
    expect(periodEvent.end.date).toBe("2026-08-06"); // max(endDate)+1 (exclusive)
    expect(bodies.map((b) => b.summary)).toEqual(
      // 상대 병기 + 「출금」→「지급」 통일(오너 확정 2026-08-25). 셀러몰이라
      // 입금 상대는 셀러, 지급 상대는 공급사다.
      expect.arrayContaining(["입금(셀러) 가온 앰플 외 1건", "지급(공급사) 가온 앰플 외 1건"]),
    );

    // 그룹 장부 저장
    const ledgerUpdate = fakePrisma.campaignGroup.update.mock.calls.at(-1)![0];
    const savedLedger = JSON.parse(ledgerUpdate.data.calendarEventIds);
    expect(Object.keys(savedLedger).sort()).toEqual(["campaign", "deposit", "payout"]);
  });

  it("활성 멤버가 없으면(전원 DROPPED) 그룹 이벤트를 지우고 장부를 비운다", async () => {
    const dropped = {
      ...baseGroup,
      calendarEventIds: JSON.stringify({ campaign: "g-ev", deposit: "g-dep" }),
      members: baseGroup.members.map((m) => ({
        ...m,
        status: "DROPPED",
        calendarEventIds: null,
      })),
    };
    const fakePrisma = makeFakePrisma(dropped);
    vi.mocked(getPrisma).mockReturnValue(fakePrisma as never);
    stubCalendarApi();

    const result = await syncGroupToCalendar("g1");
    expect(result).toEqual({ ok: true, skipped: "dropped" });

    const deleteUrls = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
      .map(([url]) => url as string);
    expect(deleteUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/events/g-ev"),
        expect.stringContaining("/events/g-dep"),
      ]),
    );
    expect(fakePrisma.campaignGroup.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { calendarEventIds: null },
    });
  });

  // 영업 존(PROPOSAL) 제외 — 오너 확정 2026-07-31. 캘린더는 "실제로 도는 캠페인"을 본다.
  it("PROPOSAL 멤버는 그룹 기간 롤업에서 제외한다(제안이 그룹 이벤트를 늘리지 않는다)", async () => {
    const withProposal = {
      ...baseGroup,
      members: [
        baseGroup.members[0], // PREPARATION 08-01~08-03
        {
          ...baseGroup.members[1],
          status: "PROPOSAL",
          // 제안 멤버가 훨씬 뒤까지 걸쳐 있어도 롤업을 늘려서는 안 된다
          startDate: new Date("2026-08-20T00:00:00.000Z"),
          endDate: new Date("2026-08-25T00:00:00.000Z"),
        },
      ],
    };
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma(withProposal) as never);
    stubCalendarApi();

    expect(await syncGroupToCalendar("g1")).toEqual({ ok: true });

    const periodEvent = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string))
      .find((b) => typeof b.summary === "string" && !b.summary.startsWith("입금") && !b.summary.startsWith("출금"));
    // 제안 멤버를 셌다면 end 가 2026-08-26 이 된다
    expect(periodEvent.start.date).toBe("2026-08-01");
    expect(periodEvent.end.date).toBe("2026-08-04"); // PREPARATION 멤버의 08-03 + 1
  });

  it("올릴 멤버가 없으면(전원 PROPOSAL) 그룹 이벤트를 지우고 장부를 비운다", async () => {
    const allProposal = {
      ...baseGroup,
      calendarEventIds: JSON.stringify({ campaign: "g-ev" }),
      members: baseGroup.members.map((m) => ({ ...m, status: "PROPOSAL", calendarEventIds: null })),
    };
    const fakePrisma = makeFakePrisma(allProposal);
    vi.mocked(getPrisma).mockReturnValue(fakePrisma as never);
    stubCalendarApi();

    expect(await syncGroupToCalendar("g1")).toEqual({ ok: true, skipped: "dropped" });
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
        .map(([url]) => url as string),
    ).toEqual(expect.arrayContaining([expect.stringContaining("/events/g-ev")]));
    expect(fakePrisma.campaignGroup.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { calendarEventIds: null },
    });
  });

  it("syncCampaignToCalendar는 그룹 캠페인을 그룹 동기화로 위임한다", async () => {
    const fakePrisma = makeFakePrisma(baseGroup);
    fakePrisma.salesCampaign.findUnique.mockResolvedValue({
      id: "c1",
      groupId: "g1",
      status: "PREPARATION",
    });
    vi.mocked(getPrisma).mockReturnValue(fakePrisma as never);
    stubCalendarApi();

    const result = await syncCampaignToCalendar("c1");
    expect(result).toEqual({ ok: true });
    expect(fakePrisma.campaignGroup.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "g1" } }),
    );
  });
});

describe("deleteCampaignCalendarEvents", () => {
  it("저장된 이벤트가 없으면(null) 아무 호출 없이 ok", async () => {
    const result = await deleteCampaignCalendarEvents(null);
    expect(result).toEqual({ ok: true });
    expect(getGoogleCalendarConnectionStatus).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("손상된 JSON이면 아무 호출 없이 ok", async () => {
    const result = await deleteCampaignCalendarEvents("{not json");
    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("저장된 모든 이벤트에 DELETE를 호출한다", async () => {
    const result = await deleteCampaignCalendarEvents(
      JSON.stringify({ campaign: "ev-1", deposit: "ev-2", payout: "ev-3" }),
    );
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/events/ev-1"),
        expect.stringContaining("/events/ev-2"),
        expect.stringContaining("/events/ev-3"),
      ]),
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).method).toBe("DELETE");
      expect(
        (init as { headers: Record<string, string> }).headers.Authorization,
      ).toBe("Bearer token-1");
    }
  });

  it("캘린더 미연결이면 fetch 없이 skipped", async () => {
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      connected: false,
    } as never);
    const result = await deleteCampaignCalendarEvents(
      JSON.stringify({ campaign: "ev-1" }),
    );
    expect(result).toEqual({ ok: false, skipped: "not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("토큰 취득 실패 시 예외 없이 error 결과", async () => {
    vi.mocked(getGoogleCalendarAccessToken).mockRejectedValue(
      new Error("token expired"),
    );
    const result = await deleteCampaignCalendarEvents(
      JSON.stringify({ campaign: "ev-1" }),
    );
    expect(result).toEqual({ ok: false, error: "token expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("개별 이벤트 삭제 실패(네트워크 예외)도 삼키고 ok (멱등·best-effort)", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await deleteCampaignCalendarEvents(
      JSON.stringify({ campaign: "ev-1", deposit: "ev-2" }),
    );
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("syncAllCampaignsToCalendar (전체 동기화 — 완료 그룹 누락 회귀)", () => {
  function makeFakePrisma(opts: { ungrouped?: unknown[]; groups?: unknown[] }) {
    return {
      salesCampaign: {
        findMany: vi.fn().mockResolvedValue(opts.ungrouped ?? []),
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      campaignGroup: {
        findMany: vi.fn().mockResolvedValue(opts.groups ?? []),
        update: vi.fn().mockResolvedValue({}),
      },
      storageIntegration: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
  }

  // 영업 존 제외의 **정리 경로**를 지키는 계약(오너 확정 2026-07-31).
  it("PROPOSAL 무그룹 캠페인은 조회 대상에 남기고(정리 가능해야 함) 기존 이벤트를 지운다", async () => {
    const proposal = {
      id: "p1",
      status: "PROPOSAL",
      campaignName: "제안 캠페인",
      startDate: new Date("2026-09-01T00:00:00.000Z"),
      endDate: new Date("2026-09-03T00:00:00.000Z"),
      salesChannel: "SELLER_MALL",
      expectedDepositDate: null,
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      calendarEventIds: JSON.stringify({ campaign: "prop-ev" }),
      deal: { dealName: "제안딜" },
      seller: { name: "김본명", alias: "가온" },
    };
    const prisma = makeFakePrisma({ ungrouped: [proposal], groups: [] });
    vi.mocked(getPrisma).mockReturnValue(prisma as never);

    await syncAllCampaignsToCalendar();

    // ① 쿼리가 PROPOSAL 을 배제하지 않아야 정리가 가능하다 — 배제하면 이벤트가 영구 잔존
    const where = prisma.salesCampaign.findMany.mock.calls[0][0].where;
    expect(where.status.notIn).not.toContain("PROPOSAL");
    // ② 실제로 기존 이벤트를 지우고 장부를 비운다
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
        .map(([url]) => url as string),
    ).toEqual(expect.arrayContaining([expect.stringContaining("/events/prop-ev")]));
    expect(prisma.salesCampaign.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { calendarEventIds: null },
    });
    // ③ 새 이벤트를 만들지 않는다
    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toHaveLength(0);
  });

  it("전원 COMPLETED 그룹도 CampaignGroup 대장에서 직접 수집해 동기화하고 멤버 잔여 개별 이벤트를 정리한다", async () => {
    const completedGroup = {
      id: "g-done",
      name: "가온 앰플 외 1건",
      expectedDepositDate: null,
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      calendarEventIds: null,
      seller: { name: "김본명", alias: "가온" },
      members: [
        {
          id: "c1",
          status: "COMPLETED",
          salesChannel: "SELLER_MALL",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-06-03T00:00:00.000Z"),
          // 그룹 합류 전 개별 동기화로 남은 잔여 이벤트(reconcile 대상)
          calendarEventIds: JSON.stringify({ campaign: "old-c1" }),
          deal: { dealName: "앰플" },
        },
        {
          id: "c2",
          status: "COMPLETED",
          salesChannel: "SELLER_MALL",
          startDate: new Date("2026-06-02T00:00:00.000Z"),
          endDate: new Date("2026-06-05T00:00:00.000Z"),
          calendarEventIds: JSON.stringify({ campaign: "old-c2" }),
          deal: { dealName: "선크림" },
        },
      ],
    };

    const prisma = makeFakePrisma({ ungrouped: [], groups: [completedGroup] });
    vi.mocked(getPrisma).mockReturnValue(prisma as never);

    let created = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        created += 1;
        return { ok: true, json: async () => ({ id: `ev-${created}` }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    });

    const result = await syncAllCampaignsToCalendar();

    // 그룹이 대장에서 직접 수집돼 동기화됨(과거엔 COMPLETED 제외로 누락)
    expect(prisma.campaignGroup.findMany).toHaveBeenCalled();
    expect(result).toEqual({ synced: 1, total: 1, failed: 0 });

    // 멤버 잔여 개별 이벤트가 DELETE되고 멤버 장부가 비워짐
    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBe(2); // old-c1, old-c2
    expect(prisma.salesCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1" },
        data: { calendarEventIds: null },
      }),
    );

    // 소비될 그룹 기간 이벤트가 새로 생성됨
    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// 고아 정리(reconcile) — 2026-07-31. 캘린더가 primary(개인 기본)라 안전장치가 핵심이다.
describe("scanOrphanCalendarEvents / deleteCalendarEventsByIds (고아 정리)", () => {
  function makeFakePrisma(opts: { campaignLedgers?: string[]; groupLedgers?: string[] }) {
    return {
      salesCampaign: {
        findMany: vi
          .fn()
          .mockResolvedValue((opts.campaignLedgers ?? []).map((l) => ({ calendarEventIds: l }))),
      },
      campaignGroup: {
        findMany: vi
          .fn()
          .mockResolvedValue((opts.groupLedgers ?? []).map((l) => ({ calendarEventIds: l }))),
      },
    };
  }

  const RANGE = { timeMin: "2025-01-01T00:00:00.000Z", timeMax: "2027-01-01T00:00:00.000Z" };

  function stubList(items: unknown[], pages?: unknown[][]) {
    const queue = pages ?? [items];
    let call = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
      const page = queue[call] ?? [];
      const hasNext = call < queue.length - 1;
      call++;
      void url;
      return { ok: true, json: async () => ({ items: page, ...(hasNext ? { nextPageToken: `p${call}` } : {}) }) };
    });
  }

  it("장부에 없는 종일 이벤트만 고아로 고른다(참조 중인 것은 제외)", async () => {
    vi.mocked(getPrisma).mockReturnValue(
      makeFakePrisma({ campaignLedgers: [JSON.stringify({ campaign: "keep-1" })] }) as never,
    );
    stubList([
      { id: "keep-1", summary: "동기화 중", start: { date: "2026-01-05" }, end: { date: "2026-01-07" } },
      { id: "orphan-1", summary: "무선고데기", start: { date: "2025-06-09" }, end: { date: "2025-06-12" } },
    ]);

    const res = await scanOrphanCalendarEvents(RANGE);
    expect(res.ok).toBe(true);
    expect(res.scanned).toBe(2);
    expect(res.referenced).toBe(1);
    expect(res.orphans.map((o) => o.id)).toEqual(["orphan-1"]);
  });

  it("시간대 있는 일정·반복 일정·취소된 일정은 후보에서 제외한다(개인 일정 보호)", async () => {
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma({}) as never);
    stubList([
      { id: "meeting", summary: "회의", start: { dateTime: "2026-01-05T10:00:00+09:00" }, end: { dateTime: "2026-01-05T11:00:00+09:00" } },
      { id: "birthday", summary: "아빠 환갑", start: { date: "2026-01-06" }, end: { date: "2026-01-07" }, recurrence: ["RRULE:FREQ=YEARLY"] },
      { id: "instance", summary: "반복 인스턴스", start: { date: "2026-01-08" }, end: { date: "2026-01-09" }, recurringEventId: "birthday" },
      { id: "gone", summary: "취소됨", status: "cancelled", start: { date: "2026-01-10" }, end: { date: "2026-01-11" } },
      { id: "real-orphan", summary: "설거지바", start: { date: "2026-01-11" }, end: { date: "2026-01-12" } },
    ]);

    const res = await scanOrphanCalendarEvents(RANGE);
    expect(res.scanned).toBe(1); // 종일·비반복은 real-orphan 하나뿐
    expect(res.orphans.map((o) => o.id)).toEqual(["real-orphan"]);
  });

  it("페이지네이션을 끝까지 따라간다", async () => {
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma({}) as never);
    stubList([], [
      [{ id: "a", summary: "A", start: { date: "2026-01-01" }, end: { date: "2026-01-02" } }],
      [{ id: "b", summary: "B", start: { date: "2026-02-01" }, end: { date: "2026-02-02" } }],
    ]);

    const res = await scanOrphanCalendarEvents(RANGE);
    expect(res.orphans.map((o) => o.id).sort()).toEqual(["a", "b"]);
  });

  it("삭제는 넘겨받은 id 만 지우고, 장부가 참조 중인 id 는 방어적으로 건너뛴다", async () => {
    vi.mocked(getPrisma).mockReturnValue(
      makeFakePrisma({ groupLedgers: [JSON.stringify({ campaign: "live-1" })] }) as never,
    );
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });

    const res = await deleteCalendarEventsByIds(["orphan-1", "live-1", "orphan-2"]);
    expect(res).toEqual({ ok: true, deleted: 2, protected: 1 });
    const deleted = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
      .map(([url]) => url as string);
    expect(deleted).toHaveLength(2);
    expect(deleted.some((u) => u.includes("live-1"))).toBe(false);
  });

  it("빈 배열이면 아무 호출도 하지 않는다", async () => {
    expect(await deleteCalendarEventsByIds([])).toEqual({ ok: true, deleted: 0, protected: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 회계·정산 캘린더 분리 — 2026-08-25 오너 확정. 캠페인 기간=primary(기존),
// 입금·출금=회계 캘린더(설정 시). 장부는 이벤트별 소속 캘린더를 함께 기록한다.
describe("회계·정산 캘린더 분리", () => {
  const FINANCE = "example@group.calendar.google.com";
  const FINANCE_PATH = encodeURIComponent(FINANCE);

  const baseCampaign = {
    id: "c1",
    status: "PREPARATION",
    groupId: null,
    campaignName: "가온 앰플",
    startDate: new Date("2026-08-01T00:00:00.000Z"),
    endDate: new Date("2026-08-03T00:00:00.000Z"),
    salesChannel: "SELLER_MALL",
    expectedDepositDate: new Date("2026-08-10T00:00:00.000Z"),
    expectedPayoutDate: new Date("2026-08-15T00:00:00.000Z"),
    expectedSupplierPayoutDate: null,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    calendarEventIds: null as string | null,
    deal: { dealName: "앰플" },
    seller: { name: "김본명", alias: "가온" },
  };

  function makeFakePrisma(campaign: unknown) {
    return {
      salesCampaign: {
        findUnique: vi.fn().mockResolvedValue(campaign),
        update: vi.fn().mockResolvedValue({}),
      },
      campaignGroup: {
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
    };
  }

  function stubCreate() {
    let created = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        created += 1;
        return { ok: true, json: async () => ({ id: `ev-${created}` }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    });
  }

  function callsByMethod(method: string) {
    return fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === method,
    );
  }

  it("입금·출금은 회계 캘린더로, 캠페인 기간은 primary 로 생성하고 장부에 캘린더를 기록한다", async () => {
    vi.mocked(getFinanceCalendarId).mockResolvedValue(FINANCE);
    const prisma = makeFakePrisma(baseCampaign);
    vi.mocked(getPrisma).mockReturnValue(prisma as never);
    stubCreate();

    expect(await syncCampaignToCalendar("c1")).toEqual({ ok: true });

    const posts = callsByMethod("POST").map(([url, init]) => ({
      url: url as string,
      body: JSON.parse((init as RequestInit).body as string),
    }));
    const period = posts.find((p) => p.body.summary === "가온 앰플");
    const deposit = posts.find((p) => p.body.summary === "입금(셀러) 가온 앰플");
    const payout = posts.find((p) => p.body.summary === "지급(공급사) 가온 앰플");
    expect(period!.url).toContain("/calendars/primary/events");
    expect(deposit!.url).toContain(`/calendars/${FINANCE_PATH}/events`);
    expect(payout!.url).toContain(`/calendars/${FINANCE_PATH}/events`);

    const ledger = JSON.parse(
      prisma.salesCampaign.update.mock.calls.at(-1)![0].data.calendarEventIds,
    );
    // primary 는 하위호환 문자열, 회계 캘린더는 {id, cal}
    expect(typeof ledger.campaign).toBe("string");
    expect(ledger.deposit).toEqual({ id: expect.any(String), cal: FINANCE });
    expect(ledger.payout).toEqual({ id: expect.any(String), cal: FINANCE });
  });

  it("미설정(null)이면 종전대로 전부 primary 로 가고 장부는 문자열만 남는다", async () => {
    vi.mocked(getFinanceCalendarId).mockResolvedValue(null);
    const prisma = makeFakePrisma(baseCampaign);
    vi.mocked(getPrisma).mockReturnValue(prisma as never);
    stubCreate();

    expect(await syncCampaignToCalendar("c1")).toEqual({ ok: true });

    for (const [url] of callsByMethod("POST")) {
      expect(url as string).toContain("/calendars/primary/events");
    }
    const ledger = JSON.parse(
      prisma.salesCampaign.update.mock.calls.at(-1)![0].data.calendarEventIds,
    );
    expect(Object.values(ledger).every((v) => typeof v === "string")).toBe(true);
  });

  it("기존 primary 의 입금·출금 이벤트는 '회계 캘린더에 생성 → primary 에서 삭제' 순으로 이사한다", async () => {
    vi.mocked(getFinanceCalendarId).mockResolvedValue(FINANCE);
    const prisma = makeFakePrisma({
      ...baseCampaign,
      // 구 형식(문자열) 장부 — 전부 primary 에 사는 이벤트다
      calendarEventIds: JSON.stringify({
        campaign: "old-camp",
        deposit: "old-dep",
        payout: "old-pay",
      }),
    });
    vi.mocked(getPrisma).mockReturnValue(prisma as never);
    stubCreate();

    expect(await syncCampaignToCalendar("c1")).toEqual({ ok: true });

    // 캠페인 기간 이벤트는 primary 그대로 PATCH(이사 아님)
    const patches = callsByMethod("PATCH").map(([url]) => url as string);
    expect(patches).toEqual([
      expect.stringContaining("/calendars/primary/events/old-camp"),
    ]);

    // 입금·출금은 회계 캘린더에 새로 생성되고, 옛 primary 이벤트가 삭제된다
    const posts = callsByMethod("POST").map(([url]) => url as string);
    expect(posts).toHaveLength(2);
    for (const url of posts) expect(url).toContain(`/calendars/${FINANCE_PATH}/events`);
    const deletes = callsByMethod("DELETE").map(([url]) => url as string);
    expect(deletes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/calendars/primary/events/old-dep"),
        expect.stringContaining("/calendars/primary/events/old-pay"),
      ]),
    );

    const ledger = JSON.parse(
      prisma.salesCampaign.update.mock.calls.at(-1)![0].data.calendarEventIds,
    );
    expect(ledger.campaign).toBe("old-camp");
    expect(ledger.deposit).toEqual({ id: expect.any(String), cal: FINANCE });
    expect(ledger.payout).toEqual({ id: expect.any(String), cal: FINANCE });
  });

  it("이사 중 생성이 실패하면 옛 이벤트를 지우지 않고 기존 장부를 유지한다(구멍 방지)", async () => {
    vi.mocked(getFinanceCalendarId).mockResolvedValue(FINANCE);
    const prisma = makeFakePrisma({
      ...baseCampaign,
      expectedPayoutDate: null,
      calendarEventIds: JSON.stringify({ deposit: "old-dep" }),
    });
    vi.mocked(getPrisma).mockReturnValue(prisma as never);
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 204, json: async () => ({}) };
    });

    expect(await syncCampaignToCalendar("c1")).toEqual({ ok: true });

    // 옛 입금 이벤트는 삭제되지 않는다
    expect(
      callsByMethod("DELETE").map(([url]) => url as string),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining("old-dep")]));
    const ledger = JSON.parse(
      prisma.salesCampaign.update.mock.calls.at(-1)![0].data.calendarEventIds,
    );
    expect(ledger.deposit).toBe("old-dep"); // primary 유지 → 다음 동기화가 재시도
  });

  it("새 형식 장부({id, cal})의 삭제는 기록된 캘린더에서 지운다", async () => {
    const result = await deleteCampaignCalendarEvents(
      JSON.stringify({
        campaign: "ev-1",
        deposit: { id: "ev-2", cal: FINANCE },
      }),
    );
    expect(result).toEqual({ ok: true });
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/calendars/primary/events/ev-1"),
        expect.stringContaining(`/calendars/${FINANCE_PATH}/events/ev-2`),
      ]),
    );
  });

  it("scanOrphanCalendarEvents 는 회계 캘린더가 설정되면 두 캘린더를 모두 훑고 발견 캘린더를 기록한다", async () => {
    vi.mocked(getFinanceCalendarId).mockResolvedValue(FINANCE);
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: { findMany: vi.fn().mockResolvedValue([]) },
      campaignGroup: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);

    fetchMock.mockImplementation(async (url: string) => {
      const items = (url as string).includes(FINANCE_PATH)
        ? [{ id: "fin-orphan", summary: "입금 잔재", start: { date: "2026-02-01" }, end: { date: "2026-02-02" } }]
        : [{ id: "pri-orphan", summary: "기간 잔재", start: { date: "2026-01-01" }, end: { date: "2026-01-02" } }];
      return { ok: true, json: async () => ({ items }) };
    });

    const res = await scanOrphanCalendarEvents({
      timeMin: "2025-01-01T00:00:00.000Z",
      timeMax: "2027-01-01T00:00:00.000Z",
    });
    expect(res.ok).toBe(true);
    expect(res.scanned).toBe(2);
    expect(res.orphans).toEqual([
      expect.objectContaining({ id: "pri-orphan", calendarId: "primary" }),
      expect.objectContaining({ id: "fin-orphan", calendarId: FINANCE }),
    ]);
  });

  it("deleteCalendarEventsByIds 는 항목별 지정 캘린더에서 지운다(문자열 항목은 primary)", async () => {
    vi.mocked(getPrisma).mockReturnValue({
      salesCampaign: { findMany: vi.fn().mockResolvedValue([]) },
      campaignGroup: { findMany: vi.fn().mockResolvedValue([]) },
    } as never);
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });

    const res = await deleteCalendarEventsByIds([
      "legacy-1",
      { id: "fin-1", calendarId: FINANCE },
    ]);
    expect(res).toEqual({ ok: true, deleted: 2, protected: 0 });
    const urls = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
      .map(([url]) => url as string);
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/calendars/primary/events/legacy-1"),
        expect.stringContaining(`/calendars/${FINANCE_PATH}/events/fin-1`),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// 자사몰 공급사 지급 레그 (3단계, 2026-08-25)
//
// 왜 계약으로 고정하나: 이벤트 종류가 채널에서 파생되도록 바뀌면서 **kind 가 가변**이
// 됐다. 가변 kind + "장부는 매 동기화마다 빈 객체에서 다시 조립" 조합은 슬롯이 사라질
// 때 구글 이벤트를 남긴 채 장부만 지우는 고아를 만든다 — 코드로는 영원히 못 찾는 상태다.
// 실동기화를 QA 로 태울 수 없는 표면이라(오너 실캘린더) 여기서 fetch 계약으로 잡는다.
// ---------------------------------------------------------------------------
describe("자사몰 공급사 지급 레그 — 이벤트 파생은 슬롯 SSOT 를 따른다", () => {
  const OWN_MALL_CAMPAIGN = {
    id: "own-1",
    status: "PREPARATION",
    groupId: null,
    campaignName: "자사몰 캠페인",
    salesChannel: "OWN_MALL_NAVER",
    startDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-03T00:00:00.000Z"),
    expectedDepositDate: null,
    expectedPayoutDate: new Date("2026-09-20T00:00:00.000Z"),
    expectedSupplierPayoutDate: new Date("2026-09-10T00:00:00.000Z"),
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    calendarEventIds: null as string | null,
    deal: { dealName: "자사몰딜" },
    seller: { name: "김본명", alias: "가온" },
  };

  function fakePrisma(campaign: unknown) {
    return {
      salesCampaign: {
        findUnique: vi.fn().mockResolvedValue(campaign),
        update: vi.fn().mockResolvedValue({}),
      },
      campaignGroup: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    };
  }

  function postedBodies() {
    return fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
  }

  function deletedIds() {
    return fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
      .map(([url]) => url as string);
  }

  function stubCreates() {
    let n = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        n += 1;
        return { ok: true, json: async () => ({ id: `ev-${n}` }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    });
  }

  it("자사몰은 지급 이벤트를 두 건 만들고 입금 이벤트를 만들지 않는다", async () => {
    stubCreates();
    const prisma = fakePrisma(OWN_MALL_CAMPAIGN);
    vi.mocked(getPrisma).mockReturnValue(prisma as never);

    await syncCampaignToCalendar("own-1");

    const summaries = postedBodies().map((b) => b.summary);
    // 상대 병기가 없으면 두 지급 이벤트가 글자 하나 다르지 않다 — 식별 수단이다.
    expect(summaries).toEqual(
      expect.arrayContaining(["지급(공급사) 자사몰 캠페인", "지급(셀러) 자사몰 캠페인"]),
    );
    expect(summaries.filter((s: string) => s.startsWith("입금"))).toHaveLength(0);

    // 장부 키는 슬롯 키 그대로 — `deposit`·`payout` 은 구 장부와 같은 문자열이어야 한다.
    const saved = JSON.parse(
      prisma.salesCampaign.update.mock.calls[0][0].data.calendarEventIds as string,
    );
    expect(Object.keys(saved).sort()).toEqual(["campaign", "payout", "supplierPayout"]);
  });

  it("공급사 지급 이벤트는 예정일에 서고 완료일이 있으면 완료일로 옮겨간다", async () => {
    stubCreates();
    vi.mocked(getPrisma).mockReturnValue(
      fakePrisma({
        ...OWN_MALL_CAMPAIGN,
        supplierPayoutCompletedAt: new Date("2026-09-08T00:00:00.000Z"),
        isSupplierPayoutCompleted: true,
      }) as never,
    );

    await syncCampaignToCalendar("own-1");

    const supplier = postedBodies().find(
      (b) => b.summary === "지급(공급사) 자사몰 캠페인",
    );
    expect(supplier.start.date).toBe("2026-09-08");
    expect(supplier.description).toContain("실제 지급 완료 · 공급사");
  });

  /**
   * 완료의 정본은 **플래그**다(앱 캘린더와 같은 SSOT `resolveMoneySlotEffectiveDate`).
   * 완료 취소는 쓰기 경로가 완료일을 함께 지우지만, 스크립트 등으로 날짜만 남은 행이
   * 이벤트를 엉뚱한 날로 끌고 가지 않게 판정 축을 하나로 둔다.
   */
  /**
   * 캠페인 이벤트(기간) 본문도 대금 날짜를 나열한다 — 그 줄이 예정일에 머물면 같은 구글
   * 캘린더 안에서 **대금 이벤트는 15일, 캠페인 본문은 20일**을 말하게 된다.
   */
  it("캠페인 이벤트 본문의 대금 줄도 완료되면 실제일을 말한다", async () => {
    stubCreates();
    vi.mocked(getPrisma).mockReturnValue(
      fakePrisma({
        ...OWN_MALL_CAMPAIGN,
        supplierPayoutCompletedAt: new Date("2026-09-08T00:00:00.000Z"),
        isSupplierPayoutCompleted: true,
      }) as never,
    );

    await syncCampaignToCalendar("own-1");

    const campaignEvent = postedBodies().find((b) => b.summary === "자사몰 캠페인");
    expect(campaignEvent.description).toContain("지급일(공급사): 2026-09-08");
    expect(campaignEvent.description).not.toContain("예상 지급일(공급사): 2026-09-10");
    // 미완료 칸은 종전 문구 그대로다.
    expect(campaignEvent.description).toContain("예상 지급일(셀러): 2026-09-20");
  });

  it("완료 플래그가 꺼져 있으면 완료일이 남아 있어도 예정일에 선다", async () => {
    stubCreates();
    vi.mocked(getPrisma).mockReturnValue(
      fakePrisma({
        ...OWN_MALL_CAMPAIGN,
        supplierPayoutCompletedAt: new Date("2026-09-08T00:00:00.000Z"),
        isSupplierPayoutCompleted: false,
      }) as never,
    );

    await syncCampaignToCalendar("own-1");

    const supplier = postedBodies().find(
      (b) => b.summary === "지급(공급사) 자사몰 캠페인",
    );
    expect(supplier.start.date).toBe("2026-09-10");
    expect(supplier.description).toContain("예상 지급일 · 공급사");
  });

  it("자사몰의 과거 입금 이벤트는 다음 동기화가 지운다(오너 확정 2026-08-25 — 캘린더에는 남기지 않는다)", async () => {
    stubCreates();
    const prisma = fakePrisma({
      ...OWN_MALL_CAMPAIGN,
      // 채널 전환 전에 만들어진 레거시 입금 값 + 그 이벤트 장부
      expectedDepositDate: new Date("2026-09-05T00:00:00.000Z"),
      calendarEventIds: JSON.stringify({ campaign: "ev-old", deposit: "ev-dep-old" }),
    });
    vi.mocked(getPrisma).mockReturnValue(prisma as never);

    await syncCampaignToCalendar("own-1");

    // ⚠️ 이 단언이 이 PR 의 핵심 안전장치다 — 지우지 않으면 장부에서만 사라져
    // 구글에 고아로 남는다(코드로 다시 찾을 수 없다).
    expect(deletedIds()).toEqual(
      expect.arrayContaining([expect.stringContaining("/events/ev-dep-old")]),
    );
    const saved = JSON.parse(
      prisma.salesCampaign.update.mock.calls[0][0].data.calendarEventIds as string,
    );
    expect(saved.deposit).toBeUndefined();
  });

  it("그룹 슬롯은 멤버 채널의 합집합이라 채널이 섞여도 어느 레그도 잃지 않는다", async () => {
    stubCreates();
    const mixedGroup = {
      id: "g-mixed",
      name: "혼재 그룹",
      expectedDepositDate: new Date("2026-09-12T00:00:00.000Z"),
      expectedPayoutDate: new Date("2026-09-20T00:00:00.000Z"),
      expectedSupplierPayoutDate: new Date("2026-09-10T00:00:00.000Z"),
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      calendarEventIds: null,
      seller: { name: "김본명", alias: "가온" },
      members: [
        {
          id: "m1",
          status: "PREPARATION",
          salesChannel: "OWN_MALL_NAVER",
          startDate: new Date("2026-09-01T00:00:00.000Z"),
          endDate: new Date("2026-09-03T00:00:00.000Z"),
          calendarEventIds: null,
          deal: { dealName: "자사몰딜" },
        },
        {
          id: "m2",
          status: "PREPARATION",
          salesChannel: "BRAND_MALL",
          startDate: new Date("2026-09-02T00:00:00.000Z"),
          endDate: new Date("2026-09-04T00:00:00.000Z"),
          calendarEventIds: null,
          deal: { dealName: "브랜드몰딜" },
        },
      ],
    };
    const prisma = {
      campaignGroup: {
        findUnique: vi.fn().mockResolvedValue(mixedGroup),
        update: vi.fn().mockResolvedValue({}),
      },
      salesCampaign: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    };
    vi.mocked(getPrisma).mockReturnValue(prisma as never);

    await syncGroupToCalendar("g-mixed");

    // 자사몰 멤버만 봤다면 입금 레그를, 브랜드몰 멤버만 봤다면 공급사 지급 레그를 잃는다.
    const saved = JSON.parse(
      prisma.campaignGroup.update.mock.calls[0][0].data.calendarEventIds as string,
    );
    expect(Object.keys(saved).sort()).toEqual([
      "campaign",
      "deposit",
      "payout",
      "supplierPayout",
    ]);
  });
});

describe("대금 이벤트 메모의 금액·계좌", () => {
  function makeFakePrisma(campaign: unknown, group?: unknown) {
    return {
      salesCampaign: {
        findUnique: vi.fn().mockResolvedValue(campaign),
        update: vi.fn().mockResolvedValue({}),
      },
      campaignGroup: {
        findUnique: vi.fn().mockResolvedValue(group ?? null),
        update: vi.fn().mockResolvedValue({}),
      },
    };
  }

  function stubCreate() {
    let created = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        created += 1;
        return { ok: true, json: async () => ({ id: `ev-${created}` }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    });
  }

  /** 생성된 이벤트를 제목으로 찾아 본문을 돌려준다. */
  function descriptionOf(summary: string): string {
    const post = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string))
      .find((body) => body.summary === summary);
    if (!post) throw new Error(`«${summary}» 이벤트가 생성되지 않았다`);
    return post.description as string;
  }

  const sellerMallCampaign = {
    id: "c1",
    status: "PREPARATION",
    groupId: null,
    campaignName: "가온 앰플",
    startDate: new Date("2026-08-01T00:00:00.000Z"),
    endDate: new Date("2026-08-03T00:00:00.000Z"),
    salesChannel: "SELLER_MALL",
    expectedDepositDate: new Date("2026-08-10T00:00:00.000Z"),
    expectedPayoutDate: new Date("2026-08-15T00:00:00.000Z"),
    expectedSupplierPayoutDate: null,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    calendarEventIds: null as string | null,
    // 셀러몰 입금 = 매출 − 셀러수수료(의무표 기준) → 3,200,000
    actualSales: 4_000_000,
    sellerExpense: 800_000,
    settlementSales: null,
    actualPayoutAmount: 1_240_000,
    deal: {
      dealName: "앰플",
      partner: { name: "(주)와그물산", bankAccount: "신한 110-222-333444" },
    },
    seller: { name: "김본명", alias: "가온", accountNumber: "국민 123456-78-901234" },
  };

  it("지급(공급사) 메모는 금액을 「미정」으로 적고 공급사 계좌를 싣는다", async () => {
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma(sellerMallCampaign) as never);
    stubCreate();

    expect(await syncCampaignToCalendar("c1")).toEqual({ ok: true });

    const body = descriptionOf("지급(공급사) 가온 앰플");
    // ⚠️ **공급사 지급 메모에는 금액이 없다**(오너 확정 2026-08-26). 그 칸의 금액은
    // 물품대금인데 여러 캠페인이 한 장의 매입 계산서에 묶이므로 캠페인 단위 칸에
    // 끌어올 수 없다. 종전에는 이 자리에 **셀러 실지급액**이 찍혀 상대(공급사)와
    // 금액(셀러 몫)이 어긋나 있었다 — 계좌는 그대로 싣는다(이체할 곳은 확정이다).
    expect(body).toContain("지급 금액: 미정");
    expect(body).toContain("지급 계좌: (주)와그물산 신한 110-222-333444");
  });

  it("입금 메모에는 금액만 있고 계좌 줄이 없다 (받는 쪽이라 상대 계좌가 무의미하다)", async () => {
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma(sellerMallCampaign) as never);
    stubCreate();

    await syncCampaignToCalendar("c1");

    const body = descriptionOf("입금(셀러) 가온 앰플");
    expect(body).toContain("입금 금액: ₩3,200,000");
    expect(body).not.toContain("계좌");
  });

  it("자사몰 공급사 지급은 «금액 미정» 이고 셀러 지급은 셀러 계좌를 쓴다", async () => {
    const ownMall = {
      ...sellerMallCampaign,
      salesChannel: "OWN_MALL",
      expectedDepositDate: null,
      expectedSupplierPayoutDate: new Date("2026-08-20T00:00:00.000Z"),
    };
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma(ownMall) as never);
    stubCreate();

    await syncCampaignToCalendar("c1");

    const supplier = descriptionOf("지급(공급사) 가온 앰플");
    expect(supplier).toContain("지급 금액: 미정");
    expect(supplier).not.toContain("₩0");
    expect(supplier).toContain("지급 계좌: (주)와그물산 신한 110-222-333444");

    const seller = descriptionOf("지급(셀러) 가온 앰플");
    expect(seller).toContain("지급 금액: ₩1,240,000");
    expect(seller).toContain("지급 계좌: 국민 123456-78-901234");
  });

  it("계좌가 등록돼 있지 않으면 «미등록» 이라고 적는다", async () => {
    const noAccount = {
      ...sellerMallCampaign,
      deal: { dealName: "앰플", partner: { name: "(주)와그물산", bankAccount: null } },
    };
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma(noAccount) as never);
    stubCreate();

    await syncCampaignToCalendar("c1");

    expect(descriptionOf("지급(공급사) 가온 앰플")).toContain("지급 계좌: 미등록");
  });

  it("조합의 지급 금액은 멤버 합산이고 공급사가 여럿이면 전부 나열한다", async () => {
    const group = {
      id: "g1",
      name: "가온 8월 조합",
      expectedDepositDate: null,
      expectedPayoutDate: new Date("2026-08-15T00:00:00.000Z"),
      expectedSupplierPayoutDate: null,
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      calendarEventIds: null,
      seller: { name: "김본명", alias: "가온", accountNumber: "국민 123456-78-901234" },
      members: [
        {
          id: "c1",
          status: "PREPARATION",
          salesChannel: "BRAND_MALL",
          startDate: new Date("2026-08-01T00:00:00.000Z"),
          endDate: new Date("2026-08-03T00:00:00.000Z"),
          calendarEventIds: null,
          settlementSales: null,
          actualPayoutAmount: 1_000_000,
          deal: {
            dealName: "앰플",
            partner: { name: "(주)와그물산", bankAccount: "신한 110-222-333444" },
          },
        },
        {
          id: "c2",
          status: "PREPARATION",
          salesChannel: "BRAND_MALL",
          startDate: new Date("2026-08-02T00:00:00.000Z"),
          endDate: new Date("2026-08-05T00:00:00.000Z"),
          calendarEventIds: null,
          settlementSales: null,
          actualPayoutAmount: 240_000,
          deal: {
            dealName: "선크림",
            partner: { name: "뷰티코리아", bankAccount: "국민 987-654-321" },
          },
        },
      ],
    };
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma(null, group) as never);
    stubCreate();

    expect(await syncGroupToCalendar("g1")).toEqual({ ok: true });

    // 합산 검증은 **셀러 지급**으로 한다 — 공급사 지급(물품대금)은 정의상 「미정」이라
    // 더할 금액이 없다. 브랜드몰의 지급 상대가 셀러다(의무표).
    const body = descriptionOf("지급(셀러) 가온 8월 조합");
    expect(body).toContain("지급 금액: ₩1,240,000");
    expect(body).toContain("지급 계좌:");
  });

  it("드랍된 멤버의 금액은 조합 지급액에 더하지 않는다", async () => {
    const group = {
      id: "g1",
      name: "가온 8월 조합",
      expectedDepositDate: null,
      expectedPayoutDate: new Date("2026-08-15T00:00:00.000Z"),
      expectedSupplierPayoutDate: null,
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      calendarEventIds: null,
      seller: { name: "김본명", alias: "가온", accountNumber: null },
      members: [
        {
          id: "c1",
          status: "PREPARATION",
          salesChannel: "BRAND_MALL",
          startDate: new Date("2026-08-01T00:00:00.000Z"),
          endDate: new Date("2026-08-03T00:00:00.000Z"),
          calendarEventIds: null,
          settlementSales: null,
          actualPayoutAmount: 1_000_000,
          deal: { dealName: "앰플", partner: { name: "(주)와그물산", bankAccount: "신한 110" } },
        },
        {
          id: "c2",
          status: "DROPPED",
          salesChannel: "BRAND_MALL",
          startDate: new Date("2026-08-02T00:00:00.000Z"),
          endDate: new Date("2026-08-05T00:00:00.000Z"),
          calendarEventIds: null,
          settlementSales: null,
          actualPayoutAmount: 9_999_999,
          deal: { dealName: "선크림", partner: { name: "뷰티코리아", bankAccount: "국민 987" } },
        },
      ],
    };
    vi.mocked(getPrisma).mockReturnValue(makeFakePrisma(null, group) as never);
    stubCreate();

    await syncGroupToCalendar("g1");

    const body = descriptionOf("지급(셀러) 가온 8월 조합");
    expect(body).toContain("지급 금액: ₩1,000,000");
    expect(body).not.toContain("뷰티코리아");
  });
});
