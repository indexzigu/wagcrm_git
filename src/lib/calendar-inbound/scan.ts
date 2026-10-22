// [캘린더수집] 수집 스캔 오케스트레이션 — 구글 캘린더 종일 일정 → 해석 → 승인 대기 기안.
// 설계 정본: docs/private/specs/2026-10-21-calendar-inbound-sync-design.md §4·§5·§8-b·개정 2.
//
// 한 회차 흐름(한 건의 예외는 그 건만 `errors` 로 세고 계속한다):
//   창 계산(KST 오늘-14일 ~ 오늘+180일) → 후보 조회 → CRM 소유(장부 참조 id · `crmSigned`) 제외 →
//   수집 행(CalendarInboundEvent)과 대조 → 처음 보거나 지문이 바뀐 것·재판정 대기·해석 대기만 다룬다.
//   해석은 세 단계다 — 비싼 단계일수록 적게, 회차당 횟수를 묶어 부른다:
//   ① Gemini 일괄(회차당 최대 1번, 최대 `MAX_GEMINI_BATCH` 개): 지난 회차에 로컬 모델이 못 푼 해석 대기
//      행(AWAITING_HINT · hintStage "gemini")만. 오래 기다린 것부터(lastSeenAt), 넘친 것은 다음 회차.
//   ② 규칙 파서: 처음 보거나 바뀐 일정 전부.
//   ③ 이 맥의 로컬 모델(ollama): 규칙이 못 푼 것을 하나씩, 남은 시간 예산 안에서만. 못 풀면 해석 대기
//      (hintStage "gemini")로 적어 다음 회차 ①로 넘긴다. 예산이 모자라 못 부른 것은 해석 대기(hintStage
//      "local")로 적어 다음 회차 ③부터 잇는다.
//   풀린 것은 같은 회차에 대상 결정 → noop(CRM 값이 이미 같음)이면 처리 끝(ADOPTED, `already_current`) ·
//   아니면 기안(PENDING_APPROVAL) + 행 PROPOSED.
//
// ⛔ 이 스캔은 승인 없이 아무것도 바꾸지 않는다 — 장부에 원본을 넘겨받지도(`adoptCalendarEventIntoLedger`),
//    캘린더에 쓰지도(`syncCampaignToCalendar`) 않는다. 넘겨받으면 다음 동기화가 오너 일정의 제목·날짜를 CRM
//    형식으로 덮는데, 그것은 사람이 승인한 기안 뒤에만 일어나야 한다(넘겨받기는 `approveProposal` 커밋 뒤 단계).
//    noop 일정은 CRM 과 따로 남는 평범한 일정이다. 스캔이 캘린더에 쓰기 시작하면 「읽기 → 쓰기 → 다음 스캔이
//    자기 쓰기를 읽음」 고리도 생긴다.
// ⛔ 승인은 언제나 사람 — 기안의 requestType 은 액션이 정한다(`getRequestTypeForAction`, alwaysManual).
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getRequestTypeForAction } from "@/lib/agent/approval-policy";
import { toKstYmd } from "@/lib/date-utils";
import {
  listAllDayCandidateEvents,
  type CandidateEvent,
  type CandidateListResult,
} from "@/lib/google-calendar-sync";
import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import { parseStoredJsonObject } from "@/lib/stored-json";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import { CALENDAR_INBOUND_CREATED_BY, calendarInboundRefSchema, type CalendarInboundRef } from "./adopt";
import { loadInboundDictionary } from "./dictionary";
import { withScanLock } from "./run-lock";
import {
  GEMINI_FETCH_TIMEOUT_MS,
  MAX_GEMINI_BATCH,
  NONE,
  extractTitleHintsBatch,
  type TitleHintsBatchResult,
  type TitleHintsResult,
} from "./llm-hints";
import { LOCAL_HINT_TIMEOUT_MS, extractTitleHintsLocal, resetLocalHintWarnings } from "./local-hints";
import { parseCalendarTitle } from "./parse-title";
import { resolveInboundTarget, type ProposalDraft, type ResolveResult } from "./resolve-target";
import { INBOUND_SKIP_ALREADY_CURRENT, INBOUND_SKIP_OPEN_PROPOSAL, INBOUND_STATUS } from "./status";
import type { InboundDictionary, ParsedCalendarIntent, ParseFailure } from "./types";

/**
 * 한 회차 기안 상한. 평시엔 하루 몇 건이라 걸리지 않는다 — 데이터 결함(대량 붙여넣기 등)이 결재함
 * 폭주로 번지는 것을 막는 안전판이다. 넘친 건은 **쓰지 않고**(SKIPPED 로도 적지 않는다) 다음 회차에
 * 넘기며, 그 수를 `dropped` 로 남긴다 — 조용한 절단은 「전부 처리했다」로 읽힌다.
 */
export const MAX_PROPOSALS_PER_RUN = 20;

/**
 * 한 회차 시간 예산. 넘기면 남은 일정은 **쓰지 않고** 다음 회차로 넘긴다(`dropped` 로 센다).
 * - 60초 이하: 배포 지침(`docs/agents/deployment.md` 「Plan Limits」) — Vercel Hobby 가 함수 실행을 60초로 자르므로
 *   예산 상수를 그 위로 두지 않는다. 남은 일정은 다음 회차(30분 뒤)가 집는다.
 * - 단일 실행 잠금의 트랜잭션 시간 제한(`run-lock.ts` `LOCK_TX_TIMEOUT_MS`)보다 짧아야 한다 — 예산은 일정 하나를
 *   **시작하기 전에만** 보므로 마지막 일정은 예산을 넘겨 끝날 수 있다(DB 쓰기). 모델 호출은 둘 다 남은 예산 안에
 *   묶는다 — 로컬은 호출마다, Gemini 일괄은 키 회전 전체에 남은 예산에서 여유를 뺀 한도를 건다. 제한이 먼저 오면
 *   잠금이 풀린 채 본문이 돌아 겹친 회차가 같은 일정을 또 기안할 수 있다.
 */
export const SCAN_BUDGET_MS = 55_000;

/**
 * 로컬 모델 호출을 새로 시작하는 데 필요한 최소 남은 예산. 이보다 적으면 부르지 않고 해석 대기(hintStage
 * "local")로 적어 다음 회차가 이어서 부른다 — 짧은 시간 제한으로 부르면 응답 전에 끊겨 헛호출만 된다.
 */
export const LOCAL_MIN_REMAINING_MS = 8_000;

/** 로컬 모델 호출의 시간 제한을 남은 예산에서 이만큼 덜어 잡는다(응답 뒤 해석·DB 쓰기 몫). */
export const LOCAL_TIMEOUT_MARGIN_MS = 3_000;

/**
 * Gemini 일괄을 시작하는 데 필요한 남은 예산 = 키 하나의 요청 시간 제한 + 여유. 이보다 적으면 부르지 않고 일시
 * 장애와 똑같이 해석 대기로 두어 다음 회차에 묻는다. 부를 때는 키 회전 전체에 (남은 예산 - 여유) 한도를 걸어,
 * 키마다 20초씩 새로 받아 예산을 넘지 않게 한다.
 */
export const GEMINI_BATCH_TIMEOUT_MS = GEMINI_FETCH_TIMEOUT_MS;
export const GEMINI_TIMEOUT_MARGIN_MS = 3_000;

/** 스캔 창 — KST 오늘 기준 과거 14일 ~ 미래 180일(끝날 포함). */
const WINDOW_DAYS_BACK = 14;
const WINDOW_DAYS_FORWARD = 180;

const SKIP_REASON_MAX = 500;

/** 아직 결정되지 않은 기안 상태 — 이 기안이 살아 있는 동안은 같은 일정을 다시 기안하지 않는다. */
const OPEN_PROPOSAL_STATUSES = new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED", "FAILED"]);
/** 닫힌 기안 — 사후 표기(ADOPTED/REJECTED)가 조용히 실패한 행이다. 다시 기안하면 같은 일정이 두 번 반영된다. */
const CLOSED_PROPOSAL_STATUSES = new Set(["EXECUTED", "REJECTED"]);

/** 해석 대기 행이 다음에 거칠 단계. */
export type HintStage = "local" | "gemini";
/** 해석 대기(AWAITING_HINT) 행의 `parsed` 칸 — 해석 결과가 아니라 다음 단계만 적는다. */
export type AwaitingHintParsed = { hintStage: HintStage };

export type ScanSummary = {
  ok: boolean;
  /**
   * not_connected = 캘린더 연결 없음(ok:false). busy = 다른 회차가 도는 중이라 이번 회차는 아무것도 건드리지
   * 않았다(ok:true — 고장이 아니다. 앞 회차가 같은 일정을 처리한다).
   */
  skipped?: "not_connected" | "busy";
  /** 후보로 읽은 종일·비반복 이벤트 수(CRM 소유 포함). */
  scanned: number;
  /** 장부가 참조하거나 CRM 표식이 있어 제외한 수. */
  crmOwned: number;
  /** 해석 대상(처음 봄·지문 바뀜·재판정 대기·해석 대기) — 상한에 걸린 건도 포함. */
  newOrChanged: number;
  proposed: number;
  /** 해석 실패·대상 없음으로 SKIPPED 적은 수. */
  skippedUnparsed: number;
  /** 바꿀 칸이 없어(CRM 값이 이미 같음) 기안 없이 처리 끝(ADOPTED, `already_current`)으로 적은 수. 장부는 그대로다. */
  adoptedNoop: number;
  /** 기안 상한·회차 시간 예산에 걸려 이번 회차에 손대지 않은 수(다음 회차가 집는다). */
  dropped: number;
  /**
   * 이번 회차가 해석 대기(AWAITING_HINT)로 남긴 수 — 로컬 모델이 못 풀어 다음 회차 Gemini 로 넘긴 것, 예산이 모자라
   * 로컬 모델·Gemini 를 못 부르거나 끊긴 것, Gemini 일괄이 일시 장애였거나 일괄 한도를 넘어 다음 회차를 기다리는 것. `dropped` 와 겹치지
   * 않는다(상한·예산으로 손대지 않은 해석 대기 행은 `dropped` 로만 센다).
   */
  awaitingHint: number;
  /** 로컬 모델 힌트로 제목이 풀린 수(그 뒤 기안·noop·대상 없음 어느 쪽으로 끝났든). 위 칸들과 겹친다. */
  localResolved: number;
  /** Gemini 일괄 힌트로 제목이 풀린 수(그 뒤 결과와 무관). 위 칸들과 겹친다. */
  geminiResolved: number;
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
  /** 해석 대기 행이면 `{ hintStage }`(SQLite 레인은 문자열로 온다 — `parseStoredJsonObject` 로 읽는다). */
  parsed: unknown;
  /** Gemini 일괄에 오래 기다린 해석 대기 행부터 담는 기준. */
  lastSeenAt: Date;
  /** 조건부 쓰기의 기준 — 분류 시점에 읽은 값. */
  updatedAt: Date;
};

/** 수집 행의 판(版) — 조건부 쓰기는 이 값이 그대로일 때만 성공한다. */
export type InboundRowVersion = { id: string; updatedAt: Date };

/** 수집 행 쓰기. `undefined` 칸은 그대로 둔다(proposalId·campaignId 를 지우지 않으려고). */
export type InboundRowWrite = {
  calendarId: string;
  summary: string;
  startDate: string;
  endDate: string;
  fingerprint: string;
  status: string;
  skipReason: string | null;
  parsed?: ParsedCalendarIntent | AwaitingHintParsed | null;
  /** null = 옛 기안과의 연결을 끊는다(그 기안은 승인 단계에서 SUPERSEDED). */
  proposalId?: string | null;
  campaignId?: string | null;
  lastSeenAt: Date;
};

/** 바깥 세계(캘린더·DB·LLM)는 전부 주입 — 테스트는 DB·네트워크 없이 돈다. */
export type CalendarInboundScanDeps = {
  listCandidates: (range: { timeMin: string; timeMax: string }) => Promise<CandidateListResult>;
  loadDictionary: () => Promise<InboundDictionary>;
  /** 이 맥의 로컬 모델로 제목 하나 — `timeoutMs` 는 남은 예산으로 줄여 넘긴다. */
  extractHintsLocal: (summary: string, opts: { timeoutMs: number }) => Promise<TitleHintsResult>;
  /** Gemini 일괄 — 회차당 최대 1번, 최대 `MAX_GEMINI_BATCH` 개. `timeoutMs` 는 키 회전 전체의 한도(남은 예산에서). */
  extractHintsBatch: (
    items: ReadonlyArray<{ id: string; summary: string }>,
    opts: { timeoutMs: number },
  ) => Promise<TitleHintsBatchResult>;
  resolveTarget: (intent: ParsedCalendarIntent, event: CandidateEvent) => Promise<ResolveResult>;
  createProposal: (data: Prisma.ActionProposalUncheckedCreateInput) => Promise<{ id: string }>;
  findRows: (googleEventIds: string[]) => Promise<InboundRow[]>;
  findProposalStatuses: (proposalIds: string[]) => Promise<Map<string, string>>;
  /**
   * 행 쓰기. `expected` 가 없으면(처음 보는 일정) googleEventId 로 upsert — 유일 키가 중복을 막는다. 있으면(기존 행)
   * `id`·`updatedAt` 이 그대로일 때만 쓰고, 그 사이 누가 바꿨으면 null(아무것도 쓰지 않음). 새 판을 돌려준다.
   */
  saveRow: (
    googleEventId: string,
    write: InboundRowWrite,
    expected?: InboundRowVersion,
  ) => Promise<InboundRowVersion | null>;
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
    awaitingHint: 0,
    localResolved: 0,
    geminiResolved: 0,
    alreadyHandled: 0,
    errors: 0,
  };
}

/** 기안 상태를 읽어야 분류할 수 있는 행 — 결정 대기 행 + 기안이 있는 재판정 대기 행. */
function needsProposalStatus(row: InboundRow): boolean {
  return awaitsDecision(row) || (row.status === INBOUND_STATUS.PENDING_RETRY && row.proposalId !== null);
}

/** 재시도 승인이 이미 행을 잡은 기안 상태 — 승인 중(APPROVED)이거나 끝남(EXECUTED). */
const RETRY_IN_FLIGHT_STATUSES = new Set(["APPROVED", "EXECUTED"]);

/** 결정 대기로 볼 행 — 기안을 올렸거나, 열린 기안 때문에 건너뛴 행. */
function awaitsDecision(row: InboundRow): boolean {
  return (
    row.proposalId !== null &&
    (row.status === INBOUND_STATUS.PROPOSED ||
      (row.status === INBOUND_STATUS.SKIPPED && row.skipReason === INBOUND_SKIP_OPEN_PROPOSAL))
  );
}

/** 해석 대기 행의 다음 단계. 칸이 깨졌거나 비면 로컬부터(Gemini 를 건너뛰는 쪽보다 한 번 더 묻는 쪽이 안전). */
function hintStageOf(row: InboundRow): HintStage {
  return parseStoredJsonObject(row.parsed).hintStage === "gemini" ? "gemini" : "local";
}

type Triage =
  | { kind: "evaluate" }
  | { kind: "handled" }
  /** 열린 기안이 있는데 일정이 바뀌었다 — 옛 기안을 고아로 만들지 않는다. */
  | { kind: "open_proposal" }
  /** 해석 대기 행이고 일정이 그대로다 — 적어 둔 단계부터 잇는다. */
  | { kind: "awaiting"; stage: HintStage };

function triage(row: InboundRow | undefined, fingerprint: string, proposalStatuses: Map<string, string>): Triage {
  if (!row) return { kind: "evaluate" };
  // 승인 실행 실패 — 지문과 무관하게 최신 값으로 다시 판정한다. 단 오너가 그 FAILED 기안을 재시도 승인해 이미
  // 행을 잡았으면(기안 APPROVED·EXECUTED) 손대지 않는다 — 다시 기안하면 같은 일정이 두 번 반영된다. 행 잡기는
  // 상태를 바꾸지 않으므로(사후 표기 전까지 PENDING_RETRY) 기안 상태로 가른다. FAILED·REJECTED·없음은 재판정.
  if (row.status === INBOUND_STATUS.PENDING_RETRY) {
    const proposalStatus = row.proposalId ? proposalStatuses.get(row.proposalId) : undefined;
    if (proposalStatus !== undefined && RETRY_IN_FLIGHT_STATUSES.has(proposalStatus)) return { kind: "handled" };
    return { kind: "evaluate" };
  }
  // 해석 대기 — 끝난 행이 아니다(「처리됨」으로 세면 영영 묻힌다). 일정이 바뀌었으면 규칙부터 다시.
  if (row.status === INBOUND_STATUS.AWAITING_HINT) {
    return row.fingerprint === fingerprint ? { kind: "awaiting", stage: hintStageOf(row) } : { kind: "evaluate" };
  }
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

/** lost = 분류 뒤 다른 쓰기(재시도 승인의 행 잡기 등)가 행을 바꿔 이번 회차는 손떼었다. */
type EventOutcome = "proposed" | "skipped" | "adopted" | "awaiting" | "lost";

/** 해석 대상 한 건 — 분류 시점에 정해진 것들. */
type Work = {
  event: CandidateEvent;
  fingerprint: string;
  /** 재판정 대기 행이다 — 기안 없이 끝나면(SKIPPED·noop·해석 대기) 옛 FAILED 기안과의 연결을 끊는다(옛 카드 재시도가 승인 단계에서 거절되게). */
  retrying: boolean;
  /** 기존 행이면 분류 시점의 판 — 모든 쓰기를 이 판에 조건부로 건다. 처음 보는 일정이면 null(upsert). */
  version: InboundRowVersion | null;
  /** 기존 행(해석 대기 행의 lastSeenAt·id 를 읽는다). */
  row: InboundRow | undefined;
  /** 지난 회차에 예산이 모자라 로컬을 못 부른 해석 대기 행(같은 지문) — 이번 회차 로컬 단계에서 먼저 부른다. */
  carriedLocal: boolean;
};

type ParseResult = { ok: true; intent: ParsedCalendarIntent } | ParseFailure;

/**
 * 한 건의 행 쓰기 도구. 기존 행 쓰기는 전부 조건부다 — 분류와 쓰기 사이에 오너가 옛 FAILED 카드를 재시도 승인하면
 * 승인이 행을 잡아(`claimInboundRowForApproval`, updatedAt 갱신) 여기 쓰기가 0건이 된다. 그 일정은 승인이 처리하고
 * 스캔은 손뗀다 — 덮어쓰거나 새 기안을 만들면 같은 일정이 두 번 반영된다. 성공한 쓰기는 판을 이어받는다.
 */
function rowWriter(work: Work, now: Date, deps: CalendarInboundScanDeps) {
  let current = work.version;
  const save = async (write: InboundRowWrite): Promise<InboundRowVersion | null> => {
    const saved = await deps.saveRow(work.event.id, write, current ?? undefined);
    if (saved) current = saved;
    return saved;
  };
  const base = {
    calendarId: work.event.calendarId,
    summary: work.event.summary,
    startDate: work.event.startDate,
    endDate: work.event.endDate,
    fingerprint: work.fingerprint,
    lastSeenAt: now,
  };
  // 옛 FAILED 기안을 그대로 가리키면 그 기안의 재시도 승인이 최신 판정(해석 불가·이미 같음·해석 대기)을 무시하고
  // 실행된다. null 이면 승인 단계(`approveProposal`)가 SUPERSEDED 로 거절한다.
  const detach = work.retrying ? { proposalId: null } : {};
  return { save, base, detach };
}

/** 아직 못 푼 제목을 해석 대기로 적는다 — 다음 회차가 `stage` 부터 잇는다. 조건부 쓰기(승인과 겹치면 손뗀다). */
async function saveAwaiting(
  work: Work,
  stage: HintStage,
  now: Date,
  deps: CalendarInboundScanDeps,
): Promise<EventOutcome> {
  const { save, base, detach } = rowWriter(work, now, deps);
  const parsed: AwaitingHintParsed = { hintStage: stage };
  const saved = await save({ ...base, status: INBOUND_STATUS.AWAITING_HINT, skipReason: null, parsed, ...detach });
  return saved ? "awaiting" : "lost";
}

/** 해석(성공 또는 최종 실패)이 정해진 한 건을 끝까지 — SKIPPED · noop · 기안. 예외는 호출부가 잡는다. */
async function settleParsed(
  work: Work,
  parsed: ParseResult,
  now: Date,
  deps: CalendarInboundScanDeps,
): Promise<EventOutcome> {
  const { event } = work;
  const { save, base, detach } = rowWriter(work, now, deps);

  if (!parsed.ok) {
    const saved = await save({ ...base, status: INBOUND_STATUS.SKIPPED, skipReason: parsed.reason, parsed: null, ...detach });
    return saved ? "skipped" : "lost";
  }

  const resolved = await deps.resolveTarget(parsed.intent, event);
  if (!resolved.ok) {
    const reason = resolved.reason === "invalid_draft" ? `invalid_draft: ${resolved.detail}` : resolved.reason;
    const saved = await save({
      ...base,
      status: INBOUND_STATUS.SKIPPED,
      skipReason: truncate(reason, SKIP_REASON_MAX),
      parsed: parsed.intent,
      ...detach,
    });
    return saved ? "skipped" : "lost";
  }

  const draft = resolved.draft;
  if (draft.noop) {
    // 처리 끝으로만 적는다 — 장부에 넘겨받지 않는다(헤더 ⛔). 같은 지문이면 다시 해석하지 않는다.
    const saved = await save({
      ...base,
      status: INBOUND_STATUS.ADOPTED,
      skipReason: INBOUND_SKIP_ALREADY_CURRENT,
      parsed: parsed.intent,
      campaignId: draft.targetCampaignId,
      ...detach,
    });
    return saved ? "adopted" : "lost";
  }

  // 기안 전에 행부터 「재판정 대기」로 적는다 — 기안 id 를 받기 전에 실패하면 다음 회차가 상태만 보고 다시
  // 판정한다(조용히 PROPOSED 로 남아 기안 없는 행이 되지 않게). 지문은 실값을 적는다(재판정은 상태가 정한다).
  // ⛔ proposalId 를 여기서 끊는다 — 남겨 두면 이 사이 실패했을 때 옛 FAILED 카드가 SUPERSEDED 가드를 통과해
  //    재시도 승인돼 새 회차가 하나 생기고, 다음 회차가 또 기안해 하나 더 생긴다. 승인과 겹쳐도 옛 카드는 거절된다.
  // 이 조건부 쓰기는 기안 생성 **앞**이다 — 승인과의 경합에서 지면 기안을 만들지 않고 끝난다.
  const provisional = await save({
    ...base,
    status: INBOUND_STATUS.PENDING_RETRY,
    skipReason: null,
    parsed: parsed.intent,
    proposalId: null,
  });
  if (!provisional) return "lost";
  const inboundId = provisional.id;
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
  const linked = await save({
    ...base,
    status: INBOUND_STATUS.PROPOSED,
    skipReason: null,
    proposalId: proposal.id,
    campaignId: draft.targetCampaignId,
  });
  if (!linked) {
    // 임시 쓰기로 proposalId 를 끊었으므로 그 사이 승인될 기안이 없다 — 정상 흐름에선 오지 않는다. 방금 만든 기안은
    // 행이 가리키지 않아 승인 단계에서 SUPERSEDED 로 거절되고, 행은 재판정 대기라 다음 회차가 다시 판정한다.
    throw new Error(`기안 ${proposal.id} 를 만든 뒤 수집 행을 잡지 못함`);
  }
  return "proposed";
}

type ScanOptions = {
  now?: Date;
  maxProposals?: number;
  /** 회차 시간 예산(ms). 기본 `SCAN_BUDGET_MS`. */
  budgetMs?: number;
  /** 경과 시간 시계(ms). 기본 `Date.now` — 테스트가 로컬 모델의 느린 응답을 흉내 내려고 바꾼다. */
  clock?: () => number;
  deps?: Partial<CalendarInboundScanDeps>;
};

/**
 * 한 회차. 크론과 수동 실행이 겹치지 않게 단일 실행 잠금(`run-lock.ts`) 안에서만 돈다 — 잠금을 못 잡으면
 * 후보 조회도 하지 않고 `{ ok: true, skipped: "busy" }` 로 끝난다.
 */
export async function runCalendarInboundScan(opts: ScanOptions = {}): Promise<ScanSummary> {
  const flight = await withScanLock(() => scanOnce(opts));
  if (!flight.acquired) return { ...emptySummary(), skipped: "busy" };
  return flight.value;
}

async function scanOnce(opts: ScanOptions): Promise<ScanSummary> {
  resetLocalHintWarnings();
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = opts.budgetMs ?? SCAN_BUDGET_MS;
  const now = opts.now ?? new Date();
  const cap = opts.maxProposals ?? MAX_PROPOSALS_PER_RUN;
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
    const proposalIds = rows.filter(needsProposalStatus).map((row) => row.proposalId!);
    proposalStatuses = proposalIds.length > 0 ? await deps.findProposalStatuses(proposalIds) : new Map();
  } catch (err) {
    console.error("[calendar-inbound] 사전·수집 행 조회 실패:", err);
    return { ...summary, ok: false, error: describeError(err) };
  }

  const record = (outcome: EventOutcome) => {
    if (outcome === "proposed") summary.proposed++;
    else if (outcome === "lost") summary.alreadyHandled++;
    else if (outcome === "adopted") summary.adoptedNoop++;
    else if (outcome === "awaiting") summary.awaitingHint++;
    else summary.skippedUnparsed++;
  };
  const failed = (event: CandidateEvent, err: unknown) => {
    // 이벤트 id 만 남긴다 — 제목에는 셀러 이름이 있을 수 있다.
    console.error(`[calendar-inbound] 이벤트 ${event.id} 처리 실패 (다음 건 계속):`, err);
    summary.errors++;
  };
  const elapsed = () => clock() - startedAt;
  // 기안 상한 — 기안 수만 센다. 시간 예산도 같이 본다 — 60초 실행 한도와 잠금 트랜잭션 시간 제한 안에서 끝내야
  // 한다(위 SCAN_BUDGET_MS). 걸린 건은 손대지 않는다 — 다음 회차가 지금 상태 그대로 집는다.
  const mustDrop = () => summary.proposed >= cap || elapsed() > budgetMs;

  // ── 분류 ──
  const touched: string[] = [];
  const geminiQueue: Work[] = [];
  const ruleQueue: Work[] = [];
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
        // 지문은 옛것 그대로 둔다 — 기안이 닫힌 뒤 다음 회차가 바뀐 일정으로 다시 판정하게. 조건부 쓰기라 그 사이
        // 승인이 행을 잡았으면 0건이고, 그래도 이미 처리된 것으로 센다.
        await deps.saveRow(
          event.id,
          {
            calendarId: event.calendarId,
            summary: event.summary,
            startDate: event.startDate,
            endDate: event.endDate,
            fingerprint: row!.fingerprint,
            status: INBOUND_STATUS.SKIPPED,
            skipReason: INBOUND_SKIP_OPEN_PROPOSAL,
            lastSeenAt: now,
          },
          { id: row!.id, updatedAt: row!.updatedAt },
        );
        summary.alreadyHandled++;
        continue;
      }

      summary.newOrChanged++;
      const work: Work = {
        event,
        fingerprint,
        retrying: row?.status === INBOUND_STATUS.PENDING_RETRY,
        version: row ? { id: row.id, updatedAt: row.updatedAt } : null,
        row,
        carriedLocal: decision.kind === "awaiting" && decision.stage === "local",
      };
      // Gemini 단계로 적힌 행은 로컬 모델에 다시 보내지 않는다(이미 못 풀었다).
      if (decision.kind === "awaiting" && decision.stage === "gemini") geminiQueue.push(work);
      else ruleQueue.push(work);
    } catch (err) {
      failed(event, err);
    }
  }

  // ── ① Gemini 일괄 — 지난 회차에 로컬 모델이 못 푼 것만, 회차당 최대 1번 ──
  // 규칙은 공짜라 먼저 다시 본다(사전이 그 사이 늘었을 수 있다) — 실패 사유도 여기서 얻는다(힌트가 none 이면 그
  // 사유로 닫는다). 일괄 호출은 남은 예산이 충분할 때만, 키 회전 전체에 남은 예산 한도를 걸어 부른다.
  geminiQueue.sort((a, b) => a.row!.lastSeenAt.getTime() - b.row!.lastSeenAt.getTime());
  const batch: { work: Work; ruleFailure: ParseFailure }[] = [];
  for (const work of geminiQueue) {
    try {
      if (mustDrop()) {
        summary.dropped++;
        continue;
      }
      const byRule = parseCalendarTitle(work.event.summary, dict);
      if (byRule.ok) {
        record(await settleParsed(work, byRule, now, deps));
        continue;
      }
      if (batch.length >= MAX_GEMINI_BATCH) {
        // 일괄 한도를 넘친 것은 다음 회차 — 손대지 않아 lastSeenAt 이 그대로 남아 다음 회차에 먼저 담긴다.
        summary.awaitingHint++;
        continue;
      }
      batch.push({ work, ruleFailure: byRule });
    } catch (err) {
      failed(work.event, err);
    }
  }
  if (batch.length > 0) {
    let result: TitleHintsBatchResult = { kind: "unavailable" };
    const remaining = budgetMs - elapsed();
    // 남은 예산이 모자라면 부르지 않는다 — 일시 장애와 똑같이 해석 대기로 두고 다음 회차에 묻는다.
    if (remaining >= GEMINI_BATCH_TIMEOUT_MS + GEMINI_TIMEOUT_MARGIN_MS) {
      try {
        // id 는 일괄 안의 순번 — 구글 이벤트 id 를 바깥 모델에 보내지 않고, 같은 이벤트 id 가 두 캘린더에 있어도 겹치지 않는다.
        result = await deps.extractHintsBatch(
          batch.map((b, i) => ({ id: String(i), summary: b.work.event.summary })),
          { timeoutMs: remaining - GEMINI_TIMEOUT_MARGIN_MS },
        );
      } catch (err) {
        // 한 건의 예외가 아니라 호출 하나의 예외라 `errors`(건별)로 세지 않는다 — 행은 해석 대기로 남아 다음 회차에 다시.
        console.error("[calendar-inbound] Gemini 일괄 힌트 호출 실패 (다음 회차에 다시):", err);
        result = { kind: "unavailable" };
      }
    }
    if (result.kind === "unavailable") {
      // 일시 장애·예외·예산 부족으로 못 부름 — 닫지 않고 해석 대기(gemini)로 둔다. 쓸 칸이 없어 lastSeenAt 만 갱신한다.
      for (const b of batch) {
        touched.push(b.work.row!.id);
        summary.awaitingHint++;
      }
    } else {
      for (const [i, b] of batch.entries()) {
        try {
          // 받은 힌트는 시간 예산으로 버리지 않는다 — 버리면 같은 제목을 다음 회차에 Gemini 로 또 보낸다(남은 일은
          // 대상 결정·DB 쓰기뿐이라 짧다). 기안 상한만 본다.
          if (summary.proposed >= cap) {
            summary.dropped++;
            continue;
          }
          const hint = result.results.get(String(i)) ?? NONE;
          let parsed: ParseResult = b.ruleFailure;
          if (hint.kind === "hints") {
            parsed = parseCalendarTitle(b.work.event.summary, dict, hint.hints);
            if (parsed.ok) summary.geminiResolved++;
          }
          // none·힌트로도 유일하게 안 맞음 → 마지막 단계라 SKIPPED 로 닫는다(사유는 그 해석의 실패 사유).
          record(await settleParsed(b.work, parsed, now, deps));
        } catch (err) {
          failed(b.work.event, err);
        }
      }
    }
  }

  // ── ② 규칙 → ③ 로컬 모델(하나씩, 남은 예산 안에서) ──
  // 지난 회차에 예산이 모자라 로컬을 못 부른 행(hintStage "local")부터, 오래 기다린 순으로 — 새 일정에 밀려 매번
  // 뒤로 가면 영영 못 부른다. 그다음 새로 보거나 바뀐 일정(후보 순서).
  const carried = ruleQueue.filter((w) => w.carriedLocal);
  carried.sort((a, b) => a.row!.lastSeenAt.getTime() - b.row!.lastSeenAt.getTime());
  const ordered = [...carried, ...ruleQueue.filter((w) => !w.carriedLocal)];
  // 로컬 서버가 일시 장애(연결 거부·5xx·제 시간 제한을 다 쓰고 끊김)면 이 회차엔 더 부르지 않고 바로 Gemini 단계로
  // 넘긴다 — 꺼진 서버에 제목마다 기다리면 예산만 탄다. 예산 때문에 줄인 시간 제한으로 끊긴 것은 서버 탓이 아니다.
  let localDown = false;
  for (const work of ordered) {
    try {
      if (mustDrop()) {
        summary.dropped++;
        continue;
      }
      const byRule = parseCalendarTitle(work.event.summary, dict);
      if (byRule.ok) {
        record(await settleParsed(work, byRule, now, deps));
        continue;
      }
      // 예산 판정이 먼저다 — 시간이 없어 못 부른 것은 서버 장애와 무관하게 다음 회차가 로컬부터 잇는다.
      const remaining = budgetMs - elapsed();
      if (remaining < LOCAL_MIN_REMAINING_MS) {
        record(await saveAwaiting(work, "local", now, deps));
        continue;
      }
      if (localDown) {
        record(await saveAwaiting(work, "gemini", now, deps));
        continue;
      }
      const timeoutMs = Math.min(LOCAL_HINT_TIMEOUT_MS, remaining - LOCAL_TIMEOUT_MARGIN_MS);
      const local = await deps.extractHintsLocal(work.event.summary, { timeoutMs });
      if (local.kind === "unavailable") {
        if (timeoutMs < LOCAL_HINT_TIMEOUT_MS) {
          // 예산 때문에 줄인 시간 제한 — 끊긴 것이 서버 장애라고 볼 수 없다. 차단기를 올리지 않고 다음 회차가 로컬부터.
          record(await saveAwaiting(work, "local", now, deps));
          continue;
        }
        localDown = true;
      }
      if (local.kind === "hints") {
        const byLocal = parseCalendarTitle(work.event.summary, dict, local.hints);
        if (byLocal.ok) {
          summary.localResolved++;
          record(await settleParsed(work, byLocal, now, deps));
          continue;
        }
      }
      // 로컬이 못 풀었다(none·일시 장애·힌트로도 유일하게 안 맞음) — 다음 회차 Gemini 일괄로.
      record(await saveAwaiting(work, "gemini", now, deps));
    } catch (err) {
      failed(work.event, err);
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
function parsedColumn(value: InboundRowWrite["parsed"]) {
  if (value === undefined) return undefined;
  const sqlite = isSqliteDatabaseUrl();
  if (value === null) return sqlite ? null : Prisma.DbNull;
  return (sqlite ? JSON.stringify(value) : value) as unknown as Prisma.InputJsonValue;
}

function defaultDeps(): CalendarInboundScanDeps {
  return {
    listCandidates: listAllDayCandidateEvents,
    loadDictionary: () => loadInboundDictionary(getPrisma()),
    extractHintsLocal: (summary, { timeoutMs }) => extractTitleHintsLocal(summary, { timeoutMs }),
    extractHintsBatch: (items, { timeoutMs }) => extractTitleHintsBatch(items, { totalTimeoutMs: timeoutMs }),
    resolveTarget: (intent, event) => resolveInboundTarget(intent, event, getPrisma()),
    createProposal: (data) => ActionProposalRepository.create(data),
    findRows: (googleEventIds) =>
      getPrisma().calendarInboundEvent.findMany({
        where: { googleEventId: { in: googleEventIds } },
        select: {
          id: true,
          googleEventId: true,
          fingerprint: true,
          status: true,
          skipReason: true,
          proposalId: true,
          parsed: true,
          lastSeenAt: true,
          updatedAt: true,
        },
      }),
    findProposalStatuses: async (proposalIds) => {
      const rows = await getPrisma().actionProposal.findMany({
        where: { id: { in: proposalIds } },
        select: { id: true, status: true },
      });
      return new Map(rows.map((row) => [row.id, row.status]));
    },
    saveRow: async (googleEventId, write, expected) => {
      const data = { ...write, parsed: parsedColumn(write.parsed) } as Prisma.CalendarInboundEventUpdateInput;
      if (expected) {
        // 판을 직접 정해 적는다 — 다음 조건부 쓰기의 기준을 다시 읽지 않고 안다.
        const updatedAt = new Date();
        const { count } = await getPrisma().calendarInboundEvent.updateMany({
          where: { id: expected.id, updatedAt: expected.updatedAt },
          data: { ...data, updatedAt } as Prisma.CalendarInboundEventUpdateManyMutationInput,
        });
        return count === 1 ? { id: expected.id, updatedAt } : null;
      }
      return getPrisma().calendarInboundEvent.upsert({
        where: { googleEventId },
        create: { ...data, googleEventId } as Prisma.CalendarInboundEventCreateInput,
        update: data,
        select: { id: true, updatedAt: true },
      });
    },
    touchRows: async (rowIds, lastSeenAt) => {
      await getPrisma().calendarInboundEvent.updateMany({ where: { id: { in: rowIds } }, data: { lastSeenAt } });
    },
  };
}
