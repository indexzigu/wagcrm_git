import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateEvent, CandidateListResult } from "@/lib/google-calendar-sync";

// 스캔은 장부에 원본을 넘겨받지 않는다(승인 없이 오너 일정을 CRM 이 갖게 된다) — 진짜 함수를 감시한다.
const adoptCalendarEventIntoLedgerSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-calendar-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google-calendar-sync")>()),
  adoptCalendarEventIntoLedger: adoptCalendarEventIntoLedgerSpy,
}));

import { getRequestTypeForAction } from "@/lib/agent/approval-policy";
import { CALENDAR_INBOUND_CREATED_BY, calendarInboundRefSchema } from "./adopt";
import type { ProposalDraft, ResolveResult } from "./resolve-target";
import { LOCK_TX_TIMEOUT_MS } from "./run-lock";
import {
  MAX_HINT_CALLS_PER_RUN,
  SCAN_BUDGET_MS,
  MAX_PROPOSALS_PER_RUN,
  calendarInboundFingerprint,
  calendarInboundWindow,
  runCalendarInboundScan,
  type CalendarInboundScanDeps,
  type InboundRow,
  type InboundRowWrite,
} from "./scan";
import type { TitleHintsResult } from "./llm-hints";
import type { InboundDictionary, ParsedCalendarIntent } from "./types";

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
  title: "새 회차 생성: 샘플셀러 · 테스트브랜드 봄딜 (2026-11-03~2026-11-09)",
  targetCampaignId: null,
  warnings: ["회차 번호는 시작일 순서로 정해져 일정 제목의 3차와 다를 수 있습니다."],
  adopt: true,
  ledgerKind: "campaign",
};

type StoredRow = InboundRow & Omit<InboundRowWrite, "proposalId" | "parsed"> & { parsed: unknown };

function makeHarness(events: CandidateEvent[], referenced: string[] = []) {
  const rows = new Map<string, StoredRow>();
  const proposals = new Map<string, { status: string; data: Record<string, unknown> }>();
  let rowSeq = 0;
  let proposalSeq = 0;
  let clock = 0;
  /** 행 쓰기마다 올라가는 updatedAt(실 DB 의 @updatedAt 흉내). */
  const tick = () => new Date(Date.UTC(2026, 0, 1) + ++clock);
  const listing: { value: CandidateListResult } = {
    value: { ok: true, events, referencedIds: new Set(referenced) },
  };
  const resolveTarget = vi.fn(
    async (_intent: ParsedCalendarIntent, _event: CandidateEvent): Promise<ResolveResult> => ({
      ok: true,
      draft: CREATE_DRAFT,
    }),
  );
  const extractHints = vi.fn(async (_summary: string): Promise<TitleHintsResult> => ({ kind: "none" }));
  const listCandidates = vi.fn(async () => listing.value);

  const deps: CalendarInboundScanDeps = {
    listCandidates,
    loadDictionary: async () => DICT,
    extractHints,
    resolveTarget,
    createProposal: async (data) => {
      const id = `prop-${++proposalSeq}`;
      proposals.set(id, { status: "PENDING_APPROVAL", data: data as unknown as Record<string, unknown> });
      return { id };
    },
    // 사본을 돌려준다 — 분류 시점에 읽은 값이어야 한다(그 뒤 다른 쓰기가 행을 바꿔도 이 값은 그대로).
    findRows: async (ids) => ids.flatMap((id) => (rows.has(id) ? [{ ...rows.get(id)! }] : [])),
    findProposalStatuses: async (ids) =>
      new Map(ids.flatMap((id) => (proposals.has(id) ? [[id, proposals.get(id)!.status] as const] : []))),
    saveRow: async (googleEventId, write, expected) => {
      const existing = rows.get(googleEventId);
      if (expected) {
        // 조건부 갱신 — 읽은 뒤 누가 행을 바꿨으면(updatedAt 다름) 0건.
        if (!existing || existing.id !== expected.id || existing.updatedAt.getTime() !== expected.updatedAt.getTime()) {
          return null;
        }
      }
      const next: StoredRow = {
        ...(existing ?? { id: `in-${++rowSeq}`, googleEventId, proposalId: null, campaignId: null, parsed: null }),
        ...Object.fromEntries(Object.entries(write).filter(([, v]) => v !== undefined)),
        updatedAt: tick(),
      } as StoredRow;
      rows.set(googleEventId, next);
      return { id: next.id, updatedAt: next.updatedAt };
    },
    touchRows: async (ids, lastSeenAt) => {
      for (const row of rows.values()) {
        if (ids.includes(row.id)) {
          row.lastSeenAt = lastSeenAt;
          row.updatedAt = tick();
        }
      }
    },
  };
  /** 승인이 행을 잡았다(claimInboundRowForApproval) — updatedAt 만 오른다. */
  const claimByApproval = (googleEventId: string) => {
    rows.get(googleEventId)!.updatedAt = tick();
  };
  return { deps, rows, proposals, listing, resolveTarget, extractHints, listCandidates, claimByApproval };
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

  it("UTC 15:00 이후(KST 다음날)는 KST 날짜로 창을 잡는다", () => {
    // 2026-10-22T16:30Z = KST 2026-10-23 01:30 → 오늘은 10-23
    expect(calendarInboundWindow(new Date("2026-10-22T16:30:00.000Z"))).toEqual({
      timeMin: "2026-10-08T15:00:00.000Z", // KST 2026-10-09 00:00
      timeMax: "2027-04-21T15:00:00.000Z", // KST 2027-04-22 00:00
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
      hintDeferred: 0,
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
    h.extractHints.mockResolvedValue({
      kind: "hints",
      hints: { sellerHint: "샘플셀러", brandHint: null, round: null, kind: null },
    });

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

  it("noop(CRM 값이 이미 같음) → 기안 없이 ADOPTED + already_current · 장부는 건드리지 않는다", async () => {
    const h = makeHarness([ev("e1"), ev("e2")]);
    h.resolveTarget.mockImplementation(async (_intent, event) => ({
      ok: true,
      draft: {
        ...CREATE_DRAFT,
        action: "update_record",
        args: null,
        noop: true,
        targetCampaignId: `c-${event.id}`,
        adopt: event.id === "e1",
      },
    }));

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, adoptedNoop: 2, errors: 0 });
    expect(h.proposals.size).toBe(0);
    // 넘겨받기는 승인 뒤에만 — 승인 없이 장부에 적으면 다음 동기화가 오너 일정을 고쳐 쓴다.
    expect(adoptCalendarEventIntoLedgerSpy).not.toHaveBeenCalled();
    for (const id of ["e1", "e2"]) {
      expect(h.rows.get(id)).toMatchObject({
        status: "ADOPTED",
        skipReason: "already_current",
        campaignId: `c-${id}`,
        fingerprint: calendarInboundFingerprint(ev(id)),
      });
    }
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

  it("재시도 승인 성공으로 ADOPTED 가 된 행(지문 보존)은 다음 스캔이 손대지 않는다 — 회차가 둘 생기지 않는다", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    const fingerprint = h.rows.get("e1")!.fingerprint;
    // 승인 실행 실패 → 재판정 대기(지문은 그대로) → 다음 스캔 전에 오너가 재시도해 성공 → ADOPTED.
    h.proposals.get("prop-1")!.status = "EXECUTED";
    h.rows.get("e1")!.status = "ADOPTED";
    expect(h.rows.get("e1")!.fingerprint).toBe(fingerprint);

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, newOrChanged: 0, alreadyHandled: 1 });
    expect(h.proposals.size).toBe(1);
    expect(h.resolveTarget).toHaveBeenCalledTimes(1);
  });

  it("재판정 중 승인이 행을 먼저 잡으면(updatedAt 바뀜) 기안을 만들지 않고 행도 덮지 않는다", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.proposals.get("prop-1")!.status = "FAILED";
    h.rows.get("e1")!.status = "PENDING_RETRY";
    // 분류 뒤·임시 쓰기 전에 오너가 옛 FAILED 카드를 재시도 승인해 행을 잡는다.
    h.resolveTarget.mockImplementationOnce(async () => {
      h.claimByApproval("e1");
      return { ok: true, draft: CREATE_DRAFT };
    });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, alreadyHandled: 1, errors: 0 });
    expect(h.proposals.size).toBe(1);
    expect(h.rows.get("e1")).toMatchObject({ status: "PENDING_RETRY", proposalId: "prop-1" });
  });

  it("재판정이 SKIPPED·noop 으로 끝나도 그 사이 승인이 행을 잡았으면 덮지 않는다", async () => {
    const results: ResolveResult[] = [
      { ok: false, reason: "no_deal" },
      { ok: true, draft: { ...CREATE_DRAFT, action: "update_record", args: null, noop: true, targetCampaignId: "c1" } },
    ];
    for (const result of results) {
      const h = makeHarness([ev("e1")]);
      await runCalendarInboundScan({ now: NOW, deps: h.deps });
      h.proposals.get("prop-1")!.status = "FAILED";
      h.rows.get("e1")!.status = "PENDING_RETRY";
      h.resolveTarget.mockImplementationOnce(async () => {
        h.claimByApproval("e1");
        return result;
      });

      const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

      expect(summary).toMatchObject({ alreadyHandled: 1, skippedUnparsed: 0, adoptedNoop: 0 });
      expect(h.rows.get("e1")).toMatchObject({ status: "PENDING_RETRY", proposalId: "prop-1" });
    }
  });

  it("PENDING_RETRY 행이 SKIPPED·noop ADOPTED 로 끝나면 proposalId 를 비운다(옛 FAILED 기안 대체)", async () => {
    const h = makeHarness([ev("e1"), ev("e2")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    for (const id of ["e1", "e2"]) h.rows.get(id)!.status = "PENDING_RETRY";
    h.resolveTarget.mockImplementation(async (_intent, event) =>
      event.id === "e1"
        ? { ok: false, reason: "no_deal" }
        : { ok: true, draft: { ...CREATE_DRAFT, action: "update_record", args: null, noop: true, targetCampaignId: "c1" } },
    );

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 0, skippedUnparsed: 1, adoptedNoop: 1 });
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_deal", proposalId: null });
    expect(h.rows.get("e2")).toMatchObject({ status: "ADOPTED", proposalId: null });
  });

  it("PENDING_RETRY 행이 파서 실패로 SKIPPED 여도 proposalId 를 비운다", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.rows.get("e1")!.status = "PENDING_RETRY";
    h.listing.value = { ok: true, events: [ev("e1", { summary: "치과 예약" })], referencedIds: new Set() };

    await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller", proposalId: null });
  });

  it("재판정 대기가 아닌 행은 SKIPPED 로 끝나도 proposalId 기록을 지우지 않는다", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.proposals.get("prop-1")!.status = "REJECTED";
    h.rows.get("e1")!.status = "REJECTED";
    h.listing.value = { ok: true, events: [ev("e1", { summary: "치과 예약" })], referencedIds: new Set() };

    await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", proposalId: "prop-1" });
  });

  it("상한을 넘는 건은 손대지 않고 dropped 로 센다(다음 회차가 집는다)", async () => {
    const h = makeHarness([ev("e1"), ev("e2"), ev("e3")]);

    const summary = await runCalendarInboundScan({ now: NOW, maxProposals: 2, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 2, dropped: 1, newOrChanged: 3 });
    expect(h.rows.has("e3")).toBe(false);

    const next = await runCalendarInboundScan({ now: NOW, maxProposals: 2, deps: h.deps });
    expect(next).toMatchObject({ proposed: 1, dropped: 0, alreadyHandled: 2 });
  });

  it("회차 시간 예산은 60초 이하이고, 잠금 시간 제한은 예산 + 일정 한 건(힌트 20초 + DB)보다 넉넉히 길다", () => {
    // 배포 지침 Plan Limits: Vercel Hobby 가 함수 실행을 60초로 자른다 — 예산 상수를 그 위로 두지 않는다.
    expect(SCAN_BUDGET_MS).toBe(55_000);
    expect(SCAN_BUDGET_MS).toBeLessThanOrEqual(60_000);
    expect(LOCK_TX_TIMEOUT_MS - SCAN_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("상한 기본값은 기안 20 · 힌트 호출 20", () => {
    expect(MAX_PROPOSALS_PER_RUN).toBe(20);
    expect(MAX_HINT_CALLS_PER_RUN).toBe(20);
  });

  it("힌트 예산을 다 쓰면 그 뒤 해석 실패분은 힌트를 부르지 않고 손대지 않는다(hintDeferred)", async () => {
    const h = makeHarness(["e1", "e2", "e3", "e4"].map((id) => ev(id, { summary: `치과 예약 ${id}` })));

    const summary = await runCalendarInboundScan({ now: NOW, maxHintCalls: 2, deps: h.deps });

    expect(h.extractHints).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ skippedUnparsed: 2, hintDeferred: 2, newOrChanged: 4, errors: 0 });
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller" });
    expect(h.rows.get("e2")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller" });
    expect(h.rows.has("e3")).toBe(false);
    expect(h.rows.has("e4")).toBe(false);

    const next = await runCalendarInboundScan({ now: NOW, maxHintCalls: 2, deps: h.deps });
    expect(h.extractHints).toHaveBeenCalledTimes(4);
    expect(next).toMatchObject({ skippedUnparsed: 2, hintDeferred: 0, alreadyHandled: 2 });
    expect(h.rows.get("e4")).toMatchObject({ status: "SKIPPED" });
  });

  it("힌트가 일시 장애(unavailable)면 행을 쓰지 않고 hintDeferred · 시도는 예산을 쓴다 · 다음 회차가 다시 묻는다", async () => {
    const h = makeHarness([ev("e1", { summary: "치과 예약 e1" }), ev("e2", { summary: "치과 예약 e2" })]);
    h.extractHints.mockResolvedValueOnce({ kind: "unavailable" });

    const summary = await runCalendarInboundScan({ now: NOW, maxHintCalls: 1, deps: h.deps });

    // e1: 시도했지만 일시 장애 → 미기록. e2: 예산(1회)을 e1 이 썼다 → 미기록.
    expect(h.extractHints).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ hintDeferred: 2, skippedUnparsed: 0, errors: 0 });
    expect(h.rows.size).toBe(0);

    const next = await runCalendarInboundScan({ now: NOW, maxHintCalls: 5, deps: h.deps });
    expect(h.extractHints).toHaveBeenCalledTimes(3);
    expect(next).toMatchObject({ hintDeferred: 0, skippedUnparsed: 2 });
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller" });
  });

  it("힌트가 none(다시 물어도 같음)이면 SKIPPED 로 닫는다", async () => {
    const h = makeHarness([ev("e1", { summary: "치과 예약" })]);
    h.extractHints.mockResolvedValue({ kind: "none" });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ hintDeferred: 0, skippedUnparsed: 1 });
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller" });
  });

  it("힌트 예산이 바닥나도 규칙 파서로 맞는 건은 계속 기안한다", async () => {
    const h = makeHarness([ev("e1", { summary: "치과 예약" }), ev("e2")]);

    const summary = await runCalendarInboundScan({ now: NOW, maxHintCalls: 0, deps: h.deps });

    expect(h.extractHints).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ proposed: 1, hintDeferred: 1, skippedUnparsed: 0 });
    expect(h.rows.has("e1")).toBe(false);
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
    expect(h.rows.get("e1")).toMatchObject({
      status: "PENDING_RETRY",
      fingerprint: calendarInboundFingerprint(ev("e1")),
      proposalId: null,
    });
  });

  it("재판정 대기 행에서 기안 생성이 실패해도 옛 FAILED 기안과의 연결은 끊긴다(옛 카드 재시도는 SUPERSEDED)", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.proposals.get("prop-1")!.status = "FAILED";
    h.rows.get("e1")!.status = "PENDING_RETRY";
    h.deps.createProposal = async () => {
      throw new Error("쓰기 실패");
    };

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ errors: 1, proposed: 0 });
    // proposalId 가 null 이면 승인 단계(`approveProposal`)가 옛 카드를 SUPERSEDED 로 거절한다
    // (approve-proposal.test 「수집 행의 proposalId 가 비었으면 … SUPERSEDED」).
    expect(h.rows.get("e1")).toMatchObject({
      status: "PENDING_RETRY",
      proposalId: null,
      fingerprint: calendarInboundFingerprint(ev("e1")),
    });
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

describe("runCalendarInboundScan — 단일 실행 잠금", () => {
  it("겹친 두 회차: 뒤 회차는 아무것도 건드리지 않고 busy, 기안은 1건", async () => {
    const h = makeHarness([ev("e1")]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstList = h.listing.value;
    h.listCandidates.mockImplementationOnce(async () => {
      await gate;
      return firstList;
    });

    const first = runCalendarInboundScan({ now: NOW, deps: h.deps });
    const second = await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(second).toMatchObject({ ok: true, skipped: "busy", scanned: 0, proposed: 0 });
    // 뒤 회차는 후보 조회조차 하지 않았다(Gemini·DB 호출 없음)
    expect(h.listCandidates).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toMatchObject({ ok: true, proposed: 1 });
    expect(h.proposals.size).toBe(1);

    // 잠금은 회차가 끝나면 풀린다 — 다음 회차는 정상으로 돈다(같은 일정은 이미 처리)
    const third = await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(third.skipped).toBeUndefined();
    expect(third).toMatchObject({ proposed: 0, alreadyHandled: 1 });
  });

  it("앞 회차가 예외로 끝나도 잠금이 풀린다", async () => {
    const h = makeHarness([ev("e1")]);
    h.listCandidates.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    expect(await runCalendarInboundScan({ now: NOW, deps: h.deps })).toMatchObject({ ok: false });
    expect((await runCalendarInboundScan({ now: NOW, deps: h.deps })).skipped).toBeUndefined();
  });

  it("회차 예산을 넘기면 남은 일정은 손대지 않고 다음 회차로 넘긴다(dropped)", async () => {
    const h = makeHarness([ev("e1"), ev("e2", { summary: "샘플셀러 테스트브랜드 3차" })]);
    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps, budgetMs: -1 });
    expect(summary).toMatchObject({ newOrChanged: 2, proposed: 0, dropped: 2 });
    expect(h.rows.size).toBe(0);
  });
});
