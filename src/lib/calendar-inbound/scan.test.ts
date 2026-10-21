import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateEvent, CandidateListResult } from "@/lib/google-calendar-sync";
import { getRequestTypeForAction } from "@/lib/agent/approval-policy";
import { CALENDAR_INBOUND_CREATED_BY, calendarInboundRefSchema } from "./adopt";
import type { ProposalDraft, ResolveResult } from "./resolve-target";
import {
  MAX_PROPOSALS_PER_RUN,
  calendarInboundFingerprint,
  calendarInboundWindow,
  runCalendarInboundScan,
  type CalendarInboundScanDeps,
  type InboundRow,
  type InboundRowWrite,
} from "./scan";
import type { InboundDictionary, ParsedCalendarIntent, TitleHints } from "./types";

// [캘린더수집] 스캔 오케스트레이션 — 캘린더·DB·LLM 은 전부 가짜(메모리). 가명 픽스처만 쓴다.

const NOW = new Date("2026-10-22T03:00:00.000Z"); // KST 2026-10-22 12:00

const DICT: InboundDictionary = {
  sellers: [{ id: "s1", names: ["샘플셀러"] }],
  deals: [{ id: "d1", brandNames: ["테스트브랜드"], dealName: "테스트브랜드 봄딜", partnerName: null }],
};

function ev(id: string, over: Partial<CandidateEvent> = {}): CandidateEvent {
  return {
    id,
    calendarId: "primary",
    summary: "샘플셀러 테스트브랜드 2차",
    description: null,
    startDate: "2026-11-03",
    endDate: "2026-11-09",
    htmlLink: `https://calendar.example.com/${id}`,
    crmSigned: false,
    ...over,
  };
}

const CREATE_DRAFT: ProposalDraft = {
  action: "create_campaign_round",
  args: { dealId: "d1", sellerId: "s1", startDate: "2026-11-03", endDate: "2026-11-09" },
  title: "캘린더 일정 → 새 회차 생성: 샘플셀러 · 테스트브랜드 봄딜 (2026-11-03~2026-11-09)",
  targetCampaignId: null,
  warnings: ["CRM 회차 번호는 날짜순 자동 부여(제목의 N차와 다를 수 있음)"],
  adopt: true,
  ledgerKind: "campaign",
};

type StoredRow = InboundRow & Omit<InboundRowWrite, "proposalId" | "parsed"> & { parsed: unknown };

function makeHarness(events: CandidateEvent[], referenced: string[] = []) {
  const rows = new Map<string, StoredRow>();
  const proposals = new Map<string, { status: string; data: Record<string, unknown> }>();
  let rowSeq = 0;
  let proposalSeq = 0;
  const listing: { value: CandidateListResult } = {
    value: { ok: true, events, referencedIds: new Set(referenced) },
  };
  const resolveTarget = vi.fn(
    async (_intent: ParsedCalendarIntent, _event: CandidateEvent): Promise<ResolveResult> => ({
      ok: true,
      draft: CREATE_DRAFT,
    }),
  );
  const extractHints = vi.fn(async (_summary: string): Promise<TitleHints | null> => null);
  const adoptIntoLedger = vi.fn<CalendarInboundScanDeps["adoptIntoLedger"]>(async () => "adopted");
  const listCandidates = vi.fn(async () => listing.value);

  const deps: CalendarInboundScanDeps = {
    listCandidates,
    loadDictionary: async () => DICT,
    extractHints,
    resolveTarget,
    adoptIntoLedger,
    createProposal: async (data) => {
      const id = `prop-${++proposalSeq}`;
      proposals.set(id, { status: "PENDING_APPROVAL", data: data as unknown as Record<string, unknown> });
      return { id };
    },
    findRows: async (ids) => ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : [])),
    findProposalStatuses: async (ids) =>
      new Map(ids.flatMap((id) => (proposals.has(id) ? [[id, proposals.get(id)!.status] as const] : []))),
    saveRow: async (googleEventId, write) => {
      const existing = rows.get(googleEventId);
      const next: StoredRow = {
        ...(existing ?? { id: `in-${++rowSeq}`, googleEventId, proposalId: null, campaignId: null, parsed: null }),
        ...Object.fromEntries(Object.entries(write).filter(([, v]) => v !== undefined)),
      } as StoredRow;
      rows.set(googleEventId, next);
      return { id: next.id };
    },
    touchRows: async (ids, lastSeenAt) => {
      for (const row of rows.values()) if (ids.includes(row.id)) row.lastSeenAt = lastSeenAt;
    },
  };
  return { deps, rows, proposals, listing, resolveTarget, extractHints, adoptIntoLedger, listCandidates };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("calendarInboundWindow · fingerprint", () => {
  it("창은 KST 오늘-14일 ~ 오늘+180일(끝날 포함)", () => {
    expect(calendarInboundWindow(NOW)).toEqual({
      timeMin: "2026-10-07T15:00:00.000Z", // KST 2026-10-08 00:00
      timeMax: "2027-04-20T15:00:00.000Z", // KST 2027-04-21 00:00 (= 04-20 끝까지)
    });
  });

  it("지문은 제목·시작·끝에만 의존", () => {
    const a = calendarInboundFingerprint(ev("e1"));
    expect(calendarInboundFingerprint(ev("e2", { calendarId: "fin" }))).toBe(a);
    expect(calendarInboundFingerprint(ev("e1", { endDate: "2026-11-10" }))).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("runCalendarInboundScan", () => {
  it("새 이벤트 1건 → 기안 1건 · 행 PROPOSED", async () => {
    const h = makeHarness([ev("e1")]);

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(h.listCandidates).toHaveBeenCalledWith(calendarInboundWindow(NOW));
    expect(summary).toEqual({
      ok: true,
      scanned: 1,
      crmOwned: 0,
      newOrChanged: 1,
      proposed: 1,
      skippedUnparsed: 0,
      adoptedNoop: 0,
      dropped: 0,
      alreadyHandled: 0,
      errors: 0,
    });
    const row = h.rows.get("e1")!;
    expect(row).toMatchObject({
      status: "PROPOSED",
      proposalId: "prop-1",
      fingerprint: calendarInboundFingerprint(ev("e1")),
      skipReason: null,
      calendarId: "primary",
      summary: "샘플셀러 테스트브랜드 2차",
      startDate: "2026-11-03",
      endDate: "2026-11-09",
      lastSeenAt: NOW,
    });
    expect(row.parsed).toMatchObject({ kind: "campaign", sellerId: "s1", dealIds: ["d1"], round: 2 });

    const data = h.proposals.get("prop-1")!.data;
    expect(data).toMatchObject({
      requestType: getRequestTypeForAction("create_campaign_round"),
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      title: CREATE_DRAFT.title,
      payload: { action: "create_campaign_round", args: CREATE_DRAFT.args },
      campaignId: null,
      targetEntityType: "CAMPAIGN",
      createdBy: CALENDAR_INBOUND_CREATED_BY,
      risks: CREATE_DRAFT.warnings,
    });
    // 승인 쪽이 읽는 출처 모양 그대로 — 수집 행 id 가 들어 있다.
    const ref = calendarInboundRefSchema.parse((data.sourceRef as { calendarInbound: unknown }).calendarInbound);
    expect(ref).toEqual({
      inboundId: row.id,
      eventId: "e1",
      calendarId: "primary",
      ledgerKind: "campaign",
      adopt: true,
      summary: "샘플셀러 테스트브랜드 2차",
      startDate: "2026-11-03",
      endDate: "2026-11-09",
      htmlLink: "https://calendar.example.com/e1",
      warnings: CREATE_DRAFT.warnings,
    });
  });

  it("기간 수정 기안은 requestType 도 액션에서 정하고 대상 캠페인을 싣는다", async () => {
    const h = makeHarness([ev("e1")]);
    h.resolveTarget.mockResolvedValue({
      ok: true,
      draft: {
        ...CREATE_DRAFT,
        action: "update_record",
        args: { entityType: "CAMPAIGN", entityId: "c1", changes: { endDate: "2026-11-09" }, expected: {} },
        targetCampaignId: "c1",
      },
    });

    await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(h.proposals.get("prop-1")!.data).toMatchObject({
      requestType: getRequestTypeForAction("update_record"),
      campaignId: "c1",
      targetEntityId: "c1",
    });
    expect(h.rows.get("e1")).toMatchObject({ status: "PROPOSED", campaignId: "c1" });
  });

  it("같은 지문으로 다시 돌리면 기안 0건 · lastSeenAt 만 갱신", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    const later = new Date(NOW.getTime() + 30 * 60_000);

    const summary = await runCalendarInboundScan({ now: later, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, newOrChanged: 0, alreadyHandled: 1 });
    expect(h.proposals.size).toBe(1);
    expect(h.resolveTarget).toHaveBeenCalledTimes(1);
    expect(h.rows.get("e1")).toMatchObject({ status: "PROPOSED", proposalId: "prop-1", lastSeenAt: later });
  });

  it("지문이 바뀌었는데 열린 기안이 있으면 SKIPPED open_proposal · proposalId 유지 · 지문은 옛것", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    const oldFingerprint = h.rows.get("e1")!.fingerprint;
    h.listing.value = { ok: true, events: [ev("e1", { endDate: "2026-11-12" })], referencedIds: new Set() };

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, alreadyHandled: 1 });
    expect(h.proposals.size).toBe(1);
    expect(h.resolveTarget).toHaveBeenCalledTimes(1);
    expect(h.rows.get("e1")).toMatchObject({
      status: "SKIPPED",
      skipReason: "open_proposal",
      proposalId: "prop-1",
      fingerprint: oldFingerprint,
      endDate: "2026-11-12",
    });

    // 기안이 반려돼 닫히면(반려 표기 성공 → REJECTED) 바뀐 지문으로 다시 판정한다.
    h.proposals.get("prop-1")!.status = "REJECTED";
    h.rows.get("e1")!.status = "REJECTED";
    const again = await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(again).toMatchObject({ proposed: 1, newOrChanged: 1 });
    expect(h.rows.get("e1")).toMatchObject({ status: "PROPOSED", proposalId: "prop-2", skipReason: null });
  });

  it("PROPOSED 행인데 기안이 이미 EXECUTED/REJECTED 면(사후 표기 실패) 손대지 않는다", async () => {
    for (const closed of ["EXECUTED", "REJECTED"]) {
      const h = makeHarness([ev("e1")]);
      await runCalendarInboundScan({ now: NOW, deps: h.deps });
      h.proposals.get("prop-1")!.status = closed;
      h.listing.value = { ok: true, events: [ev("e1", { endDate: "2026-11-12" })], referencedIds: new Set() };

      const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

      expect(summary).toMatchObject({ proposed: 0, alreadyHandled: 1, newOrChanged: 0 });
      expect(h.rows.get("e1")).toMatchObject({ status: "PROPOSED", proposalId: "prop-1", endDate: "2026-11-09" });
    }
  });

  it("파서 실패 → 힌트 1회 → 그래도 실패면 SKIPPED(사유) · 같은 지문은 다시 해석하지 않는다", async () => {
    const h = makeHarness([ev("e1", { summary: "치과 예약" })]);

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, skippedUnparsed: 1, newOrChanged: 1 });
    expect(h.extractHints).toHaveBeenCalledTimes(1);
    expect(h.extractHints).toHaveBeenCalledWith("치과 예약");
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller", parsed: null });

    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(h.extractHints).toHaveBeenCalledTimes(1);
  });

  it("규칙 파서가 맞히면 힌트를 부르지 않는다 · 실패분은 힌트로 다시 맞춘다(matchedBy llm)", async () => {
    const h = makeHarness([ev("e1"), ev("e2", { summary: "ㅅㅍ 테스트브랜드" })]);
    h.extractHints.mockResolvedValue({ sellerHint: "샘플셀러", brandHint: null, round: null, kind: null });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 2, skippedUnparsed: 0 });
    expect(h.extractHints).toHaveBeenCalledTimes(1);
    expect(h.extractHints).toHaveBeenCalledWith("ㅅㅍ 테스트브랜드");
    expect(h.rows.get("e2")!.parsed).toMatchObject({ sellerId: "s1", matchedBy: "llm" });
  });

  it("대상 결정 실패 → SKIPPED(사유), invalid_draft 는 상세를 붙여 500자로 자른다", async () => {
    const h = makeHarness([ev("e1"), ev("e2")]);
    h.resolveTarget.mockImplementation(async (_intent, event) =>
      event.id === "e1"
        ? { ok: false, reason: "no_deal" }
        : { ok: false, reason: "invalid_draft", detail: "x".repeat(800) },
    );

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, skippedUnparsed: 2 });
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_deal" });
    const reason = h.rows.get("e2")!.skipReason!;
    expect(reason.startsWith("invalid_draft: xxx")).toBe(true);
    expect(reason).toHaveLength(500);
    expect(h.rows.get("e2")!.parsed).toMatchObject({ sellerId: "s1" });
  });

  it("noop → 바로 넘겨받기 + ADOPTED · 기안 0건", async () => {
    const h = makeHarness([ev("e1")]);
    h.resolveTarget.mockResolvedValue({
      ok: true,
      draft: { ...CREATE_DRAFT, action: "update_record", args: null, noop: true, targetCampaignId: "c1" },
    });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, adoptedNoop: 1 });
    expect(h.proposals.size).toBe(0);
    expect(h.adoptIntoLedger).toHaveBeenCalledWith({
      campaignId: "c1",
      kind: "campaign",
      eventId: "e1",
      calendarId: "primary",
    });
    expect(h.rows.get("e1")).toMatchObject({
      status: "ADOPTED",
      campaignId: "c1",
      skipReason: null,
      fingerprint: calendarInboundFingerprint(ev("e1")),
    });
  });

  it("noop 넘겨받기 판정은 승인 경로와 같은 표로 사유를 남긴다 · adopt:false 면 장부를 건드리지 않는다", async () => {
    const h = makeHarness([ev("e1"), ev("e2"), ev("e3")]);
    h.resolveTarget.mockImplementation(async (_intent, event) => ({
      ok: true,
      draft: {
        ...CREATE_DRAFT,
        action: "update_record",
        args: null,
        noop: true,
        targetCampaignId: `c-${event.id}`,
        adopt: event.id !== "e3",
      },
    }));
    h.adoptIntoLedger.mockImplementation(async (input) => {
      if (input.eventId === "e2") throw new Error("DB 끊김");
      return "not_found";
    });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ adoptedNoop: 3, errors: 0 });
    expect(h.adoptIntoLedger).toHaveBeenCalledTimes(2);
    expect(h.rows.get("e1")).toMatchObject({ status: "ADOPTED", skipReason: "campaign_not_found" });
    expect(h.rows.get("e2")).toMatchObject({ status: "ADOPTED", skipReason: "adopt_failed" });
    expect(h.rows.get("e3")).toMatchObject({ status: "ADOPTED", skipReason: null, campaignId: "c-e3" });
  });

  it("crmSigned·장부 참조 이벤트는 crmOwned 로 세고 아무것도 쓰지 않는다", async () => {
    const h = makeHarness([ev("e1", { crmSigned: true }), ev("e2")], ["e2"]);

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ scanned: 2, crmOwned: 2, newOrChanged: 0, proposed: 0 });
    expect(h.rows.size).toBe(0);
    expect(h.resolveTarget).not.toHaveBeenCalled();
  });

  it("PENDING_RETRY 행은 같은 지문이어도 다시 기안하고 proposalId 를 새 기안으로 바꾼다", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.proposals.get("prop-1")!.status = "FAILED";
    // 같은 지문을 그대로 둔다 — 상태만으로 재판정해야 한다.
    h.rows.get("e1")!.status = "PENDING_RETRY";

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 1, newOrChanged: 1 });
    expect(h.rows.get("e1")).toMatchObject({ status: "PROPOSED", proposalId: "prop-2" });
  });

  it("상한을 넘는 건은 손대지 않고 dropped 로 센다(다음 회차가 집는다)", async () => {
    const h = makeHarness([ev("e1"), ev("e2"), ev("e3")]);

    const summary = await runCalendarInboundScan({ now: NOW, maxProposals: 2, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 2, dropped: 1, newOrChanged: 3 });
    expect(h.rows.has("e3")).toBe(false);

    const next = await runCalendarInboundScan({ now: NOW, maxProposals: 2, deps: h.deps });
    expect(next).toMatchObject({ proposed: 1, dropped: 0, alreadyHandled: 2 });
  });

  it("상한 기본값은 20", () => {
    expect(MAX_PROPOSALS_PER_RUN).toBe(20);
  });

  it("한 건의 예외는 그 건만 errors 로 세고 나머지를 계속한다", async () => {
    const h = makeHarness([ev("e1"), ev("e2")]);
    h.resolveTarget.mockImplementation(async (_intent, event) => {
      if (event.id === "e1") throw new Error("읽기 실패");
      return { ok: true, draft: CREATE_DRAFT };
    });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ ok: true, errors: 1, proposed: 1 });
    expect(h.rows.has("e1")).toBe(false);
    expect(h.rows.get("e2")).toMatchObject({ status: "PROPOSED" });
    expect(console.error).toHaveBeenCalled();
  });

  it("기안 생성이 실패하면 행은 재판정 대기로 남는다(다음 회차가 다시 기안)", async () => {
    const h = makeHarness([ev("e1")]);
    h.deps.createProposal = async () => {
      throw new Error("쓰기 실패");
    };

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ errors: 1, proposed: 0 });
    expect(h.rows.get("e1")).toMatchObject({ status: "PENDING_RETRY", fingerprint: "" });
  });

  it("후보 조회가 실패하면 던지지 않고 ok:false · 미연결은 skipped", async () => {
    const h = makeHarness([]);
    h.listing.value = { ok: false, error: "이벤트 조회 실패: 500", events: [], referencedIds: new Set() };
    expect(await runCalendarInboundScan({ now: NOW, deps: h.deps })).toMatchObject({
      ok: false,
      error: "이벤트 조회 실패: 500",
      scanned: 0,
    });

    h.listing.value = { ok: false, skipped: "not_connected", events: [], referencedIds: new Set() };
    expect(await runCalendarInboundScan({ now: NOW, deps: h.deps })).toMatchObject({
      ok: false,
      skipped: "not_connected",
    });

    h.listCandidates.mockRejectedValueOnce(new Error("토큰 갱신 실패"));
    expect(await runCalendarInboundScan({ now: NOW, deps: h.deps })).toMatchObject({
      ok: false,
      error: "토큰 갱신 실패",
    });
  });
});
