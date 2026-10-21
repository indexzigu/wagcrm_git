import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { CandidateEvent } from "@/lib/google-calendar-sync";
import { WARN_SKIPPED_NEWER_ROUND, pickRecentCampaigns, pickMoneySlot, resolveInboundTarget } from "./resolve-target";
import type { ParsedCalendarIntent } from "./types";

// [캘린더수집] 대상 캠페인·칸 결정 — 가짜 DB(메모리) 위에서 판정만 본다. 가명 픽스처만 쓴다.

type FakeGroup = Record<string, unknown> & { id: string; updatedAt: Date };
type FakeCampaign = {
  id: string;
  sellerId: string;
  dealId: string;
  status: string;
  salesChannel: string;
  roundNumber: number | null;
  campaignName: string | null;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  updatedAt: Date;
  groupId: string | null;
  expectedDepositDate: Date | null;
  expectedPayoutDate: Date | null;
  expectedSupplierPayoutDate: Date | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
  notesFromImport: string | null;
};

const d = (ymd: string) => new Date(`${ymd}T00:00:00+09:00`);

function campaign(over: Partial<FakeCampaign> & { id: string }): FakeCampaign {
  return {
    sellerId: "s1",
    dealId: "d1",
    status: "PREPARATION",
    salesChannel: "SELLER_MALL",
    roundNumber: null,
    campaignName: null,
    startDate: d("2026-11-01"),
    endDate: d("2026-11-07"),
    createdAt: d("2026-10-01"),
    updatedAt: d("2026-10-01"),
    groupId: null,
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    notesFromImport: null,
    ...over,
  };
}

const deals = [
  { id: "d1", dealName: "테스트브랜드 봄딜", brandName: "테스트브랜드", status: "CONFIRMED" },
  { id: "d2", dealName: "테스트브랜드 가을딜", brandName: "테스트브랜드", status: "ARCHIVED" },
];
const sellers = [{ id: "s1", name: "샘플셀러", alias: "샘플" }];

function fakeDb(campaigns: FakeCampaign[], groups: FakeGroup[] = []) {
  const withRelations = (c: FakeCampaign) => ({
    ...c,
    deal: deals.find((x) => x.id === c.dealId)!,
    seller: sellers.find((x) => x.id === c.sellerId)!,
    group: c.groupId ? (groups.find((g) => g.id === c.groupId) ?? null) : null,
  });
  return {
    salesCampaign: {
      findMany: async ({ where }: { where: { sellerId: string; dealId: { in: string[] } } }) =>
        campaigns
          .filter((c) => c.sellerId === where.sellerId && where.dealId.in.includes(c.dealId))
          .map(withRelations),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const c = campaigns.find((x) => x.id === where.id);
        return c ? withRelations(c) : null;
      },
    },
    deal: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        deals.filter((x) => where.id.in.includes(x.id)),
    },
    seller: {
      findUnique: async ({ where }: { where: { id: string } }) => sellers.find((x) => x.id === where.id) ?? null,
    },
  } as unknown as Prisma.TransactionClient;
}

function intent(over: Partial<ParsedCalendarIntent>): ParsedCalendarIntent {
  return { kind: "campaign", sellerId: "s1", dealIds: ["d1"], round: null, supplierHint: false, matchedBy: "rule", ...over };
}

function event(startDate: string, endDate = startDate): CandidateEvent {
  return {
    id: "ev1",
    calendarId: "primary",
    summary: "샘플 테스트브랜드",
    description: null,
    startDate,
    endDate,
    htmlLink: null,
    crmSigned: false,
  } as CandidateEvent;
}

describe("resolveInboundTarget — 캠페인 회차", () => {
  it("회차 표기 없음 → 새 회차 생성(가장 최근 캠페인의 딜) · 후보가 여럿이면 자동 지정 경고", async () => {
    const db = fakeDb([
      campaign({ id: "c1", roundNumber: null }),
      campaign({ id: "c0", roundNumber: null, startDate: d("2026-09-01"), endDate: d("2026-09-07") }),
    ]);
    const r = await resolveInboundTarget(intent({ round: null }), event("2026-12-01", "2026-12-07"), db);
    expect(r).toEqual({
      ok: true,
      draft: {
        action: "create_campaign_round",
        args: { dealId: "d1", sellerId: "s1", startDate: "2026-12-01", endDate: "2026-12-07" },
        title: "캘린더 일정 → 새 회차 생성: 샘플 · 테스트브랜드 봄딜 (2026-12-01~2026-12-07)",
        targetCampaignId: null,
        warnings: ["가장 최근 회차로 자동 지정"],
        adopt: true,
        ledgerKind: "campaign",
      },
    });
  });

  it("회차 표기 없음 + 후보 캠페인 1건이면 자동 지정 경고를 달지 않는다(고를 것이 없었다)", async () => {
    const db = fakeDb([campaign({ id: "c1", roundNumber: null })]);
    const r = await resolveInboundTarget(intent({ round: null }), event("2026-12-01", "2026-12-07"), db);
    expect(r.ok && r.draft.action).toBe("create_campaign_round");
    expect(r.ok && r.draft.warnings).toEqual([]);
  });

  it("회차 N 이 있는데 그 회차가 없으면 생성 + 번호 경고, 하루짜리면 종료일 경고", async () => {
    const db = fakeDb([]);
    const r = await resolveInboundTarget(intent({ round: 3 }), event("2026-12-01"), db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.action).toBe("create_campaign_round");
    // 캠페인이 없으면 활성 딜이 유일할 때 그 딜(d2 는 ARCHIVED 라 활성이 아님)
    expect(r.draft.args).toEqual({ dealId: "d1", sellerId: "s1", startDate: "2026-12-01", endDate: "2026-12-01" });
    expect(r.draft.warnings).toEqual(["종료일 확인 필요", "CRM 회차 번호는 날짜순 자동 부여(제목의 N차와 다를 수 있음)"]);
  });

  it("활성 딜이 유일하지 않고 캠페인도 없으면 no_deal", async () => {
    const db = fakeDb([]);
    const r = await resolveInboundTarget(intent({ dealIds: ["d2"] }), event("2026-12-01"), db);
    expect(r).toEqual({ ok: false, reason: "no_deal" });
  });

  it("기간 수정: 회차 N 이 있으면 update_record(startDate·endDate, expected 현재값)", async () => {
    const db = fakeDb([
      campaign({ id: "c1", roundNumber: 1, startDate: d("2026-11-01"), endDate: d("2026-11-07") }),
      campaign({ id: "c2", roundNumber: 2, startDate: d("2026-12-01"), endDate: d("2026-12-07"), campaignName: "봄딜 샘플 2차" }),
    ]);
    const r = await resolveInboundTarget(intent({ round: 2 }), event("2026-12-03", "2026-12-10"), db);
    expect(r).toEqual({
      ok: true,
      draft: {
        action: "update_record",
        args: {
          entityType: "CAMPAIGN",
          entityId: "c2",
          changes: { startDate: "2026-12-03", endDate: "2026-12-10" },
          expected: { startDate: "2026-12-01", endDate: "2026-12-07" },
        },
        title: "캘린더 일정 → 시작일·종료일 변경: 봄딜 샘플 2차",
        targetCampaignId: "c2",
        warnings: [],
        adopt: true,
        ledgerKind: "campaign",
      },
    });
  });

  it("기간 수정도 하루짜리 일정이면 종료일 경고를 단다", async () => {
    const db = fakeDb([campaign({ id: "c1", roundNumber: 2, startDate: d("2026-12-01"), endDate: d("2026-12-07") })]);
    const r = await resolveInboundTarget(intent({ round: 2 }), event("2026-12-03"), db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.action).toBe("update_record");
    expect(r.draft.warnings).toEqual(["종료일 확인 필요"]);
  });

  it("1차는 roundNumber null 회차도 맞고, 바뀐 칸만 싣는다", async () => {
    const db = fakeDb([campaign({ id: "c1", roundNumber: null })]);
    const r = await resolveInboundTarget(intent({ round: 1 }), event("2026-11-01", "2026-11-09"), db);
    expect(r.ok && r.draft.args).toEqual({
      entityType: "CAMPAIGN",
      entityId: "c1",
      changes: { endDate: "2026-11-09" },
      expected: { endDate: "2026-11-07" },
    });
    expect(r.ok && r.draft.title).toBe("캘린더 일정 → 종료일 변경: 테스트브랜드 봄딜 - 샘플");
  });

  it("스키마가 거절하는 초안은 invalid_draft + 사유(throw 하지 않음)", async () => {
    const db = fakeDb([campaign({ id: "c1", roundNumber: 1 })]);
    // 존재하지 않는 날짜 — 화면 PATCH 스키마(z.string().date())가 거절한다.
    const r = await resolveInboundTarget(intent({ round: 1 }), event("2026-11-01", "2026-13-40"), db);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "invalid_draft") throw new Error(`invalid_draft 여야 한다: ${JSON.stringify(r)}`);
    expect(r.detail).toContain("endDate");
  });

  it("noop: 날짜가 이미 같으면 noop 기안", async () => {
    const db = fakeDb([campaign({ id: "c1", roundNumber: 1 })]);
    const r = await resolveInboundTarget(intent({ round: 1 }), event("2026-11-01", "2026-11-07"), db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft).toMatchObject({ action: "update_record", noop: true, targetCampaignId: "c1", adopt: true, ledgerKind: "campaign" });
  });

  it("DROPPED 캠페인은 대상에서 빠진다 — 맞는 회차가 DROPPED 면 새 회차", async () => {
    const db = fakeDb([campaign({ id: "c1", roundNumber: 2, status: "DROPPED" })]);
    const r = await resolveInboundTarget(intent({ round: 2 }), event("2026-12-01", "2026-12-07"), db);
    expect(r.ok && r.draft.action).toBe("create_campaign_round");
    // DROPPED 캠페인의 딜도 「가장 최근 캠페인의 딜」 로 쓰지 않는다 — 활성 딜 유일 경로로 d1
    expect(r.ok && r.draft.targetCampaignId).toBeNull();
    expect(r.ok && (r.draft.args as { dealId: string }).dealId).toBe("d1");
  });

  it("PROPOSAL 대상이면 adopt=false + 경고", async () => {
    const db = fakeDb([campaign({ id: "c1", roundNumber: 1, status: "PROPOSAL" })]);
    const r = await resolveInboundTarget(intent({ round: 1 }), event("2026-11-02", "2026-11-07"), db);
    expect(r.ok && r.draft.adopt).toBe(false);
    expect(r.ok && r.draft.warnings).toContain("제안 단계라 캘린더 정리는 세팅대기 전환 후");
  });
});

describe("resolveInboundTarget — 입금·지급", () => {
  it("입금: 입금 미완료인 가장 최근 회차의 입금 예정일", async () => {
    const db = fakeDb([
      campaign({ id: "c1", startDate: d("2026-10-01"), isDepositReceived: false }),
      campaign({ id: "c2", startDate: d("2026-11-01"), isDepositReceived: true, expectedDepositDate: d("2026-11-20") }),
    ]);
    const r = await resolveInboundTarget(intent({ kind: "deposit" }), event("2026-11-25"), db);
    expect(r).toEqual({
      ok: true,
      draft: {
        action: "update_record",
        args: {
          entityType: "CAMPAIGN",
          entityId: "c1",
          changes: { expectedDepositDate: "2026-11-25" },
          expected: { expectedDepositDate: null },
        },
        title: "캘린더 일정 → 입금 예정일 변경: 테스트브랜드 봄딜 - 샘플",
        targetCampaignId: "c1",
        warnings: ["가장 최근 회차로 자동 지정"],
        adopt: true,
        ledgerKind: "deposit",
      },
    });
  });

  it("지급: 셀러몰의 지급 슬롯(payout) — 전부 완료면 가장 최근", async () => {
    const db = fakeDb([
      campaign({ id: "c1", startDate: d("2026-10-01"), isPayoutCompleted: true }),
      campaign({ id: "c2", startDate: d("2026-11-01"), isPayoutCompleted: true, expectedPayoutDate: d("2026-11-30") }),
    ]);
    const r = await resolveInboundTarget(intent({ kind: "payout" }), event("2026-12-05"), db);
    expect(r.ok && r.draft.args).toEqual({
      entityType: "CAMPAIGN",
      entityId: "c2",
      changes: { expectedPayoutDate: "2026-12-05" },
      expected: { expectedPayoutDate: "2026-11-30" },
    });
    expect(r.ok && r.draft.ledgerKind).toBe("payout");
  });

  it("공급사 지급: 자사몰 + 공급사 단어 → supplierPayout 슬롯", async () => {
    const db = fakeDb([campaign({ id: "c1", salesChannel: "OWN_MALL" })]);
    const r = await resolveInboundTarget(intent({ kind: "payout", supplierHint: true }), event("2026-12-05"), db);
    expect(r.ok && r.draft.args).toEqual({
      entityType: "CAMPAIGN",
      entityId: "c1",
      changes: { expectedSupplierPayoutDate: "2026-12-05" },
      expected: { expectedSupplierPayoutDate: null },
    });
    expect(r.ok && r.draft.ledgerKind).toBe("supplierPayout");
    expect(r.ok && r.draft.warnings).toEqual([]);
  });

  it("최근 회차(자사몰)에 입금 칸이 없으면 이전 회차로 지정 + 경고", async () => {
    const db = fakeDb([
      campaign({ id: "new", salesChannel: "OWN_MALL", startDate: d("2026-12-01") }),
      campaign({ id: "old", salesChannel: "SELLER_MALL", startDate: d("2026-11-01") }),
    ]);
    const r = await resolveInboundTarget(intent({ kind: "deposit" }), event("2026-12-20"), db);
    expect(r.ok && r.draft.targetCampaignId).toBe("old");
    expect(r.ok && r.draft.warnings).toEqual(["가장 최근 회차로 자동 지정", WARN_SKIPPED_NEWER_ROUND]);
    expect(WARN_SKIPPED_NEWER_ROUND).toBe("최근 회차는 이 칸이 없어 이전 회차로 지정");
  });

  it("자사몰 입금은 슬롯이 없어 no_slot", async () => {
    const db = fakeDb([campaign({ id: "c1", salesChannel: "OWN_MALL" })]);
    const r = await resolveInboundTarget(intent({ kind: "deposit" }), event("2026-12-05"), db);
    expect(r).toEqual({ ok: false, reason: "no_slot" });
  });

  it("캠페인이 없으면 no_campaign", async () => {
    const r = await resolveInboundTarget(intent({ kind: "deposit" }), event("2026-12-05"), fakeDb([]));
    expect(r).toEqual({ ok: false, reason: "no_campaign" });
  });

  it("묶음 캠페인: expected 는 묶음 행 값, 완료 여부도 묶음 행으로 판정, entityId 는 멤버 id", async () => {
    const group: FakeGroup = {
      id: "g1",
      updatedAt: d("2026-10-01"),
      invoiceInfo: null,
      expectedDepositDate: d("2026-11-15"),
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      supplierInvoiceIssuedAt: null,
      sellerInvoiceIssuedAt: null,
      accountingCompletedAt: null,
    };
    const db = fakeDb(
      [
        // 멤버 행 잔존값은 완료·다른 날짜지만 묶음 행이 정본이다.
        campaign({ id: "m1", groupId: "g1", isDepositReceived: true, expectedDepositDate: d("2026-01-01") }),
      ],
      [group],
    );
    const r = await resolveInboundTarget(intent({ kind: "deposit" }), event("2026-11-20"), db);
    expect(r.ok && r.draft.args).toEqual({
      entityType: "CAMPAIGN",
      entityId: "m1",
      changes: { expectedDepositDate: "2026-11-20" },
      expected: { expectedDepositDate: "2026-11-15" },
    });
  });

  it("입금 대상이 PROPOSAL 이면 adopt=false", async () => {
    const db = fakeDb([campaign({ id: "c1", status: "PROPOSAL" })]);
    const r = await resolveInboundTarget(intent({ kind: "deposit" }), event("2026-11-20"), db);
    expect(r.ok && r.draft.adopt).toBe(false);
    expect(r.ok && r.draft.warnings).toEqual(["제안 단계라 캘린더 정리는 세팅대기 전환 후"]);
  });
});

describe("순수 판정 도우미", () => {
  it("pickRecentCampaigns: DROPPED 제외 · startDate desc · 같으면 createdAt desc", () => {
    const rows = [
      { id: "a", status: "ACTIVE", startDate: d("2026-11-01"), createdAt: d("2026-10-01") },
      { id: "b", status: "DROPPED", startDate: d("2026-12-01"), createdAt: d("2026-10-01") },
      { id: "c", status: "ACTIVE", startDate: d("2026-11-01"), createdAt: d("2026-10-05") },
      { id: "e", status: "ACTIVE", startDate: d("2026-09-01"), createdAt: d("2026-10-09") },
    ];
    expect(pickRecentCampaigns(rows).map((r) => r.id)).toEqual(["c", "a", "e"]);
  });

  it("pickMoneySlot: 채널별 슬롯 선택", () => {
    expect(pickMoneySlot("SELLER_MALL", "deposit", false)?.key).toBe("deposit");
    expect(pickMoneySlot("OWN_MALL", "deposit", false)).toBeNull();
    expect(pickMoneySlot("OWN_MALL", "payout", false)?.key).toBe("payout");
    expect(pickMoneySlot("OWN_MALL", "payout", true)?.key).toBe("supplierPayout");
    // 지급 레그가 하나뿐인 채널은 공급사 단어가 있어도 그 한 칸(payout)
    expect(pickMoneySlot("SELLER_MALL", "payout", true)?.key).toBe("payout");
  });
});
