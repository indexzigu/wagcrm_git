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
 *  ⑦ 상태 표기 — ADOPTED / REJECTED / PENDING_RETRY(지문 보존).
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
  claimInboundRowForApproval,
  markInboundAdopted,
  markInboundRejected,
  readCalendarInboundRef,
  resetInboundForRetry,
} from "../calendar-inbound/adopt";
import { INBOUND_STATUS } from "../calendar-inbound/status";
import { resolveCampaignMoneySlots } from "../tax-filing-board";

const NO_MONEY_DATES = {
  expectedDepositDate: null,
  expectedPayoutDate: null,
  expectedSupplierPayoutDate: null,
  depositReceivedAt: null,
  payoutCompletedAt: null,
  supplierPayoutCompletedAt: null,
  isDepositReceived: false,
  isPayoutCompleted: false,
  isSupplierPayoutCompleted: false,
};
const DATED = new Date("2026-11-20T00:00:00.000Z");

type CampaignRow = {
  id: string;
  groupId: string | null;
  calendarEventIds: string | null;
  status?: string;
  salesChannel?: string;
  [field: string]: unknown;
};

/** 캠페인 행 — 기본은 준비중·셀러몰·대금 예정일 전부 있음(모든 칸이 다음 동기화에 남는다). */
function campaignRow(row: CampaignRow) {
  return {
    status: "PREPARATION",
    salesChannel: "SELLER_MALL",
    ...NO_MONEY_DATES,
    expectedDepositDate: DATED,
    expectedPayoutDate: DATED,
    expectedSupplierPayoutDate: DATED,
    ...row,
  };
}

function fakePrisma(opts: {
  campaign?: CampaignRow | null;
  group?: { id: string; calendarEventIds: string | null; [field: string]: unknown } | null;
  updateCount?: number[];
  /** collectReferencedEventIds 가 읽는 다른 장부들 */
  otherCampaignLedgers?: string[];
  otherGroupLedgers?: string[];
}) {
  const counts = [...(opts.updateCount ?? [])];
  const nextCount = () => (counts.length > 0 ? counts.shift()! : 1);
  const own = opts.campaign ? campaignRow(opts.campaign) : null;
  const group = opts.group
    ? {
        ...NO_MONEY_DATES,
        expectedDepositDate: DATED,
        expectedPayoutDate: DATED,
        members: [{ id: "c1", status: "PREPARATION", salesChannel: "SELLER_MALL" }],
        ...opts.group,
      }
    : null;
  return {
    salesCampaign: {
      findUnique: vi.fn().mockResolvedValue(own),
      updateMany: vi.fn(async (_args: unknown) => ({ count: nextCount() })),
      findMany: vi.fn(async () =>
        [own?.calendarEventIds ?? null, ...(opts.otherCampaignLedgers ?? [])]
          .filter((raw): raw is string => raw != null)
          .map((calendarEventIds) => ({ calendarEventIds })),
      ),
    },
    campaignGroup: {
      findUnique: vi.fn().mockResolvedValue(group),
      updateMany: vi.fn(async (_args: unknown) => ({ count: nextCount() })),
      findMany: vi.fn(async () =>
        [group?.calendarEventIds ?? null, ...(opts.otherGroupLedgers ?? [])]
          .filter((raw): raw is string => raw != null)
          .map((calendarEventIds) => ({ calendarEventIds })),
      ),
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

const ADOPT = { campaignId: "c1", eventId: "ev-owner", calendarId: "primary" } as const;

describe("adoptCalendarEventIntoLedger", () => {
  it("픽스처 전제: 셀러몰은 입금·지급 칸, 자사몰은 지급(셀러)·지급(공급사) 칸이고 입금 칸이 없다", () => {
    expect(resolveCampaignMoneySlots("SELLER_MALL").map((s) => s.key).sort()).toEqual(["deposit", "payout"]);
    expect(resolveCampaignMoneySlots("OWN_MALL_NAVER").map((s) => s.key).sort()).toEqual(["payout", "supplierPayout"]);
  });

  it("빈 장부에 원본 이벤트를 적는다(primary 는 문자열 형식)", async () => {
    const db = fakePrisma({ campaign: { id: "c1", groupId: null, calendarEventIds: null } });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "campaign" });

    expect(outcome).toBe("adopted");
    expect(db.salesCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", calendarEventIds: null },
      data: { calendarEventIds: JSON.stringify({ campaign: "ev-owner" }) },
    });
    expect(db.campaignGroup.updateMany).not.toHaveBeenCalled();
  });

  it("다른 칸은 보존하고 비-primary 캘린더는 {id, cal} 로 적는다", async () => {
    const raw = JSON.stringify({ campaign: "ev-crm" });
    const db = fakePrisma({ campaign: { id: "c1", groupId: null, calendarEventIds: raw } });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "deposit", eventId: "ev-dep", calendarId: "finance-cal-id" });

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

  it("캘린더 불일치(대금 원본이 primary 인데 회계 캘린더가 따로 있다)여도 넘겨받는다 — 이사는 동기화 몫(설계 §3①)", async () => {
    const db = fakePrisma({ campaign: { id: "c1", groupId: null, calendarEventIds: null } });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "payout", calendarId: "primary" });

    expect(outcome).toBe("adopted");
    expect(db.salesCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", calendarEventIds: null },
      data: { calendarEventIds: JSON.stringify({ payout: "ev-owner" }) },
    });
  });

  it("같은 칸에 다른 이벤트가 있으면 덮지 않는다(conflict)", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: JSON.stringify({ campaign: "ev-crm" }) },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "campaign" });

    expect(outcome).toBe("conflict");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("이미 같은 이벤트가 적혀 있으면 쓰지 않는다(멱등)", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: JSON.stringify({ payout: "ev-owner" }) },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "payout" });

    expect(outcome).toBe("already_adopted");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("다른 캠페인 장부가 이미 그 이벤트를 가리키면 쓰지 않는다(already_referenced)", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: null },
      otherCampaignLedgers: [JSON.stringify({ campaign: "ev-owner" })],
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "campaign" });

    expect(outcome).toBe("already_referenced");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
    expect(db.campaignGroup.updateMany).not.toHaveBeenCalled();
  });

  it("그룹 장부가 이미 그 이벤트를 가리키면 쓰지 않는다(already_referenced)", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: null },
      otherGroupLedgers: [JSON.stringify({ deposit: { id: "ev-owner", cal: "finance-cal-id" } })],
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "deposit" });

    expect(outcome).toBe("already_referenced");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("자기 장부의 다른 칸이 그 이벤트를 가리켜도 already_referenced", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: JSON.stringify({ campaign: "ev-owner" }) },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    expect(await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "payout" })).toBe("already_referenced");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("not_active (a): 제안(PROPOSAL) 캠페인의 기간 칸 — 동기화가 장부를 통째로 지운다", async () => {
    const db = fakePrisma({ campaign: { id: "c1", groupId: null, calendarEventIds: null, status: "PROPOSAL" } });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    expect(await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "campaign" })).toBe("not_active");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("not_active (b): 지급 칸은 있지만 예정일이 비었다", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: null, expectedPayoutDate: null },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    expect(await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "payout" })).toBe("not_active");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("not_active (c): 채널에 그 칸이 없다(자사몰에는 입금 칸이 없다)", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: null, salesChannel: "OWN_MALL_NAVER" },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    expect(await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "deposit" })).toBe("not_active");
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("완료일만 있고 예정일이 빈 칸도 남는 칸이다(동기화와 같은 실효 날짜 판정)", async () => {
    const db = fakePrisma({
      campaign: {
        id: "c1",
        groupId: null,
        calendarEventIds: null,
        expectedPayoutDate: null,
        isPayoutCompleted: true,
        payoutCompletedAt: DATED,
      },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    expect(await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "payout" })).toBe("adopted");
  });

  it.each(["campaign", "deposit"] as const)("그룹 소속 캠페인은 그룹 행 장부에 적는다(%s)", async (kind) => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: "g1", calendarEventIds: null },
      group: { id: "g1", calendarEventIds: null },
    });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind });

    expect(outcome).toBe("adopted");
    expect(db.campaignGroup.updateMany).toHaveBeenCalledWith({
      where: { id: "g1", calendarEventIds: null },
      data: { calendarEventIds: JSON.stringify({ [kind]: "ev-owner" }) },
    });
    expect(db.salesCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("그룹: 대금 날짜는 그룹 행이 정본이고, 자격 있는 멤버가 없으면 not_active", async () => {
    const noDate = fakePrisma({
      campaign: { id: "c1", groupId: "g1", calendarEventIds: null },
      group: { id: "g1", calendarEventIds: null, expectedDepositDate: null },
    });
    vi.mocked(getPrisma).mockReturnValue(noDate as never);
    expect(await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "deposit" })).toBe("not_active");

    const allProposal = fakePrisma({
      campaign: { id: "c1", groupId: "g1", calendarEventIds: null },
      group: {
        id: "g1",
        calendarEventIds: null,
        members: [{ id: "c1", status: "PROPOSAL", salesChannel: "SELLER_MALL" }],
      },
    });
    vi.mocked(getPrisma).mockReturnValue(allProposal as never);
    expect(await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "campaign" })).toBe("not_active");
    expect(allProposal.campaignGroup.updateMany).not.toHaveBeenCalled();
  });

  it("조건부 쓰기가 밀리면(그 사이 장부가 바뀜) 다시 읽어 판정한다", async () => {
    const db = fakePrisma({
      campaign: { id: "c1", groupId: null, calendarEventIds: null },
      updateCount: [0, 1],
    });
    db.salesCampaign.findUnique
      .mockResolvedValueOnce(campaignRow({ id: "c1", groupId: null, calendarEventIds: null }))
      .mockResolvedValueOnce(
        campaignRow({ id: "c1", groupId: null, calendarEventIds: JSON.stringify({ deposit: "ev-x" }) }),
      );
    vi.mocked(getPrisma).mockReturnValue(db as never);

    const outcome = await adoptCalendarEventIntoLedger({ ...ADOPT, kind: "campaign" });

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

    expect(await adoptCalendarEventIntoLedger({ ...ADOPT, campaignId: "gone", kind: "campaign" })).toBe("not_found");
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
  it("markInboundAdopted: 그 기안이 행을 가리킬 때만 ADOPTED + 캠페인 id + skipReason", async () => {
    const db = fakePrisma({});
    vi.mocked(getPrisma).mockReturnValue(db as never);

    await markInboundAdopted("in-1", "p1", "c1");
    expect(db.calendarInboundEvent.updateMany).toHaveBeenLastCalledWith({
      where: { id: "in-1", proposalId: "p1" },
      data: { status: INBOUND_STATUS.ADOPTED, campaignId: "c1", skipReason: null },
    });

    await markInboundAdopted("in-1", "p1", "c1", { skipReason: "ledger_conflict" });
    expect(db.calendarInboundEvent.updateMany).toHaveBeenLastCalledWith({
      where: { id: "in-1", proposalId: "p1" },
      data: { status: INBOUND_STATUS.ADOPTED, campaignId: "c1", skipReason: "ledger_conflict" },
    });
  });

  it("행이 이미 다른 기안을 가리키면(0건) 덮지 않고 두 id 를 경고로 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakePrisma({});
    db.calendarInboundEvent.updateMany.mockResolvedValue({ count: 0 });
    vi.mocked(getPrisma).mockReturnValue(db as never);

    await markInboundAdopted("in-1", "p-old", "c1");
    await markInboundRejected("in-1", "p-old");
    await resetInboundForRetry("in-1", "p-old");

    expect(warn).toHaveBeenCalledTimes(3);
    for (const call of warn.mock.calls) {
      expect(String(call[0])).toContain("in-1");
      expect(String(call[0])).toContain("p-old");
    }
    warn.mockRestore();
  });

  it("markInboundRejected: 그 기안이 행을 가리킬 때만 REJECTED", async () => {
    const db = fakePrisma({});
    vi.mocked(getPrisma).mockReturnValue(db as never);

    await markInboundRejected("in-1", "p1");
    expect(db.calendarInboundEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "in-1", proposalId: "p1" },
      data: { status: INBOUND_STATUS.REJECTED },
    });
  });

  it("claimInboundRowForApproval: 행이 그 기안을 가리킬 때만 조건부로 잡고 updatedAt 을 명시해 올린다", async () => {
    // updatedAt 을 명시하는 것이 계약이다 — 스캔의 조건부 쓰기(scan.ts)가 이 값이 바뀌는 것으로 승인의 행 잡기를
    // 알아챈다. 「값이 그대로라 불필요」해 보여 지우면 경합 방어가 조용히 사라진다.
    for (const count of [1, 0]) {
      const before = Date.now();
      const updateMany = vi.fn(async (_args: unknown) => ({ count }));
      const tx = { calendarInboundEvent: { updateMany } };
      expect(await claimInboundRowForApproval(tx as never, "in-1", "p1")).toBe(count === 1);
      const args = updateMany.mock.calls[0][0] as { where: unknown; data: { proposalId: string; updatedAt: Date } };
      expect(args.where).toEqual({ id: "in-1", proposalId: "p1" });
      expect(args.data.proposalId).toBe("p1");
      expect(args.data.updatedAt).toBeInstanceOf(Date);
      expect(args.data.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("resetInboundForRetry: 그 기안이 행을 가리킬 때만 PENDING_RETRY — 지문은 건드리지 않는다", async () => {
    // 지문을 비우면, 다음 스캔 전에 재시도 승인이 성공해 ADOPTED 가 된 행도 「지문이 바뀜」으로 보여 다시
    // 기안된다(회차 표기 없는 제목이면 새 회차가 하나 더 생긴다). 재판정은 상태(PENDING_RETRY)만으로 한다.
    const db = fakePrisma({});
    vi.mocked(getPrisma).mockReturnValue(db as never);

    await resetInboundForRetry("in-1", "p1");
    expect(db.calendarInboundEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "in-1", proposalId: "p1" },
      data: { status: INBOUND_STATUS.PENDING_RETRY },
    });
  });
});
