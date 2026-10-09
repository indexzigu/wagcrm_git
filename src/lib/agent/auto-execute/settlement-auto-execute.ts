/**
 * 정산 금액 수정 자동 실행기 — 한 회차(2분마다, `/api/cron/agent-auto-execute`).
 *
 * 설계 정본: Hermes `docs/wag-bridge-phase2-plan.md` §3·§4·§5 B(오너 결정 2026-10-09 —
 * 「중요한 것은 데일리로 승인하고 한도 안은 자동 작업 후 결과보고만」). 일반 자동승인 정책
 * (`approval-policy.ts`)에서 `settlement_amount_update` 는 여전히 수동이다 — 이 전용 실행기만
 * **슬랙 원문으로 확인된 Muse 요청 중 한도 안**인 것을 사람 대신 승인한다.
 *
 * ## 무엇을 집는가 (전부 만족해야 후보)
 * - 상태 PENDING_APPROVAL · `createdBy` = "AGENT_WORKER" · `requestType` = settlement_amount_update
 *   · `sourceRef.slack` 있음 · 생성 후 `CANDIDATE_MAX_AGE_MS` 안.
 *   APPROVED·FAILED·그 밖의 상태는 건드리지 않는다(아래 멈춘 승인 정리만 예외).
 * - 같은 rid 의 기안이 둘 이상이면 **가장 먼저 만든 1건**만 후보, 나머지는 `duplicate_rid` 로 남긴다.
 *
 * ## 판정 순서 (하나라도 어긋나면 PENDING 그대로 — 자동 반려 없음)
 * payload 모양 → rid 중복 → |변동| 한도 → 채널 → 슬랙 원문(작성자 3중 일치 · 수정·subtype 없음 ·
 * `muse-req` 의 rid·action·params 정확 일치 · 메시지 시각이 기안 생성 전 N분 안) → 하루 건수.
 * 한도·모양처럼 슬랙 없이 가를 수 있는 것을 먼저 봐서 슬랙 호출을 줄인다.
 *
 * ## 판정 기록 (`ActionProposalEvent`, PENDING→PENDING)
 * - 회차 모드의 actor(`SYSTEM_AUTO` / 그림자면 `SYSTEM_AUTO_SHADOW`)로 note
 *   `[auto-execute] verdict=<판정>; <사유>` 를 남긴다.
 * - **확정 판정**(보류가 아닌 것)은 기안당 1건 — 이미 있으면 그 기안은 이 모드에서 다시 보지 않는다
 *   (일일 승인으로 간다). 그림자 모드의 확정 판정(`would_execute` 포함)이 곧 「기안당 1회 그림자 기록」이다.
 * - **보류 판정**(`not_configured` · `no_token` · `slack_error`)은 다음 회차에 다시 본다. 같은 보류
 *   판정은 기안당 1건만 남긴다(2분마다 쌓이지 않게 — 기록 상한).
 *
 * ## 하루 건수 (Asia/Seoul 자정 기준, CRM DB 가 정본)
 * - on: 오늘 `SYSTEM_AUTO` 가 이 requestType 기안을 APPROVED 로 옮긴 이벤트 수. 그 뒤 EXECUTED 든
 *   FAILED 든 센다(승인한 시도 수가 상한이다 — 진행 중 APPROVED 도 센다).
 *   ℹ️ `ActionProposal.approvedBy/approvedAt` 칸은 이 레포의 어떤 경로도 쓰지 않아(전수 확인) 이벤트로 센다.
 * - shadow: 오늘 남긴 `would_execute` 그림자 판정 수 — 그림자 중에도 한도가 실제로 걸리는지 본다.
 *
 * ## 단일 실행
 * 회차 전체를 잠금 안에서 돈다 — 겹친 회차는 아무것도 안 하고 끝난다(건수·rid 검사가 경쟁하지 않게).
 * - Postgres: `pg_try_advisory_xact_lock(고정 키)` 를 **긴 트랜잭션 하나**가 쥔다. 세션 잠금
 *   (`pg_try_advisory_lock`)을 쓰지 않는 이유: Prisma 는 연결 풀이라 잠금·해제가 다른 연결로 갈 수
 *   있고, 그러면 해제가 실패해 잠금이 그 연결에 영원히 남는다. 트랜잭션 잠금은 커밋·롤백·연결
 *   끊김에서 반드시 풀린다. 회차 본문은 그 트랜잭션이 아니라 일반 클라이언트로 돈다(승인 SSOT 가
 *   자기 트랜잭션을 열기 때문). 트랜잭션 시간 제한보다 회차 예산(`PASS_BUDGET_MS`)이 훨씬 짧다 —
 *   시간 제한이 먼저 오면 잠금이 풀린 채 본문이 돌 수 있으므로 그 순서를 지킨다.
 * - sqlite(개발·테스트 전용, 단일 프로세스): 같은 프로세스 안의 플래그로 대신한다.
 *
 * ## 멈춘 승인 정리
 * `SYSTEM_AUTO` 가 승인했는데 10분 넘게 APPROVED 인 기안(승인과 실행 사이에서 프로세스가 죽은 경우)은
 * 저장소의 CAS 전이로 FAILED("자동 실행 중단")로 보낸다. 재승인은 오너가 결재함에서 한다.
 *
 * ## 실행
 * `approveProposal(id, "SYSTEM_AUTO", { expectedStatus: "PENDING_APPROVAL" })` — 승인 로직을 여기서
 * 다시 만들지 않는다. 실행 순간의 가드(현재 값 = expectedCurrentKrw · 정산 확정 전 · 품목 있는
 * 총 거래액 거부)는 실행 동작(`update-settlement-amount.ts`)이 그대로 건다 — 현재 값을 속인 요청은
 * 변동이 넓어지는 대신 실행이 실패한다(FAILED).
 */
import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import { AgentJobSlackOriginSchema, updateSettlementAmountArgsSchema } from "@/lib/agent-worker/contracts";
import { approveProposal } from "@/lib/agent/approve-proposal";
import { getRequestTypeForAction } from "@/lib/agent/approval-policy";
import { startOfKstDayMs } from "@/lib/order-converter/sale-window";
import { ActionProposalRepository, ConcurrentModificationError } from "@/repositories/actionProposalRepository";
import { parseStoredJsonObject } from "@/lib/stored-json";
import {
  missingVerificationSettings,
  readAutoExecuteConfig,
  type AutoExecuteConfig,
  type AutoExecuteMode,
} from "./config";
import {
  checkMuseAuthorship,
  diffSettlementParams,
  fetchSlackSourceMessage,
  parseMuseRequestBlock,
  parseRequestExpiry,
  slackTsToMs,
  type FetchLike,
} from "./slack-source";

export const AUTO_EXECUTE_ACTOR = "SYSTEM_AUTO";
export const AUTO_EXECUTE_SHADOW_ACTOR = "SYSTEM_AUTO_SHADOW";
export const SETTLEMENT_ACTION = "update_settlement_amount";
export const SETTLEMENT_REQUEST_TYPE = getRequestTypeForAction(SETTLEMENT_ACTION);
export const MUSE_SETTLEMENT_ACTION = "crm.update_settlement_amount";
const BRIDGE_CREATOR = "AGENT_WORKER";

/** 판정 기록 note 의 머리. 하루 건수 집계(그림자)가 이 글자로 찾는다 — 바꾸면 집계가 깨진다. */
export const VERDICT_NOTE_PREFIX = "[auto-execute] verdict=";
export const STUCK_APPROVED_NOTE = "자동 실행 중단";

/** 이보다 오래된 대기 기안은 자동 실행하지 않는다(사람 몫) — 스위치를 켠 순간 묵은 기안이 실행되지 않게. */
export const CANDIDATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 한 회차에 판정할 최대 후보 수. */
export const MAX_CANDIDATES_PER_PASS = 10;
/** 이 시간이 지나면 새 후보를 시작하지 않는다(잠금 트랜잭션 시간 제한보다 훨씬 짧게). */
export const PASS_BUDGET_MS = 60_000;
const LOCK_TX_TIMEOUT_MS = 240_000;
/** APPROVED 로 이만큼 멈춘 `SYSTEM_AUTO` 기안은 FAILED 로 보낸다. */
export const STUCK_APPROVED_MS = 10 * 60 * 1000;
/** 고정 잠금 키(두 int4). 다른 잠금(`hashtext(...)` 계열)과 겹치지 않게 작은 상수 쌍을 쓴다. */
const LOCK_KEY_CLASS = 7_301;
const LOCK_KEY_OBJECT = 1;
const DETAIL_MAX_CHARS = 300;

/** 다음 회차에 다시 보는 판정. 나머지는 확정이다. */
const TRANSIENT_VERDICTS = new Set(["not_configured", "no_token", "slack_error"]);

export type Verdict =
  | "would_execute"
  | "not_configured"
  | "no_token"
  | "slack_error"
  | "bad_payload"
  | "bad_source_ref"
  | "duplicate_rid"
  | "over_delta"
  | "wrong_channel"
  | "message_not_found"
  | "not_muse"
  | "edited"
  | "has_subtype"
  | "bad_request_block"
  | "rid_mismatch"
  | "action_mismatch"
  | "params_mismatch"
  | "outside_window"
  | "not_live_request"
  | "daily_limit";

export type AutoExecutePassResult = {
  mode: AutoExecuteMode;
  /** false = 스위치 off 이거나 다른 회차가 잠금을 쥐고 있어 아무것도 안 했다. */
  ran: boolean;
  lockBusy: boolean;
  candidates: number;
  /** 이번 회차에 새로 남긴 판정 기록 수. */
  recorded: number;
  /** 이번 회차의 판정 분포(새로 남기지 않은 보류 판정 포함). */
  verdicts: Record<string, number>;
  executed: number;
  executionFailed: number;
  skipped: number;
  swept: number;
  errors: number;
  /** 예산·후보 상한으로 이번 회차에 못 본 후보 수(다음 회차에 본다). */
  deferred: number;
  /** true = 판정·실행·정리가 하나도 없었다 — 관측 기록은 상태만 갱신하고 이력 줄을 남기지 않는다. */
  quiet: boolean;
};

type CandidateRow = {
  id: string;
  createdAt: Date;
  payload: unknown;
  sourceRef: unknown;
  events: { note: string | null }[];
};

type Judgement = { verdict: Verdict; detail: string } | { verdict: "eligible" };

function readVerdict(note: string | null): string | null {
  if (!note || !note.startsWith(VERDICT_NOTE_PREFIX)) return null;
  const m = /^([a-z_]+)/.exec(note.slice(VERDICT_NOTE_PREFIX.length));
  return m ? m[1] : null;
}

// Json 칸 읽기는 `parseStoredJsonObject`(SSOT) — SQLite 레인은 문자열로 저장된다(저장소 이원화).
function readSlackRef(sourceRef: unknown) {
  const parsed = AgentJobSlackOriginSchema.safeParse(parseStoredJsonObject(sourceRef).slack);
  return parsed.success ? parsed.data : null;
}

function hasSlackRef(sourceRef: unknown): boolean {
  return parseStoredJsonObject(sourceRef).slack != null;
}

type SettlementArgs = {
  campaignId: string;
  field: string;
  expectedCurrentKrw: number | null;
  newAmountKrw: number;
  memo?: string;
};

function readSettlementPayload(payload: unknown): { args: SettlementArgs; raw: Record<string, unknown> } | null {
  const value = parseStoredJsonObject(payload);
  if (value.action !== SETTLEMENT_ACTION) return null;
  const raw = value.args;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = updateSettlementAmountArgsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { args: parsed.data as SettlementArgs, raw: raw as Record<string, unknown> };
}

/** 같은 rid 의 기안 중 가장 먼저 만든 것(동률이면 id 순). 상태를 가리지 않는다 — 재사용 차단. */
async function loadEarliestByRid(): Promise<Map<string, string>> {
  const rows = await getPrisma().actionProposal.findMany({
    where: { requestType: SETTLEMENT_REQUEST_TYPE, createdBy: BRIDGE_CREATOR },
    select: { id: true, createdAt: true, sourceRef: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const earliest = new Map<string, string>();
  for (const row of rows) {
    const slack = readSlackRef(row.sourceRef);
    if (!slack) continue;
    if (!earliest.has(slack.rid)) earliest.set(slack.rid, row.id);
  }
  return earliest;
}

async function countToday(mode: "shadow" | "on", now: Date): Promise<number> {
  const dayStart = new Date(startOfKstDayMs(now.getTime()));
  const prisma = getPrisma();
  if (mode === "on") {
    return prisma.actionProposalEvent.count({
      where: {
        actor: AUTO_EXECUTE_ACTOR,
        toStatus: "APPROVED",
        createdAt: { gte: dayStart },
        proposal: { requestType: SETTLEMENT_REQUEST_TYPE },
      },
    });
  }
  return prisma.actionProposalEvent.count({
    where: {
      actor: AUTO_EXECUTE_SHADOW_ACTOR,
      note: { startsWith: `${VERDICT_NOTE_PREFIX}would_execute` },
      createdAt: { gte: dayStart },
      proposal: { requestType: SETTLEMENT_REQUEST_TYPE },
    },
  });
}

/** 슬랙까지 가기 전·후의 모든 판정(하루 건수 제외). */
async function judgeCandidate(
  row: CandidateRow,
  config: AutoExecuteConfig,
  earliestByRid: Map<string, string>,
  fetchImpl: FetchLike,
  now: Date,
): Promise<Judgement> {
  const payload = readSettlementPayload(row.payload);
  if (!payload) return { verdict: "bad_payload", detail: "정산 금액 수정 payload 모양이 아닙니다" };

  const slack = readSlackRef(row.sourceRef);
  if (!slack) return { verdict: "bad_source_ref", detail: "슬랙 출처 칸 모양이 올바르지 않습니다" };

  if (earliestByRid.get(slack.rid) !== row.id) {
    return { verdict: "duplicate_rid", detail: "같은 rid 의 더 먼저 만든 기안이 있습니다" };
  }

  const missing = missingVerificationSettings(config);
  if (missing.length > 0) {
    return { verdict: "not_configured", detail: `설정 없음·잘못됨: ${missing.join(", ")}` };
  }
  const maxDelta = config.maxAbsDeltaKrw as number;
  const windowMs = (config.messageWindowMinutes as number) * 60_000;

  const delta = Math.abs(payload.args.newAmountKrw - (payload.args.expectedCurrentKrw ?? 0));
  if (delta > maxDelta) {
    return {
      verdict: "over_delta",
      detail: `변동 ${delta.toLocaleString("ko-KR")}원이 한도 ${maxDelta.toLocaleString("ko-KR")}원을 넘습니다`,
    };
  }

  if (slack.channelId !== config.channelId) {
    return { verdict: "wrong_channel", detail: "출처 채널이 브리지 채널이 아닙니다" };
  }

  if (!config.slackToken) return { verdict: "no_token", detail: "SLACK_BRIDGE_READ_TOKEN 이 설정되지 않았습니다" };

  const fetched = await fetchSlackSourceMessage({
    fetchImpl,
    token: config.slackToken,
    channelId: slack.channelId,
    threadTs: slack.threadTs,
    messageTs: slack.messageTs,
  });
  if (fetched.kind === "error") return { verdict: "slack_error", detail: `슬랙 조회 실패(${fetched.code})` };
  if (fetched.kind === "not_found") return { verdict: "message_not_found", detail: "출처 위치에 메시지가 없습니다" };

  const authorship = checkMuseAuthorship(fetched.message, {
    identity: {
      botId: config.museBotId as string,
      appId: config.museAppId as string,
      userId: config.museUserId as string,
    },
    threadTs: slack.threadTs,
    messageTs: slack.messageTs,
  });
  if (authorship) return authorship;

  const block = parseMuseRequestBlock(fetched.message.text);
  if (!block.ok) return { verdict: "bad_request_block", detail: block.detail };
  const request = block.request;
  if (request.v !== 1) return { verdict: "bad_request_block", detail: "muse-req 버전이 1 이 아닙니다" };
  if (request.rid !== slack.rid) return { verdict: "rid_mismatch", detail: "메시지의 rid 가 기안 출처와 다릅니다" };
  if (request.action !== MUSE_SETTLEMENT_ACTION) {
    return { verdict: "action_mismatch", detail: "메시지의 action 이 정산 금액 수정이 아닙니다" };
  }
  // 실행 의도가 있는 살아 있는 요청만 — 미리보기(dry_run)나 만료된 요청이 실행 열쇠가 되면 안 된다
  // (보안 리뷰 2026-10-09: 브리지가 만료로 거절한 요청을 같은 계정 코드가 대신 기안하는 경로).
  if (request.dryRun !== false) {
    return { verdict: "not_live_request", detail: "미리보기(dry_run) 요청입니다" };
  }
  const expiresMs = parseRequestExpiry(request.expiresAt);
  if (expiresMs === null || row.createdAt.getTime() > expiresMs) {
    return { verdict: "not_live_request", detail: "요청 유효 시각(expires_at)이 없거나 기안 전에 지났습니다" };
  }
  // 기안 때는 유효했어도 회차가 늦게 돌아 그 사이 만료됐으면 실행하지 않는다(GPT 리뷰 P1 2026-10-09 —
  // 맥이 잠들었다 깨는 등 회차가 밀리면 만료된 요청이 실행될 수 있었다).
  if (now.getTime() >= expiresMs) {
    return { verdict: "not_live_request", detail: "요청 유효 시각(expires_at)이 이번 회차 전에 지났습니다" };
  }
  const differing = diffSettlementParams(request.params, payload.raw);
  if (differing !== null) {
    return { verdict: "params_mismatch", detail: `메시지와 기안의 칸이 다릅니다(${differing.slice(0, 40)})` };
  }

  const messageMs = slackTsToMs(slack.messageTs);
  const createdMs = row.createdAt.getTime();
  if (messageMs === null || messageMs > createdMs || createdMs - messageMs > windowMs) {
    return { verdict: "outside_window", detail: "메시지 시각이 기안 생성 전 허용 창 밖입니다" };
  }

  return { verdict: "eligible" };
}

async function recordVerdict(
  proposalId: string,
  actor: string,
  verdict: Verdict,
  detail: string,
): Promise<void> {
  await ActionProposalRepository.appendEvent(proposalId, {
    fromStatus: "PENDING_APPROVAL",
    toStatus: "PENDING_APPROVAL",
    actor,
    note: `${VERDICT_NOTE_PREFIX}${verdict}; ${detail}`.slice(0, DETAIL_MAX_CHARS),
  });
}

/** `SYSTEM_AUTO` 가 승인했는데 오래 APPROVED 에 멈춘 기안 → FAILED. */
async function sweepStuckApproved(now: Date): Promise<{ swept: number; errors: number }> {
  const cutoff = new Date(now.getTime() - STUCK_APPROVED_MS);
  const rows = await getPrisma().actionProposal.findMany({
    where: {
      status: "APPROVED",
      requestType: SETTLEMENT_REQUEST_TYPE,
      updatedAt: { lt: cutoff },
      events: { some: { actor: AUTO_EXECUTE_ACTOR, toStatus: "APPROVED" } },
    },
    select: {
      id: true,
      events: {
        where: { toStatus: "APPROVED" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { actor: true, createdAt: true },
      },
    },
  });
  let swept = 0;
  let errors = 0;
  for (const row of rows) {
    const lastApproval = row.events[0];
    // 마지막 승인이 사람이면(자동 실패 뒤 사람이 재시도한 경우) 건드리지 않는다.
    if (!lastApproval || lastApproval.actor !== AUTO_EXECUTE_ACTOR || lastApproval.createdAt >= cutoff) continue;
    try {
      await ActionProposalRepository.transition(row.id, "FAILED", {
        actor: AUTO_EXECUTE_ACTOR,
        note: STUCK_APPROVED_NOTE,
        data: { errorMessage: STUCK_APPROVED_NOTE },
        expectedFrom: "APPROVED",
      });
      swept += 1;
    } catch (error) {
      if (error instanceof ConcurrentModificationError) continue;
      errors += 1;
      console.error(`[agent-auto-execute] 멈춘 승인 정리 실패 ${row.id}:`, error);
    }
  }
  return { swept, errors };
}

let inProcessBusy = false;

/** 회차 단일 실행 — 위 헤더 「단일 실행」. 잠금을 못 잡으면 `{ acquired: false }`. */
async function withSingleFlight<T>(work: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (isSqliteDatabaseUrl()) {
    if (inProcessBusy) return { acquired: false };
    inProcessBusy = true;
    try {
      return { acquired: true, value: await work() };
    } finally {
      inProcessBusy = false;
    }
  }
  return getPrisma().$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY_CLASS}::int, ${LOCK_KEY_OBJECT}::int) AS locked`;
      if (rows[0]?.locked !== true) return { acquired: false as const };
      return { acquired: true as const, value: await work() };
    },
    { maxWait: 10_000, timeout: LOCK_TX_TIMEOUT_MS },
  );
}

function emptyResult(mode: AutoExecuteMode, lockBusy: boolean): AutoExecutePassResult {
  return {
    mode,
    ran: false,
    lockBusy,
    candidates: 0,
    recorded: 0,
    verdicts: {},
    executed: 0,
    executionFailed: 0,
    skipped: 0,
    swept: 0,
    errors: 0,
    deferred: 0,
    quiet: true,
  };
}

export async function runSettlementAutoExecutePass(
  options: { now?: Date; env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<AutoExecutePassResult> {
  const env = options.env ?? process.env;
  const config = readAutoExecuteConfig(env);
  const mode = config.mode;
  if (mode === "off") return emptyResult("off", false);

  const now = options.now ?? new Date();
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const flight = await withSingleFlight(() => runLockedPass(mode, config, now, fetchImpl));
  return flight.acquired ? flight.value : emptyResult(mode, true);
}

async function runLockedPass(
  mode: "shadow" | "on",
  config: AutoExecuteConfig,
  now: Date,
  fetchImpl: FetchLike,
): Promise<AutoExecutePassResult> {
  const startedAt = Date.now();
  const actor = mode === "on" ? AUTO_EXECUTE_ACTOR : AUTO_EXECUTE_SHADOW_ACTOR;
  const result: AutoExecutePassResult = { ...emptyResult(mode, false), ran: true, quiet: false };

  const sweep = await sweepStuckApproved(now);
  result.swept = sweep.swept;
  result.errors += sweep.errors;

  const rows: CandidateRow[] = await getPrisma().actionProposal.findMany({
    where: {
      status: "PENDING_APPROVAL",
      createdBy: BRIDGE_CREATOR,
      requestType: SETTLEMENT_REQUEST_TYPE,
      createdAt: { gte: new Date(now.getTime() - CANDIDATE_MAX_AGE_MS) },
    },
    select: {
      id: true,
      createdAt: true,
      payload: true,
      sourceRef: true,
      events: { where: { actor }, select: { note: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // 슬랙 출처가 없는 기안은 후보가 아니다(사람 몫 — 판정 기록도 남기지 않는다).
  // 이 모드에서 확정 판정이 이미 있는 기안도 다시 보지 않는다.
  // 보류 판정을 이미 받은 기안은 뒤로 미룬다 — 계속 보류되는 기안이 회차 상한을 채워 새 기안이
  // 굶지 않게(보안 리뷰 2026-10-09). 같은 묶음 안에서는 만든 순서를 지킨다(안정 정렬).
  const pending = rows
    .filter((row) => {
      if (!hasSlackRef(row.sourceRef)) return false;
      return !row.events.some((event) => {
        const verdict = readVerdict(event.note);
        return verdict !== null && !TRANSIENT_VERDICTS.has(verdict);
      });
    })
    .sort((a, b) => Number(a.events.length > 0) - Number(b.events.length > 0));
  result.candidates = pending.length;

  if (pending.length > 0) {
    const earliestByRid = await loadEarliestByRid();
    let todayCount = await countToday(mode, now);

    for (const [index, row] of pending.entries()) {
      if (index >= MAX_CANDIDATES_PER_PASS || Date.now() - startedAt > PASS_BUDGET_MS) {
        result.deferred = pending.length - index;
        break;
      }
      try {
        let judgement = await judgeCandidate(row, config, earliestByRid, fetchImpl, now);
        if (judgement.verdict === "eligible" && todayCount >= (config.maxPerDay as number)) {
          judgement = {
            verdict: "daily_limit",
            detail: `오늘 자동 처리 ${todayCount}건으로 하루 한도 ${config.maxPerDay}건에 닿았습니다`,
          };
        }

        if (judgement.verdict === "eligible" && mode === "shadow") {
          judgement = { verdict: "would_execute", detail: "그림자 모드: 켰다면 자동 실행했을 기안입니다" };
        }

        if (judgement.verdict !== "eligible") {
          result.verdicts[judgement.verdict] = (result.verdicts[judgement.verdict] ?? 0) + 1;
          const already = row.events.some((event) => readVerdict(event.note) === judgement.verdict);
          if (!already) {
            await recordVerdict(row.id, actor, judgement.verdict, judgement.detail);
            result.recorded += 1;
          }
          if (judgement.verdict === "would_execute") todayCount += 1;
          continue;
        }

        // mode === "on" 이고 모든 조건 통과 — 승인 SSOT 로 승인+실행.
        const outcome = await approveProposal(row.id, AUTO_EXECUTE_ACTOR, { expectedStatus: "PENDING_APPROVAL" });
        if (outcome.ok) {
          result.executed += 1;
          todayCount += 1;
        } else if (outcome.code === "EXECUTION_FAILED" || outcome.code === "EMPTY_PAYLOAD") {
          // 승인은 기록됐고 실행 가드가 거부했다(FAILED) — 승인 시도이므로 하루 건수에 든다.
          result.executionFailed += 1;
          todayCount += 1;
        } else if (outcome.code === "CONFLICT" || outcome.code === "INVALID_STATUS") {
          result.skipped += 1;
        } else {
          result.errors += 1;
          console.error(`[agent-auto-execute] 승인 실패 ${row.id}: ${outcome.code}`);
        }
      } catch (error) {
        result.errors += 1;
        console.error(`[agent-auto-execute] 후보 처리 실패 ${row.id}:`, error);
      }
    }
  }

  // 못 본 후보(deferred)가 남으면 조용한 회차가 아니다 — 굶김이 이력에 드러나게 한다.
  result.quiet =
    result.deferred === 0 &&
    result.recorded === 0 &&
    result.executed === 0 &&
    result.executionFailed === 0 &&
    result.swept === 0 &&
    result.errors === 0;
  return result;
}
