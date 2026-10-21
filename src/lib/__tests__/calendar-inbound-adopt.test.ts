/**
 * [캘린더수집] 승인 뒤 넘겨받기 — 장부 기록(`adoptCalendarEventIntoLedger`)과 수집 행 상태(`adopt.ts`).
 *
 * 고정하는 것:
 *  ① 빈 장부 키에는 원본 이벤트 id 를 적는다(primary 는 하위호환 문자열, 그 밖은 `{id, cal}`).
 *  ② 같은 키에 **다른** id 가 있으면 덮지 않는다(conflict) — 오너 원본은 그대로 남는다.
 *  ③ 조합(그룹) 소속 캠페인은 **그룹 행** 장부에 적는다 — 기간·대금 이벤트 모두 그룹이 소유한다
 *     (`syncGroupOne` 이 멤버 장부의 이벤트를 지우므로 멤버 행에 적으면 원본이 삭제된다).
 *  ④ 이미 같은 id 면 쓰지 않는다(멱등).
 *  ⑤ 장부 쓰기는 조건부(읽은 원문 그대로일 때만) — 그 사이 동기화가 장부를 바꿨으면 다시 읽는다.
 *  ⑥ `readCalendarInboundRef` 는 문자열(SQLite)·객체 모두 읽고, 모양이 틀리면 null.
 *  ⑦ 상태 표기 — ADOPTED / REJECTED / PENDING_RETRY(지문 비움).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma", () => ({ getPrisma: vi.fn() }));
vi.mock("../google-calendar", () => ({
  getGoogleCalendarAccessToken: vi.fn(),
  getGoogleCalendarConnectionStatus: vi.fn(),
  getFinanceCalendarId: vi.fn(),
  GOOGLE_CALENDAR_PROVIDER: "google-calendar",
}));

import { getPrisma } from "../prisma";
import { adoptCalendarEventIntoLedger } from "../google-calendar-sync";
import {
  markInboundAdopted,
  markInboundRejected,
  readCalendarInboundRef,
  resetInboundForRetry,
} from "../calendar-inbound/adopt";
import { INBOUND_STATUS } from "../calendar-inbound/status";

function fakePrisma(opts: {
  campaign?: { id: string; groupId: string | null; calendarEventIds: string | null } | null;
  group?: { id: string; calendarEventIds: string | null } | null;
  updateCount?: number[];
}) {
  const counts = [...(opts.updateCount ?? [])];
  const nextCount = () => (counts.length > 0 ? counts.shift()! : 1);
  return {
    salesCampaign: {
      findUnique: vi.fn().mockResolvedValue(opts.campaign ?? null),
      updateMany: vi.fn(async (_args: unknown) => ({ count: nextCount() })),
    },
    campaignGroup: {
      findUnique: vi.fn().mockResolvedValue(opts.group ?? null),
      updateMany: vi.fn(async (_args: unknown) => ({ count: nextCount() })),
    },
    calendarInboundEvent: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("adoptCalendarEventIntoLedger", () => {
  it("빈 장부에 원본 이벤트를 적는다(primary 는 문자열 형식)", async () => {
    const db = fakePrisma({ campaign: { id: "c1", groupId: null, calendarEventIds: null } });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({
      campaignId: "c1",
      kind: "campaign",
      eventId: "ev-owner",
      calendarId: "primary",
    });

    expect(outcome).toBe("adopted");
    expect(db.salesCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", calendarEventIds: null },
      data: { calendarEventIds: JSON.stringify({ campaign: "ev-owner" }) },
    });
    expect(db.campaignGroup.updateMany).not.toHaveBeenCalled();
  });

  it("다른 키는 보존하고 비-primary 캘린더는 {id, cal} 로 적는다", async () => {
    const raw = JSON.stringify({ campaign: "ev-crm" });
    const db = fakePrisma({ campaign: { id: "c1", groupId: null, calendarEventIds: raw } });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({
      campaignId: "c1",
      kind: "deposit",
      eventId: "ev-dep",
      calendarId: "finance-cal-id",
    });

    expect(outcome).toBe("adopted");
    expect(db.salesCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", calendarEventIds: raw },
      data: {
        calendarEventIds: JSON.stringify({
          campaign: "ev-crm",
          deposit: { id: "ev-dep", cal: "finance-cal-id" },
        }),
      },
    });
  });

  it("같은 키에 다른 이벤트가 있으면 덮지 않는다(conflict)", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: JSON.stringify({ campaign: "ev-crm" }) },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({
      campaignId: "c1",
      kind: "campaign",
      eventId: "ev-owner",
      calendarId: "primary",
    });

    expect(outcome).toBe("conflict");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("이미 같은 이벤트가 적혀 있으면 쓰지 않는다(멱등)", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: JSON.stringify({ payout: "ev-owner" }) },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({
      campaignId: "c1",
      kind: "payout",
      eventId: "ev-owner",
      calendarId: "primary",
    });

    expect(outcome).toBe("already_adopted");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it.each(["campaign", "deposit"] as const)("그룹 소속 캠페인은 그룹 행 장부에 적는다(%s)", async (kind) => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: "g1", calendarEventIds: null },
      group: { id: "g1", calendarEventIds: null },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({
      campaignId: "c1",
      kind,
      eventId: "ev-owner",
      calendarId: "primary",
    });

    expect(outcome).toBe("adopted");
    expect(db.campaignGroup.updateMany).toHaveBeenCalledWith({
      where: { id: "g1", calendarEventIds: null },
      data: { calendarEventIds: JSON.stringify({ [kind]: "ev-owner" }) },
    });
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("조건부 쓰기가 밀리면(그 사이 장부가 바뀜) 다시 읽어 판정한다", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: null },
      updateCount: [0, 1],
    });
    db.salesCampaign.findUnique
      .mockResolvedValueOnce({ id: "c1", groupId: null, calendarEventIds: null })
      .mockResolvedValueOnce({ id: "c1", groupId: null, calendarEventIds: JSON.stringify({ deposit: "ev-x" }) });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({
      campaignId: "c1",
      kind: "campaign",
      eventId: "ev-owner",
      calendarId: "primary",
    });

    expect(outcome).toBe("adopted");
    expect(db.salesCampaign.updateMany).toHaveBeenCalledTimes(2);
    expect(db.salesCampaign.updateMany.mock.calls[1][0]).toEqual({
      where: { id: "c1", calendarEventIds: JSON.stringify({ deposit: "ev-x" }) },
      data: { calendarEventIds: JSON.stringify({ deposit: "ev-x", campaign: "ev-owner" }) },
    });
  });

  it("캠페인이 없으면 not_found", async () => {
    const db = fakePrisma({ campaign: null });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({
      campaignId: "gone",
      kind: "campaign",
      eventId: "ev-owner",
      calendarId: "primary",
    });

    expect(outcome).toBe("not_found");
  });
});

const REF = {
  inboundId: "in-1",
  eventId: "ev-owner",
  calendarId: "primary",
  ledgerKind: "campaign",
  adopt: true,
  summary: "샘플셀러 테스트브랜드 2차",
  startDate: "2026-11-03",
  endDate: "2026-11-09",
  htmlLink: "https://calendar.google.com/event?eid=x",
  warnings: [],
};

describe("readCalendarInboundRef", () => {
  it("객체(Postgres)·문자열(SQLite) 모두 읽는다", () => {
    expect(readCalendarInboundRef({ calendarInbound: REF })).toMatchObject({ inboundId: "in-1", adopt: true });
    expect(readCalendarInboundRef(JSON.stringify({ calendarInbound: REF }))).toMatchObject({
      eventId: "ev-owner",
      ledgerKind: "campaign",
    });
    expect(readCalendarInboundRef({ calendarInbound: { ...REF, htmlLink: null } })).not.toBeNull();
  });

  it("없거나 모양이 틀리면 null", () => {
    expect(readCalendarInboundRef(null)).toBeNull();
    expect(readCalendarInboundRef(undefined)).toBeNull();
    expect(readCalendarInboundRef("{깨진")).toBeNull();
    expect(readCalendarInboundRef({ workRecordId: "w1" })).toBeNull();
    expect(readCalendarInboundRef({ calendarInbound: { ...REF, ledgerKind: "refund" } })).toBeNull();
    expect(readCalendarInboundRef({ calendarInbound: { ...REF, adopt: "yes" } })).toBeNull();
    expect(readCalendarInboundRef({ calendarInbound: { ...REF, inboundId: "" } })).toBeNull();
  });
});

describe("수집 행 상태 표기", () => {
  it("markInboundAdopted: ADOPTED + 캠페인 id + skipReason", async () => {
    const db = fakePrisma({});
    vi.mocked(getPrisma).mockReturnValue(db as never);

    await markInboundAdopted("in-1", "c1");
    expect(db.calendarInboundEvent.updateMany).toHaveBeenLastCalledWith({
      where: { id: "in-1" },
      data: { status: INBOUND_STATUS.ADOPTED, campaignId: "c1", skipReason: null },
    });

    await markInboundAdopted("in-1", "c1", { skipReason: "ledger_conflict" });
    expect(db.calendarInboundEvent.updateMany).toHaveBeenLastCalledWith({
      where: { id: "in-1" },
      data: { status: INBOUND_STATUS.ADOPTED, campaignId: "c1", skipReason: "ledger_conflict" },
    });
  });

  it("markInboundRejected: REJECTED", async () => {
    const db = fakePrisma({});
    vi.mocked(getPrisma).mockReturnValue(db as never);

    await markInboundRejected("in-1");
    expect(db.calendarInboundEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "in-1" },
      data: { status: INBOUND_STATUS.REJECTED },
    });
  });

  it("resetInboundForRetry: PENDING_RETRY + 지문 비움", async () => {
    const db = fakePrisma({});
    vi.mocked(getPrisma).mockReturnValue(db as never);

    await resetInboundForRetry("in-1");
    expect(db.calendarInboundEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "in-1" },
      data: { status: INBOUND_STATUS.PENDING_RETRY, fingerprint: "" },
    });
  });
});
