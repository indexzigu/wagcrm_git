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
  LOCAL_MIN_REMAINING_MS,
  LOCAL_TIMEOUT_MARGIN_MS,
  SCAN_BUDGET_MS,
  MAX_PROPOSALS_PER_RUN,
  calendarInboundFingerprint,
  calendarInboundWindow,
  runCalendarInboundScan,
  type CalendarInboundScanDeps,
  type InboundRow,
  type InboundRowWrite,
} from "./scan";
import { MAX_GEMINI_BATCH, type TitleHintsBatchResult, type TitleHintsResult } from "./llm-hints";
import { LOCAL_HINT_TIMEOUT_MS } from "./local-hints";
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
  const extractHintsLocal = vi.fn(
    async (_summary: string, _opts: { timeoutMs: number }): Promise<TitleHintsResult> => ({ kind: "none" }),
  );
  // 기본: 일괄 응답이 전부 none(실제 함수처럼 입력 id 를 빠짐없이 채운다).
  const extractHintsBatch = vi.fn(
    async (items: ReadonlyArray<{ id: string; summary: string }>): Promise<TitleHintsBatchResult> => ({
      kind: "ok",
      results: new Map(items.map((it) => [it.id, { kind: "none" } as TitleHintsResult])),
    }),
  );
  const listCandidates = vi.fn(async () => listing.value);

  const deps: CalendarInboundScanDeps = {
    listCandidates,
    loadDictionary: async () => DICT,
    extractHintsLocal,
    extractHintsBatch,
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
  /** 일괄에 담긴 제목들(호출마다). */
  const batchSummaries = () => extractHintsBatch.mock.calls.map(([items]) => items.map((it) => it.summary));
  return {
    deps,
    rows,
    proposals,
    listing,
    resolveTarget,
    extractHintsLocal,
    extractHintsBatch,
    batchSummaries,
    listCandidates,
    claimByApproval,
  };
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
      awaitingHint: 0,
      localResolved: 0,
      geminiResolved: 0,
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

  it("규칙 실패 → 로컬 1회 → 못 풀면 해석 대기(gemini) → 다음 회차 일괄 → none 이면 SKIPPED · 같은 지문은 다시 해석하지 않는다", async () => {
    const h = makeHarness([ev("e1", { summary: "치과 예약" })]);

    const first = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(first).toMatchObject({ proposed: 0, skippedUnparsed: 0, awaitingHint: 1, newOrChanged: 1 });
    expect(h.extractHintsLocal).toHaveBeenCalledTimes(1);
    expect(h.extractHintsLocal.mock.calls[0][0]).toBe("치과 예약");
    expect(h.extractHintsBatch).not.toHaveBeenCalled();
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", skipReason: null, parsed: { hintStage: "gemini" } });
    expect(h.proposals.size).toBe(0);

    const second = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(second).toMatchObject({ skippedUnparsed: 1, awaitingHint: 0, newOrChanged: 1 });
    expect(h.extractHintsLocal).toHaveBeenCalledTimes(1); // Gemini 단계 행은 로컬에 다시 보내지 않는다
    expect(h.batchSummaries()).toEqual([["치과 예약"]]);
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller", parsed: null });

    const third = await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(third).toMatchObject({ newOrChanged: 0, alreadyHandled: 1 });
    expect(h.extractHintsLocal).toHaveBeenCalledTimes(1);
    expect(h.extractHintsBatch).toHaveBeenCalledTimes(1);
  });

  it("규칙 파서가 맞히면 모델을 부르지 않는다 · 실패분은 로컬 힌트로 같은 회차에 기안한다(matchedBy llm)", async () => {
    const h = makeHarness([ev("e1"), ev("e2", { summary: "ㅅㅍ 테스트브랜드" })]);
    h.extractHintsLocal.mockResolvedValue({
      kind: "hints",
      hints: { sellerHint: "샘플셀러", brandHint: null, round: null, kind: null },
    });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 2, skippedUnparsed: 0, localResolved: 1, geminiResolved: 0, awaitingHint: 0 });
    expect(h.extractHintsLocal).toHaveBeenCalledTimes(1);
    expect(h.extractHintsLocal.mock.calls[0][0]).toBe("ㅅㅍ 테스트브랜드");
    expect(h.extractHintsBatch).not.toHaveBeenCalled();
    expect(h.rows.get("e2")).toMatchObject({ status: "PROPOSED", proposalId: "prop-2" });
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

  it("재시도 승인이 이미 행을 잡은(기안 APPROVED·EXECUTED) 재판정 대기 행은 다음 스캔이 다시 판정하지 않는다", async () => {
    for (const status of ["APPROVED", "EXECUTED"]) {
      const h = makeHarness([ev("e1")]);
      await runCalendarInboundScan({ now: NOW, deps: h.deps });
      // 승인 실행 실패 → 재판정 대기 → 오너가 재시도 승인(행 잡기 성공, 상태는 그대로 PENDING_RETRY).
      h.rows.get("e1")!.status = "PENDING_RETRY";
      h.claimByApproval("e1");
      h.proposals.get("prop-1")!.status = status;

      const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

      expect(summary).toMatchObject({ proposed: 0, newOrChanged: 0, alreadyHandled: 1 });
      expect(h.proposals.size).toBe(1);
      expect(h.resolveTarget).toHaveBeenCalledTimes(1);
      expect(h.rows.get("e1")).toMatchObject({ status: "PENDING_RETRY", proposalId: "prop-1" });
    }
  });

  it("재판정 대기 행의 기안이 FAILED·REJECTED·없음이면 다시 판정한다", async () => {
    for (const status of ["FAILED", "REJECTED", null]) {
      const h = makeHarness([ev("e1")]);
      await runCalendarInboundScan({ now: NOW, deps: h.deps });
      h.rows.get("e1")!.status = "PENDING_RETRY";
      if (status === null) h.proposals.delete("prop-1");
      else h.proposals.get("prop-1")!.status = status;

      const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

      expect(summary).toMatchObject({ proposed: 1, newOrChanged: 1 });
      expect(h.rows.get("e1")).toMatchObject({ status: "PROPOSED", proposalId: "prop-2" });
    }
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

  it("PENDING_RETRY 행이 파서 실패로 해석 대기·SKIPPED 가 돼도 proposalId 를 비운다", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.rows.get("e1")!.status = "PENDING_RETRY";
    h.listing.value = { ok: true, events: [ev("e1", { summary: "치과 예약" })], referencedIds: new Set() };

    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    // 해석 대기로 적는 순간 옛 FAILED 카드와 끊는다 — 그 카드를 재시도하면 최신 판정을 무시하고 실행된다.
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", proposalId: null });

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
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", proposalId: "prop-1" });
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

  it("상한 기본값은 기안 20 · Gemini 일괄 30 · 로컬 호출은 남은 예산 8초부터(시간 제한은 남은 예산 - 3초, 최대 30초)", () => {
    expect(MAX_PROPOSALS_PER_RUN).toBe(20);
    expect(MAX_GEMINI_BATCH).toBe(30);
    expect(LOCAL_MIN_REMAINING_MS).toBe(8_000);
    expect(LOCAL_TIMEOUT_MARGIN_MS).toBe(3_000);
    expect(LOCAL_HINT_TIMEOUT_MS).toBe(30_000);
  });

  it("Gemini 일괄이 none 이면 그 제목은 SKIPPED 로 닫는다(마지막 단계)", async () => {
    const h = makeHarness([ev("e1", { summary: "치과 예약" })]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ awaitingHint: 0, skippedUnparsed: 1 });
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller" });
  });

  it("예산이 모자라 로컬을 못 불러도 규칙 파서로 맞는 건은 계속 기안한다 · 못 부른 것은 해석 대기(local)", async () => {
    const h = makeHarness([ev("e1", { summary: "치과 예약" }), ev("e2")]);

    const summary = await runCalendarInboundScan({ now: NOW, budgetMs: LOCAL_MIN_REMAINING_MS - 1, deps: h.deps });

    expect(h.extractHintsLocal).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ proposed: 1, awaitingHint: 1, skippedUnparsed: 0, dropped: 0 });
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "local" } });
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

describe("runCalendarInboundScan — 해석 단계(규칙 → 로컬 → Gemini 일괄)", () => {
  const unparsed = (id: string) => ev(id, { summary: `치과 예약 ${id}` });

  /** 가짜 시계 — 로컬 모델의 느린 응답을 흉내 낸다. */
  function fakeClock() {
    const state = { t: 1_000_000 };
    return { state, clock: () => state.t };
  }

  it("Gemini 는 회차당 최대 1번 · 한 번에 30개 · 오래 기다린 것부터 · 넘친 것은 다음 회차", async () => {
    const events = Array.from({ length: MAX_GEMINI_BATCH + 1 }, (_, i) => unparsed(`e${i}`));
    const h = makeHarness(events);
    h.extractHintsLocal.mockResolvedValue({ kind: "none" });
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(h.extractHintsBatch).not.toHaveBeenCalled(); // 로컬이 못 푼 것은 이번 회차가 아니라 다음 회차 일괄로
    expect([...h.rows.values()].every((r) => r.status === "AWAITING_HINT")).toBe(true);
    // e30 이 가장 오래 기다렸다 — 후보 순서로는 마지막이지만 먼저 담겨야 한다.
    h.rows.get("e30")!.lastSeenAt = new Date(NOW.getTime() - 60 * 60_000);

    const second = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(h.extractHintsBatch).toHaveBeenCalledTimes(1);
    const sent = h.batchSummaries()[0];
    expect(sent).toHaveLength(MAX_GEMINI_BATCH);
    expect(sent).toContain("치과 예약 e30");
    expect(sent).not.toContain("치과 예약 e29");
    expect(second).toMatchObject({ skippedUnparsed: MAX_GEMINI_BATCH, awaitingHint: 1, dropped: 0 });
    expect(h.rows.get("e29")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
    // 일괄 id 는 순번이다 — 구글 이벤트 id 를 바깥 모델에 보내지 않는다.
    expect(h.extractHintsBatch.mock.calls[0][0].map((it) => it.id)).toEqual(
      Array.from({ length: MAX_GEMINI_BATCH }, (_, i) => String(i)),
    );
    // Gemini 단계 행은 로컬에 다시 보내지 않는다.
    expect(h.extractHintsLocal).toHaveBeenCalledTimes(MAX_GEMINI_BATCH + 1);

    const third = await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(h.extractHintsBatch).toHaveBeenCalledTimes(2);
    expect(h.batchSummaries()[1]).toEqual(["치과 예약 e29"]);
    expect(third).toMatchObject({ skippedUnparsed: 1, awaitingHint: 0 });
    expect(h.extractHintsLocal).toHaveBeenCalledTimes(MAX_GEMINI_BATCH + 1);
  });

  it("Gemini 힌트로 풀리면 같은 회차에 기안한다 · 힌트로도 유일하게 안 맞으면 그 사유로 SKIPPED", async () => {
    const h = makeHarness([ev("e1", { summary: "ㅅㅍ 테스트브랜드" }), unparsed("e2")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.extractHintsBatch.mockImplementationOnce(async (items) => ({
      kind: "ok",
      results: new Map<string, TitleHintsResult>([
        [items[0].id, { kind: "hints", hints: { sellerHint: "샘플셀러", brandHint: null, round: null, kind: null } }],
        // 사전에 없는 이름 — 힌트가 있어도 대상이 정해지지 않는다.
        [items[1].id, { kind: "hints", hints: { sellerHint: "치과", brandHint: null, round: null, kind: null } }],
      ]),
    }));

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 1, geminiResolved: 1, localResolved: 0, skippedUnparsed: 1, awaitingHint: 0 });
    expect(h.rows.get("e1")).toMatchObject({ status: "PROPOSED", proposalId: "prop-1" });
    expect(h.rows.get("e1")!.parsed).toMatchObject({ sellerId: "s1", matchedBy: "llm" });
    expect(h.rows.get("e2")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller" });
  });

  it("일괄 응답에 빠진 항목은 none(SKIPPED), 모르는 id 는 무시한다", async () => {
    const h = makeHarness([unparsed("e1"), ev("e2", { summary: "ㅅㅍ 테스트브랜드" })]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.extractHintsBatch.mockImplementationOnce(async () => ({
      kind: "ok",
      results: new Map<string, TitleHintsResult>([
        ["1", { kind: "hints", hints: { sellerHint: "샘플셀러", brandHint: null, round: null, kind: null } }],
        ["99", { kind: "hints", hints: { sellerHint: "샘플셀러", brandHint: null, round: null, kind: null } }],
      ]),
    }));

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ proposed: 1, skippedUnparsed: 1, errors: 0 });
    expect(h.rows.get("e1")).toMatchObject({ status: "SKIPPED", skipReason: "no_seller" });
    expect(h.rows.get("e2")).toMatchObject({ status: "PROPOSED" });
  });

  it("Gemini 일시 장애면 해석 대기(gemini)로 두고 다음 회차에 다시 일괄로 묻는다(로컬은 다시 안 부른다)", async () => {
    const h = makeHarness([unparsed("e1"), unparsed("e2")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.extractHintsBatch.mockResolvedValueOnce({ kind: "unavailable" });
    const later = new Date(NOW.getTime() + 30 * 60_000);

    const second = await runCalendarInboundScan({ now: later, deps: h.deps });

    expect(second).toMatchObject({ awaitingHint: 2, skippedUnparsed: 0, errors: 0 });
    for (const id of ["e1", "e2"]) {
      expect(h.rows.get(id)).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" }, lastSeenAt: later });
    }

    const third = await runCalendarInboundScan({ now: later, deps: h.deps });
    expect(h.extractHintsBatch).toHaveBeenCalledTimes(2);
    expect(third).toMatchObject({ skippedUnparsed: 2, awaitingHint: 0 });
    expect(h.extractHintsLocal).toHaveBeenCalledTimes(2);
  });

  it("일괄 호출이 예외로 끝나도 회차는 계속되고 행은 해석 대기로 남는다", async () => {
    const h = makeHarness([unparsed("e1"), ev("e2")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.listing.value = { ok: true, events: [unparsed("e1"), ev("e2"), ev("e3")], referencedIds: new Set() };
    h.extractHintsBatch.mockRejectedValueOnce(new Error("boom"));

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ errors: 1, awaitingHint: 1, proposed: 1 });
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
  });

  it("로컬 서버가 꺼져 있으면(연결 거부) 한 번만 부르고 나머지는 바로 Gemini 단계로 · 예산을 넘기지 않는다", async () => {
    const h = makeHarness([unparsed("e1"), unparsed("e2"), unparsed("e3"), ev("e4")]);
    h.extractHintsLocal.mockResolvedValue({ kind: "unavailable" });
    const { clock, state } = fakeClock();
    const start = state.t;

    const summary = await runCalendarInboundScan({ now: NOW, clock, deps: h.deps });

    expect(h.extractHintsLocal).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ awaitingHint: 3, proposed: 1, dropped: 0, localResolved: 0 });
    for (const id of ["e1", "e2", "e3"]) {
      expect(h.rows.get(id)).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
    }
    expect(state.t - start).toBeLessThanOrEqual(SCAN_BUDGET_MS);
  });

  it("로컬이 느리면 남은 예산으로 시간 제한을 줄이고, 8초 미만이면 부르지 않고 해석 대기(local) → 다음 회차가 로컬부터 잇는다", async () => {
    const h = makeHarness([unparsed("e1"), unparsed("e2"), unparsed("e3")]);
    const { clock, state } = fakeClock();
    const start = state.t;
    // 응답이 시간 제한까지 걸리고 none(서버는 살아 있다).
    h.extractHintsLocal.mockImplementation(async (_summary, { timeoutMs }) => {
      state.t += timeoutMs;
      return { kind: "none" };
    });

    const first = await runCalendarInboundScan({ now: NOW, clock, deps: h.deps });

    expect(h.extractHintsLocal.mock.calls.map(([, o]) => o.timeoutMs)).toEqual([
      LOCAL_HINT_TIMEOUT_MS,
      SCAN_BUDGET_MS - LOCAL_HINT_TIMEOUT_MS - LOCAL_TIMEOUT_MARGIN_MS,
    ]);
    expect(state.t - start).toBeLessThanOrEqual(SCAN_BUDGET_MS);
    expect(first).toMatchObject({ awaitingHint: 3, dropped: 0 });
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
    expect(h.rows.get("e2")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
    expect(h.rows.get("e3")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "local" } });

    // 다음 회차: e3 만 로컬로(건너뛰지도 겹치지도 않는다), e1·e2 는 Gemini 일괄로.
    h.extractHintsLocal.mockClear();
    h.extractHintsLocal.mockResolvedValue({ kind: "none" });
    const second = await runCalendarInboundScan({ now: NOW, clock: fakeClock().clock, deps: h.deps });

    expect(h.extractHintsLocal.mock.calls.map(([s]) => s)).toEqual(["치과 예약 e3"]);
    expect(h.batchSummaries()).toEqual([["치과 예약 e1", "치과 예약 e2"]]);
    expect(second).toMatchObject({ skippedUnparsed: 2, awaitingHint: 1 });
    expect(h.rows.get("e3")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
  });

  it("로컬이 제목에 맞지 않는 이름을 주면(사전에 없음) 버리고 Gemini 단계로 넘긴다", async () => {
    const h = makeHarness([ev("e1", { summary: "ㅅㅍ 테스트브랜드" })]);
    h.extractHintsLocal.mockResolvedValue({
      kind: "hints",
      hints: { sellerHint: "다른셀러", brandHint: null, round: null, kind: null },
    });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ localResolved: 0, proposed: 0, awaitingHint: 1 });
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
  });

  it("지문이 바뀐 해석 대기 행은 규칙부터 다시 본다(Gemini 단계여도)", async () => {
    const h = makeHarness([ev("e1", { summary: "ㅅㅍ 테스트브랜드" }), unparsed("e2")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
    expect(h.rows.get("e2")).toMatchObject({ status: "AWAITING_HINT", parsed: { hintStage: "gemini" } });
    h.listing.value = {
      ok: true,
      // e1: 규칙으로 풀리게 고쳤다 · e2: 다른 제목이지만 여전히 못 푼다 → 로컬부터 다시.
      events: [ev("e1", { summary: "샘플셀러 테스트브랜드 3차" }), ev("e2", { summary: "치과 예약 오후" })],
      referencedIds: new Set(),
    };
    h.extractHintsLocal.mockClear();

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(h.extractHintsBatch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ proposed: 1, awaitingHint: 1 });
    expect(h.rows.get("e1")).toMatchObject({ status: "PROPOSED", fingerprint: calendarInboundFingerprint(ev("e1", { summary: "샘플셀러 테스트브랜드 3차" })) });
    expect(h.extractHintsLocal.mock.calls.map(([s]) => s)).toEqual(["치과 예약 오후"]);
    expect(h.rows.get("e2")).toMatchObject({
      status: "AWAITING_HINT",
      fingerprint: calendarInboundFingerprint(ev("e2", { summary: "치과 예약 오후" })),
    });
  });

  it("해석 대기 행은 「이미 처리」로 묻히지 않는다 — 같은 지문이어도 매 회차 해석 대상이다", async () => {
    const h = makeHarness([unparsed("e1")]);
    h.extractHintsBatch.mockResolvedValue({ kind: "unavailable" });
    await runCalendarInboundScan({ now: NOW, deps: h.deps });

    for (let i = 0; i < 2; i++) {
      const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });
      expect(summary).toMatchObject({ newOrChanged: 1, alreadyHandled: 0, awaitingHint: 1 });
    }
    expect(h.extractHintsBatch).toHaveBeenCalledTimes(2);
  });

  it("해석 대기로 적기 직전에 다른 쓰기가 행을 바꿨으면(updatedAt) 덮지 않고 손뗀다", async () => {
    const h = makeHarness([ev("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    h.proposals.get("prop-1")!.status = "FAILED";
    h.rows.get("e1")!.status = "PENDING_RETRY";
    h.listing.value = { ok: true, events: [unparsed("e1")], referencedIds: new Set() };
    // 로컬 호출 중에 오너가 옛 FAILED 카드를 재시도 승인해 행을 잡는다.
    h.extractHintsLocal.mockImplementationOnce(async () => {
      h.claimByApproval("e1");
      return { kind: "none" };
    });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ alreadyHandled: 1, awaitingHint: 0, errors: 0 });
    expect(h.rows.get("e1")).toMatchObject({ status: "PENDING_RETRY", proposalId: "prop-1" });
  });

  it("Gemini 결과를 적기 직전에 다른 쓰기가 행을 바꿨으면 덮지 않고 손뗀다", async () => {
    const h = makeHarness([unparsed("e1")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    const before = { ...h.rows.get("e1")! };
    h.extractHintsBatch.mockImplementationOnce(async (items) => {
      h.claimByApproval("e1");
      return { kind: "ok", results: new Map(items.map((it) => [it.id, { kind: "none" } as TitleHintsResult])) };
    });

    const summary = await runCalendarInboundScan({ now: NOW, deps: h.deps });

    expect(summary).toMatchObject({ alreadyHandled: 1, skippedUnparsed: 0 });
    expect(h.rows.get("e1")).toMatchObject({ status: "AWAITING_HINT", parsed: before.parsed });
  });

  it("해석 대기 행에는 기안이 없다 — 결재함에 아무것도 올라가지 않는다", async () => {
    const h = makeHarness([unparsed("e1"), unparsed("e2")]);
    await runCalendarInboundScan({ now: NOW, deps: h.deps });
    expect(h.proposals.size).toBe(0);
    for (const id of ["e1", "e2"]) expect(h.rows.get(id)!.proposalId).toBeNull();
  });
});
