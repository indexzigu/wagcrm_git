import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../prisma", () => ({ getPrisma: vi.fn() }));
vi.mock("../google-calendar", async (importOriginal) => ({
  // 시간 제한 상수는 실제 값을 쓴다(잠금 안에 드는지 합산 검증).
  GOOGLE_TOKEN_REQUEST_TIMEOUT_MS: (await importOriginal<typeof import("../google-calendar")>())
    .GOOGLE_TOKEN_REQUEST_TIMEOUT_MS,
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
import { GOOGLE_TOKEN_REQUEST_TIMEOUT_MS } from "../google-calendar";
import { SCAN_BUDGET_MS } from "../calendar-inbound/scan";
import { LOCK_TX_TIMEOUT_MS } from "../calendar-inbound/run-lock";
import {
  hasCrmDescriptionSignature,
  CANDIDATE_LIST_DEADLINE_MS,
  CANDIDATE_LIST_REQUEST_TIMEOUT_MS,
  listAllDayCandidateEvents,
  syncCampaignToCalendar,
} from "../google-calendar-sync";

const fetchMock = vi.fn();
const RANGE = { timeMin: "2026-10-01T00:00:00Z", timeMax: "2027-04-01T00:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({ connected: true } as never);
  vi.mocked(getGoogleCalendarAccessToken).mockResolvedValue("token-1");
  vi.mocked(getFinanceCalendarId).mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

function fakePrismaWithLedger(ledgerIds: string[] = []) {
  return {
    salesCampaign: {
      findMany: vi.fn().mockResolvedValue(
        ledgerIds.map((id) => ({ calendarEventIds: JSON.stringify({ campaign: id }) })),
      ),
    },
    campaignGroup: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe("listAllDayCandidateEvents", () => {
  it("종일 후보만 모으고 crmSigned·endDate(하루 뺀 값)·htmlLink 를 채운다", async () => {
    vi.mocked(getPrisma).mockReturnValue(fakePrismaWithLedger(["ev-ledger"]) as never);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: "a1", summary: "샘플 일정 A", start: { date: "2026-11-01" }, end: { date: "2026-11-04" }, htmlLink: "https://cal.example.com/a1" },
          { id: "a2", summary: "샘플 일정 B", start: { date: "2026-12-30" }, end: { date: "2027-01-01" } },
          { id: "t1", summary: "회의", start: { dateTime: "2026-11-02T10:00:00+09:00" }, end: { dateTime: "2026-11-02T11:00:00+09:00" } },
          { id: "r1", summary: "반복", start: { date: "2026-11-05" }, end: { date: "2026-11-06" }, recurrence: ["RRULE:FREQ=WEEKLY"] },
          { id: "c1", summary: "취소", status: "cancelled", start: { date: "2026-11-05" }, end: { date: "2026-11-06" } },
          { id: "s1", summary: "표식", start: { date: "2026-11-07" }, end: { date: "2026-11-08" }, extendedProperties: { private: { wagcrm: "1" } } },
          { id: "d1", summary: "서명", description: "셀러: 샘플셀러\n상태: ACTIVE", start: { date: "2026-11-09" }, end: { date: "2026-11-10" } },
        ],
      }),
    });

    const res = await listAllDayCandidateEvents(RANGE);
    expect(res.ok).toBe(true);
    expect(res.events.map((e) => e.id)).toEqual(["a1", "a2", "s1", "d1"]);
    expect(res.events.filter((e) => e.crmSigned).map((e) => e.id)).toEqual(["s1", "d1"]);
    const a1 = res.events[0];
    expect(a1).toMatchObject({
      calendarId: "primary",
      startDate: "2026-11-01",
      endDate: "2026-11-03",
      htmlLink: "https://cal.example.com/a1",
      description: null,
    });
    // 연말 경계 — 문자열 산술이라 시간대 이동 없음
    expect(res.events[1].endDate).toBe("2026-12-31");
    expect(res.events[1].htmlLink).toBeNull();
    expect(res.referencedIds.has("ev-ledger")).toBe(true);
  });

  it("미연결이면 not_connected, 토큰 오류면 error 로 알린다", async () => {
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({ connected: false } as never);
    const r1 = await listAllDayCandidateEvents(RANGE);
    expect(r1).toMatchObject({ ok: false, skipped: "not_connected", events: [] });

    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({ connected: true } as never);
    vi.mocked(getGoogleCalendarAccessToken).mockRejectedValue(new Error("토큰 만료"));
    const r2 = await listAllDayCandidateEvents(RANGE);
    expect(r2).toMatchObject({ ok: false, error: "토큰 만료", events: [] });
  });

  it("페이지네이션과 회계 캘린더를 함께 훑는다", async () => {
    vi.mocked(getPrisma).mockReturnValue(fakePrismaWithLedger() as never);
    vi.mocked(getFinanceCalendarId).mockResolvedValue("finance-cal-id");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("primary") && !url.includes("pageToken")) {
        return { ok: true, json: async () => ({ items: [{ id: "p1", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }], nextPageToken: "n2" }) };
      }
      if (url.includes("primary")) {
        return { ok: true, json: async () => ({ items: [{ id: "p2", start: { date: "2026-11-03" }, end: { date: "2026-11-04" } }] }) };
      }
      return { ok: true, json: async () => ({ items: [{ id: "f1", start: { date: "2026-11-05" }, end: { date: "2026-11-06" } }] }) };
    });
    const res = await listAllDayCandidateEvents(RANGE);
    expect(res.events.map((e) => [e.id, e.calendarId])).toEqual([
      ["p1", "primary"],
      ["p2", "primary"],
      ["f1", "finance-cal-id"],
    ]);
  });

  it("조회 실패 상태코드를 error 로 돌려준다", async () => {
    vi.mocked(getPrisma).mockReturnValue(fakePrismaWithLedger() as never);
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const res = await listAllDayCandidateEvents(RANGE);
    expect(res).toMatchObject({ ok: false, error: "이벤트 조회 실패: 403", events: [] });
  });

  it("요청마다 시간 제한 신호를 걸어 보낸다", async () => {
    vi.mocked(getPrisma).mockReturnValue(fakePrismaWithLedger() as never);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    await listAllDayCandidateEvents(RANGE);
    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("구글이 멈춰 신호가 발동하면 시간 초과 error 로 끝난다", async () => {
    vi.mocked(getPrisma).mockReturnValue(fakePrismaWithLedger() as never);
    fetchMock.mockImplementation(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const res = await listAllDayCandidateEvents(RANGE);
    expect(res).toMatchObject({ ok: false, error: "이벤트 조회 시간 초과", events: [] });
  });

  it("전체 조회 상한을 넘기면 다음 페이지를 부르지 않고 끝난다", async () => {
    vi.mocked(getPrisma).mockReturnValue(fakePrismaWithLedger() as never);
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(t0);
    fetchMock.mockImplementation(async () => {
      nowSpy.mockReturnValue(t0 + CANDIDATE_LIST_DEADLINE_MS + 1);
      return { ok: true, json: async () => ({ items: [], nextPageToken: "n2" }) };
    });
    let res;
    try {
      res = await listAllDayCandidateEvents(RANGE);
    } finally {
      nowSpy.mockRestore();
    }
    expect(res).toMatchObject({ ok: false, error: "이벤트 조회 시간 초과" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("시간 초과가 아닌 네트워크 오류는 종전처럼 던진다", async () => {
    vi.mocked(getPrisma).mockReturnValue(fakePrismaWithLedger() as never);
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(listAllDayCandidateEvents(RANGE)).rejects.toThrow("fetch failed");
  });

  it("토큰 갱신 + 조회 상한 + 회차 예산이 단일 실행 잠금(120초) 안에 든다", () => {
    expect(CANDIDATE_LIST_REQUEST_TIMEOUT_MS).toBeLessThan(CANDIDATE_LIST_DEADLINE_MS);
    expect(
      GOOGLE_TOKEN_REQUEST_TIMEOUT_MS + CANDIDATE_LIST_DEADLINE_MS + SCAN_BUDGET_MS,
    ).toBeLessThan(LOCK_TX_TIMEOUT_MS);
  });
});

describe("CRM 서명·표식 (실제 본문 빌더 출력 기준)", () => {
  it("캠페인 동기화가 만드는 이벤트 본문은 wagcrm 표식과 서명 줄을 싣는다", async () => {
    const campaign = {
      id: "c1",
      campaignName: "샘플 캠페인",
      status: "ACTIVE",
      salesChannel: "SELLER_MALL",
      startDate: new Date("2026-11-01T00:00:00.000Z"),
      endDate: new Date("2026-11-03T00:00:00.000Z"),
      expectedDepositDate: new Date("2026-11-10T00:00:00.000Z"),
      expectedPayoutDate: new Date("2026-11-15T00:00:00.000Z"),
      expectedSupplierPayoutDate: null,
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      calendarEventIds: null,
      groupId: null,
      settlementSales: null,
      actualSales: null,
      sellerExpense: null,
      actualPayoutAmount: null,
      seller: { name: "샘플셀러", alias: "샘플셀러", bankAccount: null },
      deal: { dealName: "테스트딜", partner: null },
    };
    const fakePrisma = {
      salesCampaign: {
        findUnique: vi.fn().mockResolvedValue(campaign),
        update: vi.fn().mockResolvedValue({}),
      },
      campaignGroup: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    vi.mocked(getPrisma).mockReturnValue(fakePrisma as never);
    let n = 0;
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ id: `new-${++n}` }) };
      return { ok: true, status: 204, json: async () => ({}) };
    });

    await syncCampaignToCalendar("c1");

    const bodies = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies.length).toBeGreaterThanOrEqual(2); // 기간 + 대금
    for (const b of bodies) {
      expect(b.extendedProperties).toEqual({ private: { wagcrm: "1" } });
      expect(hasCrmDescriptionSignature(b.description)).toBe(true);
    }
  });

  it("서명 판정: 줄 머리 「셀러: 」만 인정한다", () => {
    expect(hasCrmDescriptionSignature(null)).toBe(false);
    expect(hasCrmDescriptionSignature("")).toBe(false);
    expect(hasCrmDescriptionSignature("메모\n셀러: 샘플셀러")).toBe(true);
    expect(hasCrmDescriptionSignature("오늘 셀러: 미팅")).toBe(false);
  });
});
