// [캘린더수집] 수집 스캔 오케스트레이션 — 구글 캘린더 종일 일정 → 해석 → 승인 대기 기안.
// 설계 정본: docs/private/specs/2026-10-21-calendar-inbound-sync-design.md §4·§5·§8-b.
//
// 한 회차 흐름(이벤트마다 순서대로, 한 건의 예외는 그 건만 `errors` 로 세고 계속한다):
//   창 계산(KST 오늘-14일 ~ 오늘+180일) → 후보 조회 → CRM 소유(장부 참조 id · `crmSigned`) 제외 →
//   수집 행(CalendarInboundEvent)과 대조 → 처음 보거나 지문이 바뀐 것·재판정 대기만 해석 →
//   규칙 파서(실패 시 LLM 힌트 1회 → 재파서) → 대상 결정 → noop 이면 바로 넘겨받기(ADOPTED) ·
//   아니면 기안(PENDING_APPROVAL) + 행 PROPOSED.
//
// ⛔ 이 스캔은 `syncCampaignToCalendar` 를 부르지 않는다 — noop 넘겨받기도 장부에 적기만 하고, 다음
//    정상 동기화(캠페인 수정 훅·전체 동기화)가 그 원본을 CRM 형식으로 갱신한다. 스캔이 캘린더에 쓰기
//    시작하면 「읽기 → 쓰기 → 다음 스캔이 자기 쓰기를 읽음」 고리가 생긴다.
// ⛔ 승인은 언제나 사람 — 기안의 requestType 은 액션이 정한다(`getRequestTypeForAction`, alwaysManual).
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getRequestTypeForAction } from "@/lib/agent/approval-policy";
import { toKstYmd } from "@/lib/date-utils";
import {
  adoptCalendarEventIntoLedger,
  listAllDayCandidateEvents,
  type CandidateEvent,
  type CandidateListResult,
} from "@/lib/google-calendar-sync";
import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import { CALENDAR_INBOUND_CREATED_BY, calendarInboundRefSchema, type CalendarInboundRef } from "./adopt";
import { loadInboundDictionary } from "./dictionary";
import { extractTitleHints } from "./llm-hints";
import { parseCalendarTitle } from "./parse-title";
import { resolveInboundTarget, type ProposalDraft, type ResolveResult } from "./resolve-target";
import { INBOUND_SKIP_ADOPT_FAILED, INBOUND_STATUS, inboundSkipReasonForAdoptOutcome } from "./status";
import type { InboundDictionary, ParsedCalendarIntent, TitleHints } from "./types";

/**
 * 한 회차 기안 상한. 평시엔 하루 몇 건이라 걸리지 않는다 — 데이터 결함(대량 붙여넣기 등)이 결재함
 * 폭주로 번지는 것을 막는 안전판이다. 넘친 건은 **쓰지 않고**(SKIPPED 로도 적지 않는다) 다음 회차에
 * 넘기며, 그 수를 `dropped` 로 남긴다 — 조용한 절단은 「전부 처리했다」로 읽힌다.
 */
export const MAX_PROPOSALS_PER_RUN = 20;

/**
 * 한 회차 LLM 힌트 호출 상한. 기안 상한은 기안 수만 세므로 해석 못 하는 일정(개인 일정 등)이 쌓이면
 * 힌트 호출이 무한정 는다 — 이 예산으로 따로 묶는다. 예산이 바닥난 뒤 규칙 파서가 실패한 건은
 * **쓰지 않고** 다음 회차로 넘기며 `hintDeferred` 로 센다(SKIPPED 로 적으면 힌트 없이 영영 닫힌다).
 */
export const MAX_HINT_CALLS_PER_RUN = 20;

/** 스캔 창 — KST 오늘 기준 과거 14일 ~ 미래 180일(끝날 포함). */
const WINDOW_DAYS_BACK = 14;
const WINDOW_DAYS_FORWARD = 180;

/** 열린 기안이 있어 다시 기안하지 않았다(옛 기안이 결정될 때까지). */
export const INBOUND_SKIP_OPEN_PROPOSAL = "open_proposal";
const SKIP_REASON_MAX = 500;

/** 아직 결정되지 않은 기안 상태 — 이 기안이 살아 있는 동안은 같은 일정을 다시 기안하지 않는다. */
const OPEN_PROPOSAL_STATUSES = new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED", "FAILED"]);
/** 닫힌 기안 — 사후 표기(ADOPTED/REJECTED)가 조용히 실패한 행이다. 다시 기안하면 같은 일정이 두 번 반영된다. */
const CLOSED_PROPOSAL_STATUSES = new Set(["EXECUTED", "REJECTED"]);

export type ScanSummary = {
  ok: boolean;
  skipped?: "not_connected";
  /** 후보로 읽은 종일·비반복 이벤트 수(CRM 소유 포함). */
  scanned: number;
  /** 장부가 참조하거나 CRM 표식이 있어 제외한 수. */
  crmOwned: number;
  /** 해석 대상(처음 봄·지문 바뀜·재판정 대기) — 상한에 걸린 건도 포함. */
  newOrChanged: number;
  proposed: number;
  /** 해석 실패·대상 없음으로 SKIPPED 적은 수. */
  skippedUnparsed: number;
  /** 바꿀 칸이 없어 기안 없이 처리 끝(ADOPTED)으로 적은 수. */
  adoptedNoop: number;
  /** 상한에 걸려 이번 회차에 손대지 않은 수. */
  dropped: number;
  /** 힌트 예산이 바닥나 이번 회차에 손대지 않은 해석 실패 수(다음 회차가 집는다). */
  hintDeferred: number;
  /** 같은 지문·결정 대기 중인 기안·닫힌 기안 등 이미 처리된 수. */
  alreadyHandled: number;
  /** 한 건 처리 중 예외가 난 수(그 건만 건너뛰었다 — 로그 확인). */
  errors: number;
  error?: string;
};

/** 대조에 쓰는 수집 행 모양. */
export type InboundRow = {
  id: string;
  googleEventId: string;
  fingerprint: string;
  status: string;
  skipReason: string | null;
  proposalId: string | null;
};

/** 수집 행 쓰기. `undefined` 칸은 그대로 둔다(proposalId·campaignId 를 지우지 않으려고). */
export type InboundRowWrite = {
  calendarId: string;
  summary: string;
  startDate: string;
  endDate: string;
  fingerprint: string;
  status: string;
  skipReason: string | null;
  parsed?: ParsedCalendarIntent | null;
  /** null = 옛 기안과의 연결을 끊는다(그 기안은 승인 단계에서 SUPERSEDED). */
  proposalId?: string | null;
  campaignId?: string | null;
  lastSeenAt: Date;
};

/** 바깥 세계(캘린더·DB·LLM)는 전부 주입 — 테스트는 DB·네트워크 없이 돈다. */
export type CalendarInboundScanDeps = {
  listCandidates: (range: { timeMin: string; timeMax: string }) => Promise<CandidateListResult>;
  loadDictionary: () => Promise<InboundDictionary>;
  extractHints: (summary: string) => Promise<TitleHints | null>;
  resolveTarget: (intent: ParsedCalendarIntent, event: CandidateEvent) => Promise<ResolveResult>;
  adoptIntoLedger: typeof adoptCalendarEventIntoLedger;
  createProposal: (data: Prisma.ActionProposalUncheckedCreateInput) => Promise<{ id: string }>;
  findRows: (googleEventIds: string[]) => Promise<InboundRow[]>;
  findProposalStatuses: (proposalIds: string[]) => Promise<Map<string, string>>;
  /** googleEventId 로 upsert 하고 행 id 를 돌려준다. */
  saveRow: (googleEventId: string, write: InboundRowWrite) => Promise<{ id: string }>;
  touchRows: (rowIds: string[], lastSeenAt: Date) => Promise<void>;
};

/** YYYY-MM-DD 에 일수를 더한다 — UTC 문자열 산술이라 시간대 이동이 없다. */
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 구글 조회 창(RFC3339). timeMax 는 마지막 날 다음날 KST 0시(배타) — 끝날 하루를 통째로 담는다. */
export function calendarInboundWindow(now: Date): { timeMin: string; timeMax: string } {
  const today = toKstYmd(now);
  const kstMidnight = (ymd: string) => new Date(`${ymd}T00:00:00+09:00`).toISOString();
  return {
    timeMin: kstMidnight(shiftYmd(today, -WINDOW_DAYS_BACK)),
    timeMax: kstMidnight(shiftYmd(today, WINDOW_DAYS_FORWARD + 1)),
  };
}

/** 지문 = sha1(제목|시작|끝). 이 셋이 그대로면 다시 해석하지 않는다(LLM 호출도 없다). */
export function calendarInboundFingerprint(event: Pick<CandidateEvent, "summary" | "startDate" | "endDate">): string {
  return createHash("sha1").update(`${event.summary}|${event.startDate}|${event.endDate}`).digest("hex");
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptySummary(): ScanSummary {
  return {
    ok: true,
    scanned: 0,
    crmOwned: 0,
    newOrChanged: 0,
    proposed: 0,
    skippedUnparsed: 0,
    adoptedNoop: 0,
    dropped: 0,
    hintDeferred: 0,
    alreadyHandled: 0,
    errors: 0,
  };
}

/** 결정 대기로 볼 행 — 기안을 올렸거나, 열린 기안 때문에 건너뛴 행. */
function awaitsDecision(row: InboundRow): boolean {
  return (
    row.proposalId !== null &&
    (row.status === INBOUND_STATUS.PROPOSED ||
      (row.status === INBOUND_STATUS.SKIPPED && row.skipReason === INBOUND_SKIP_OPEN_PROPOSAL))
  );
}

type Triage =
  | { kind: "evaluate" }
  | { kind: "handled" }
  /** 열린 기안이 있는데 일정이 바뀌었다 — 옛 기안을 고아로 만들지 않는다. */
  | { kind: "open_proposal" };

function triage(row: InboundRow | undefined, fingerprint: string, proposalStatuses: Map<string, string>): Triage {
  if (!row) return { kind: "evaluate" };
  // 승인 실행 실패 — 지문과 무관하게 최신 값으로 다시 판정한다.
  if (row.status === INBOUND_STATUS.PENDING_RETRY) return { kind: "evaluate" };
  if (awaitsDecision(row)) {
    const proposalStatus = proposalStatuses.get(row.proposalId!);
    if (proposalStatus !== undefined && CLOSED_PROPOSAL_STATUSES.has(proposalStatus)) return { kind: "handled" };
    if (proposalStatus !== undefined && OPEN_PROPOSAL_STATUSES.has(proposalStatus)) {
      return row.fingerprint === fingerprint ? { kind: "handled" } : { kind: "open_proposal" };
    }
    // 기안이 지워졌다(또는 모르는 상태) — 지문 규칙으로 내려간다.
  }
  return row.fingerprint === fingerprint ? { kind: "handled" } : { kind: "evaluate" };
}

/** 회차당 힌트 호출 예산 — 실제 호출 수를 센다. */
type HintBudget = { used: number; max: number };

/**
 * 규칙 파서 → (실패 시) 힌트 1회 → 재파서. 힌트 호출은 이 함수 안에서만, 이벤트당 최대 1회.
 * 예산이 바닥났으면 힌트를 부르지 않고 "deferred"(호출부는 행을 쓰지 않는다).
 */
async function parseWithHints(
  summary: string,
  dict: InboundDictionary,
  deps: CalendarInboundScanDeps,
  budget: HintBudget,
): Promise<ReturnType<typeof parseCalendarTitle> | "deferred"> {
  const first = parseCalendarTitle(summary, dict);
  if (first.ok) return first;
  if (budget.used >= budget.max) return "deferred";
  budget.used++;
  const hints = await deps.extractHints(summary);
  if (!hints) return first;
  return parseCalendarTitle(summary, dict, hints);
}

/** noop 넘겨받기 — 승인 경로(`approveProposal`)와 같은 판정→사유 표를 쓴다. 던지지 않는다. */
async function adoptNoop(
  draft: ProposalDraft,
  event: CandidateEvent,
  deps: CalendarInboundScanDeps,
): Promise<string | null> {
  if (!draft.adopt || !draft.targetCampaignId) return null;
  try {
    const outcome = await deps.adoptIntoLedger({
      campaignId: draft.targetCampaignId,
      kind: draft.ledgerKind,
      eventId: event.id,
      calendarId: event.calendarId,
    });
    return inboundSkipReasonForAdoptOutcome(outcome);
  } catch (err) {
    console.error(`[calendar-inbound] 이벤트 ${event.id} noop 넘겨받기 실패:`, err);
    return INBOUND_SKIP_ADOPT_FAILED;
  }
}

function buildProposalInput(
  draft: ProposalDraft,
  ref: CalendarInboundRef,
): Prisma.ActionProposalUncheckedCreateInput {
  return {
    requestType: getRequestTypeForAction(draft.action),
    kind: "WRITE",
    status: "PENDING_APPROVAL",
    title: draft.title,
    payload: { action: draft.action, args: draft.args } as Prisma.InputJsonObject,
    campaignId: draft.targetCampaignId,
    targetEntityType: "CAMPAIGN",
    targetEntityId: draft.targetCampaignId,
    createdBy: CALENDAR_INBOUND_CREATED_BY,
    sourceRef: { calendarInbound: ref } as Prisma.InputJsonObject,
    risks: draft.warnings,
  };
}

type EventOutcome = "proposed" | "skipped" | "adopted" | "deferred";

/** 해석 대상 한 건 처리. 예외는 호출부가 잡는다. */
async function evaluateEvent(
  event: CandidateEvent,
  fingerprint: string,
  dict: InboundDictionary,
  now: Date,
  deps: CalendarInboundScanDeps,
  /** 재판정 대기 행이다 — 기안 없이 끝나면(SKIPPED·noop) 옛 FAILED 기안과의 연결을 끊는다(R20). */
  retrying: boolean,
  hintBudget: HintBudget,
): Promise<EventOutcome> {
  const base = {
    calendarId: event.calendarId,
    summary: event.summary,
    startDate: event.startDate,
    endDate: event.endDate,
    lastSeenAt: now,
  };
  // 옛 FAILED 기안을 그대로 가리키면 그 기안의 재시도 승인이 최신 판정(해석 불가·이미 같음)을 무시하고
  // 실행된다. null 이면 승인 단계(`approveProposal`)가 SUPERSEDED 로 거절한다.
  const detach = retrying ? { proposalId: null } : {};

  const parsed = await parseWithHints(event.summary, dict, deps, hintBudget);
  if (parsed === "deferred") return "deferred";
  if (!parsed.ok) {
    await deps.saveRow(event.id, {
      ...base,
      fingerprint,
      status: INBOUND_STATUS.SKIPPED,
      skipReason: parsed.reason,
      parsed: null,
      ...detach,
    });
    return "skipped";
  }

  const resolved = await deps.resolveTarget(parsed.intent, event);
  if (!resolved.ok) {
    const reason = resolved.reason === "invalid_draft" ? `invalid_draft: ${resolved.detail}` : resolved.reason;
    await deps.saveRow(event.id, {
      ...base,
      fingerprint,
      status: INBOUND_STATUS.SKIPPED,
      skipReason: truncate(reason, SKIP_REASON_MAX),
      parsed: parsed.intent,
      ...detach,
    });
    return "skipped";
  }

  const draft = resolved.draft;
  if (draft.noop) {
    const skipReason = await adoptNoop(draft, event, deps);
    await deps.saveRow(event.id, {
      ...base,
      fingerprint,
      status: INBOUND_STATUS.ADOPTED,
      skipReason,
      parsed: parsed.intent,
      campaignId: draft.targetCampaignId,
      ...detach,
    });
    return "adopted";
  }

  // 기안 전에 행부터 「재판정 대기·빈 지문」으로 적는다 — 기안 id 를 받기 전에 실패하면 다음 회차가
  // 다시 판정한다(조용히 PROPOSED 로 남아 기안 없는 행이 되지 않게).
  const { id: inboundId } = await deps.saveRow(event.id, {
    ...base,
    fingerprint: "",
    status: INBOUND_STATUS.PENDING_RETRY,
    skipReason: null,
    parsed: parsed.intent,
  });
  // 승인 쪽이 읽는 모양(`readCalendarInboundRef`)으로 검사 — 못 읽을 출처면 넘겨받기가 조용히 빠진다.
  const ref = calendarInboundRefSchema.parse({
    inboundId,
    eventId: event.id,
    calendarId: event.calendarId,
    ledgerKind: draft.ledgerKind,
    adopt: draft.adopt,
    summary: event.summary,
    startDate: event.startDate,
    endDate: event.endDate,
    htmlLink: event.htmlLink,
    warnings: draft.warnings,
  });
  const proposal = await deps.createProposal(buildProposalInput(draft, ref));
  // proposalId 를 새 기안으로 — 재판정 대기에서 다시 올린 경우 옛 기안은 승인 단계에서 SUPERSEDED 가 된다.
  await deps.saveRow(event.id, {
    ...base,
    fingerprint,
    status: INBOUND_STATUS.PROPOSED,
    skipReason: null,
    proposalId: proposal.id,
    campaignId: draft.targetCampaignId,
  });
  return "proposed";
}

export async function runCalendarInboundScan(
  opts: {
    now?: Date;
    maxProposals?: number;
    maxHintCalls?: number;
    deps?: Partial<CalendarInboundScanDeps>;
  } = {},
): Promise<ScanSummary> {
  const now = opts.now ?? new Date();
  const cap = opts.maxProposals ?? MAX_PROPOSALS_PER_RUN;
  const hintBudget: HintBudget = { used: 0, max: opts.maxHintCalls ?? MAX_HINT_CALLS_PER_RUN };
  const deps: CalendarInboundScanDeps = { ...defaultDeps(), ...opts.deps };
  const summary = emptySummary();

  let listed: CandidateListResult;
  try {
    listed = await deps.listCandidates(calendarInboundWindow(now));
  } catch (err) {
    console.error("[calendar-inbound] 후보 조회 실패:", err);
    return { ...summary, ok: false, error: describeError(err) };
  }
  if (!listed.ok) {
    return {
      ...summary,
      ok: false,
      ...(listed.skipped ? { skipped: listed.skipped } : {}),
      ...(listed.error ? { error: listed.error } : {}),
    };
  }

  summary.scanned = listed.events.length;
  const candidates = listed.events.filter((event) => {
    const owned = listed.referencedIds.has(event.id) || event.crmSigned;
    if (owned) summary.crmOwned++;
    return !owned;
  });
  if (candidates.length === 0) return summary;

  let dict: InboundDictionary;
  let rowsByEventId: Map<string, InboundRow>;
  let proposalStatuses: Map<string, string>;
  try {
    dict = await deps.loadDictionary();
    const rows = await deps.findRows(candidates.map((event) => event.id));
    rowsByEventId = new Map(rows.map((row) => [row.googleEventId, row]));
    const proposalIds = rows.filter(awaitsDecision).map((row) => row.proposalId!);
    proposalStatuses = proposalIds.length > 0 ? await deps.findProposalStatuses(proposalIds) : new Map();
  } catch (err) {
    console.error("[calendar-inbound] 사전·수집 행 조회 실패:", err);
    return { ...summary, ok: false, error: describeError(err) };
  }

  const touched: string[] = [];
  for (const event of candidates) {
    try {
      const row = rowsByEventId.get(event.id);
      const fingerprint = calendarInboundFingerprint(event);
      const decision = triage(row, fingerprint, proposalStatuses);

      if (decision.kind === "handled") {
        touched.push(row!.id);
        summary.alreadyHandled++;
        continue;
      }
      if (decision.kind === "open_proposal") {
        // 지문은 옛것 그대로 둔다 — 기안이 닫힌 뒤 다음 회차가 바뀐 일정으로 다시 판정하게.
        await deps.saveRow(event.id, {
          calendarId: event.calendarId,
          summary: event.summary,
          startDate: event.startDate,
          endDate: event.endDate,
          fingerprint: row!.fingerprint,
          status: INBOUND_STATUS.SKIPPED,
          skipReason: INBOUND_SKIP_OPEN_PROPOSAL,
          lastSeenAt: now,
        });
        summary.alreadyHandled++;
        continue;
      }

      summary.newOrChanged++;
      // 기안 상한 — 기안 수만 센다. 힌트(Gemini) 호출은 따로 `hintBudget` 이 묶는다.
      if (summary.proposed >= cap) {
        // 손대지 않는다 — 다음 회차가 처음 본 것처럼 집는다.
        summary.dropped++;
        continue;
      }
      const retrying = row?.status === INBOUND_STATUS.PENDING_RETRY;
      const outcome = await evaluateEvent(event, fingerprint, dict, now, deps, retrying, hintBudget);
      if (outcome === "proposed") summary.proposed++;
      else if (outcome === "adopted") summary.adoptedNoop++;
      else if (outcome === "deferred") summary.hintDeferred++;
      else summary.skippedUnparsed++;
    } catch (err) {
      // 이벤트 id 만 남긴다 — 제목에는 셀러 이름이 있을 수 있다.
      console.error(`[calendar-inbound] 이벤트 ${event.id} 처리 실패 (다음 건 계속):`, err);
      summary.errors++;
    }
  }

  if (touched.length > 0) {
    try {
      await deps.touchRows(touched, now);
    } catch (err) {
      console.error("[calendar-inbound] lastSeenAt 갱신 실패:", err);
      summary.errors++;
    }
  }
  return summary;
}

// ── 기본 의존성(실 DB·캘린더·LLM) ──────────────────────────────────────────────

/** Json 칸 쓰기 — Postgres 는 객체·DbNull, SQLite 레인은 문자열·null(`stored-json.ts` 와 짝). */
function parsedColumn(value: ParsedCalendarIntent | null | undefined) {
  if (value === undefined) return undefined;
  const sqlite = isSqliteDatabaseUrl();
  if (value === null) return sqlite ? null : Prisma.DbNull;
  return (sqlite ? JSON.stringify(value) : value) as unknown as Prisma.InputJsonValue;
}

function defaultDeps(): CalendarInboundScanDeps {
  return {
    listCandidates: listAllDayCandidateEvents,
    loadDictionary: () => loadInboundDictionary(getPrisma()),
    extractHints: (summary) => extractTitleHints(summary),
    resolveTarget: (intent, event) => resolveInboundTarget(intent, event, getPrisma()),
    adoptIntoLedger: adoptCalendarEventIntoLedger,
    createProposal: (data) => ActionProposalRepository.create(data),
    findRows: (googleEventIds) =>
      getPrisma().calendarInboundEvent.findMany({
        where: { googleEventId: { in: googleEventIds } },
        select: { id: true, googleEventId: true, fingerprint: true, status: true, skipReason: true, proposalId: true },
      }),
    findProposalStatuses: async (proposalIds) => {
      const rows = await getPrisma().actionProposal.findMany({
        where: { id: { in: proposalIds } },
        select: { id: true, status: true },
      });
      return new Map(rows.map((row) => [row.id, row.status]));
    },
    saveRow: async (googleEventId, write) => {
      const data = { ...write, parsed: parsedColumn(write.parsed) } as Prisma.CalendarInboundEventUpdateInput;
      return getPrisma().calendarInboundEvent.upsert({
        where: { googleEventId },
        create: { ...data, googleEventId } as Prisma.CalendarInboundEventCreateInput,
        update: data,
        select: { id: true },
      });
    },
    touchRows: async (rowIds, lastSeenAt) => {
      await getPrisma().calendarInboundEvent.updateMany({ where: { id: { in: rowIds } }, data: { lastSeenAt } });
    },
  };
}
