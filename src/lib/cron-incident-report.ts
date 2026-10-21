import type { CronErrorKind } from "@/lib/cron-error-kind";
import type { IncidentKind } from "@/lib/cron-incident";
import { ownerActionFor } from "@/lib/cron-incident-escalation";
import { toKstYmd } from "@/lib/date-utils";

/**
 * 사고 장부 → 오너 알림 문구(크론 자가 복구 2단계). 순수 함수만 둔다 — 조회·확인 표시는
 * `/api/cron/incident-outbox` 라우트가 하고, 호스트 스크립트가 그 목록을 받아 텔레그램으로 보낸다.
 * 시각은 UTC 로 저장돼 있고 문구는 KST 로 쓴다. 오너가 그대로 읽는 글자라 긴 줄표·영문 코드를 넣지 않는다.
 */

export type OutboxMessage = {
  key: string;
  icon: "🙋" | "✅" | "📋";
  title: string;
  detail: string;
  /** 보낸 뒤 POST 로 「보냈음」을 찍을 칸 */
  ackField: "alertedAt" | "recoveryAlertedAt" | "digestedAt";
  /** 즉시·정상화 알림은 1건, 묶음 알림은 실린 정상화 사고 전부 */
  incidentIds: string[];
};

/** 문구에 필요한 사고 칸(CronIncident 의 부분집합) */
export type ReportIncident = {
  id: string;
  jobKey: string;
  kind: IncidentKind;
  errorKind: CronErrorKind | null;
  firstSeenAt: Date;
  ownerAction: string | null;
  /** 플레이북이 정한 원인(4단계) — 없으면 오류 종류 라벨 */
  cause?: string | null;
  /** 「확정」|「후보」 */
  causeConfidence?: string | null;
  prNumber: number | null;
  normalizedAt: Date | null;
  normalizedEvidence: unknown;
  actions: unknown;
};

export type DigestIncident = ReportIncident & { jobName: string };

const CAUSE_BY_ERROR_KIND: Readonly<Record<CronErrorKind, string>> = {
  network: "네트워크 끊김",
  timeout: "시간 초과",
  upstream_5xx: "외부 서버 오류",
  proxy_quota: "프록시 한도 소진",
  auth: "인증 실패",
  rate_limit: "호출 한도 초과",
  config: "설정·접속 오류",
  app_down: "서버 응답 없음",
  unknown: "원인 불명",
};
const UNKNOWN_CAUSE = "원인 불명";

/** 사고 원인 낱말 — 즉시 알림·묶음 알림·설명창이 이 함수 하나를 쓴다(용어집 「자동화 작업 원인」). */
export function incidentCauseLabel(kind: IncidentKind, errorKind: CronErrorKind | null): string {
  if (kind === "B") return "결과 0건";
  return (errorKind && CAUSE_BY_ERROR_KIND[errorKind]) || UNKNOWN_CAUSE;
}

/**
 * 원인 칸에 쓸 글자 — 승격 때 플레이북이 원인을 정했으면 「확정 프록시 월 한도 소진」처럼 확신과 함께, 아니면
 * `incidentCauseLabel`. 즉시 알림·묶음 알림·오늘 처리할 일·설명창이 이 함수 하나를 쓴다.
 * 원인 글자는 플레이북의 고정 문장(키 이름·건수만 끼움)이라 원문이 섞이지 않는다(`cron-incident-playbook.ts`).
 */
export function incidentCauseText(i: {
  kind: IncidentKind;
  errorKind: CronErrorKind | null;
  cause?: string | null;
  causeConfidence?: string | null;
}): string {
  const cause = i.cause?.trim();
  if (!cause) return incidentCauseLabel(i.kind, i.errorKind);
  return i.causeConfidence === "확정" || i.causeConfidence === "후보" ? `${i.causeConfidence} ${cause}` : cause;
}

const KST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `HH:mm`(KST) — 설명창 「이상 기록」도 같은 표기를 쓴다(`automation-incidents.ts`). */
export function kstTime(d: Date): string {
  return KST_TIME.format(d);
}

/** `MM-DD HH:mm`(KST) */
export function kstDateTime(d: Date): string {
  const [, mm, dd] = toKstYmd(d).split("-");
  return `${mm}-${dd} ${kstTime(d)}`;
}

/** 오늘(KST)이면 `HH:mm`, 아니면 `MM-DD HH:mm` */
function kstTimeOrDateTime(d: Date, now: Date): string {
  return toKstYmd(d) === toKstYmd(now) ? kstTime(d) : kstDateTime(d);
}

function actionFor(i: ReportIncident): string {
  return i.ownerAction || ownerActionFor({ kind: i.kind, errorKind: i.errorKind });
}

export function formatImmediate(i: ReportIncident, jobName: string): OutboxMessage {
  const lines = i.kind === "B" ? [] : [`원인: ${incidentCauseText(i)}`];
  lines.push(`조치: ${actionFor(i)}`);
  if (i.prNumber != null) lines.push(`PR #${i.prNumber}`);
  return {
    key: `incident-${i.id}`,
    icon: "🙋",
    title: `${jobName} 조치대기`,
    detail: lines.join("\n"),
    ackField: "alertedAt",
    incidentIds: [i.id],
  };
}

/** 정상으로 돌아온 실행 시각 — 정상화 증거의 runAt, 없으면 정상화 시각 */
function recoveryRunAt(i: ReportIncident, now: Date): Date {
  const evidence = i.normalizedEvidence as { runAt?: unknown } | null | undefined;
  if (evidence && typeof evidence.runAt === "string") {
    const runAt = new Date(evidence.runAt);
    if (!Number.isNaN(runAt.getTime())) return runAt;
  }
  return i.normalizedAt ?? now;
}

export function formatRecovery(i: ReportIncident, jobName: string, now: Date = new Date()): OutboxMessage {
  return {
    key: `incident-${i.id}-ok`,
    icon: "✅",
    title: `${jobName} 정상화`,
    detail: `${kstTimeOrDateTime(recoveryRunAt(i, now), now)} 실행부터 정상입니다.`,
    ackField: "recoveryAlertedAt",
    incidentIds: [i.id],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_MAX_LINES = 15;
const WAITING_DAYS_NOTE_AFTER = 7;

/**
 * 묶음 알림 창 — 가장 최근에 지난 KST 08:00 이 끝, 그 24시간 전이 시작.
 * 08:00 전에 불려도 아직 오지 않은 08:00 을 끝으로 잡지 않는다(그러면 창이 미래로 열린다).
 */
export function digestWindow(now: Date): { start: Date; end: Date } {
  let end = new Date(`${toKstYmd(now)}T08:00:00+09:00`);
  if (end.getTime() > now.getTime()) end = new Date(end.getTime() - DAY_MS);
  return { start: new Date(end.getTime() - DAY_MS), end };
}

/** 사고에 기록된 마지막 조치(`actions` 의 마지막 `what`) */
function lastActionWhat(actions: unknown): string | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const what = (actions[actions.length - 1] as { what?: unknown } | null)?.what;
  return typeof what === "string" && what.trim() ? what.trim() : null;
}

/** 자동 재시도 회차(2 이상)가 정상으로 끝나 닫힌 사고인가 — 정상화 증거의 `attempt`(`resolveOpenIncidents`). */
function resolvedByRetry(evidence: unknown): boolean {
  const attempt = (evidence as { attempt?: unknown } | null | undefined)?.attempt;
  return typeof attempt === "number" && attempt > 1;
}

const RETRY_RESOLVED_ACTION = "자동 재시도로 정상화";

function resolvedLine(i: DigestIncident): string {
  const parts = [`${kstDateTime(i.firstSeenAt)} ${i.jobName}`, incidentCauseText(i)];
  // 기록된 조치가 있으면 그것이 우선이다 — 재시도 문구는 사람이·플레이북이 한 일이 없을 때만 채운다.
  const action = lastActionWhat(i.actions) ?? (resolvedByRetry(i.normalizedEvidence) ? RETRY_RESOLVED_ACTION : null);
  if (action) parts.push(action);
  parts.push(`정상화 ${i.normalizedAt ? kstTime(i.normalizedAt) : "시각 모름"}`);
  return parts.join(" · ");
}

function waitingLine(i: DigestIncident, now: Date): string {
  const days = Math.floor((now.getTime() - i.firstSeenAt.getTime()) / DAY_MS);
  const age = days > WAITING_DAYS_NOTE_AFTER ? ` (${days}일째)` : "";
  return `${i.jobName} · ${incidentCauseText(i)}${age}`;
}

/**
 * 하루 한 번 묶음 알림. 정상화·조치대기가 모두 0이면 null — 「알림 직전에 막은 건」만으로는 보내지 않는다.
 * 사고 줄은 합쳐 15줄까지만 싣고 나머지는 「외 N건」으로 접는다(머리 줄은 세지 않는다).
 * 확인 표시(`incidentIds`)는 정상화 사고만 — 조치대기 사고에 찍으면 나중에 정상화돼도 묶음에서 빠진다.
 */
export function formatDigest(
  resolved: DigestIncident[],
  waiting: DigestIncident[],
  suppressedCount: number,
  now: Date,
): OutboxMessage | null {
  // C(알림 자체가 틀림)는 내부 기록이라 줄로 싣지 않는다 — 막은 건 개수로만 보인다.
  const shownResolved = resolved.filter((i) => i.kind !== "C");
  const shownWaiting = waiting.filter((i) => i.kind !== "C");
  if (shownResolved.length === 0 && shownWaiting.length === 0) return null;

  const lines: string[] = [];
  let budget = DIGEST_MAX_LINES;
  let hidden = 0;
  const section = (header: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(header);
    const take = Math.max(0, Math.min(budget, items.length));
    lines.push(...items.slice(0, take));
    budget -= take;
    hidden += items.length - take;
  };
  section(`정상화 ${shownResolved.length}건`, shownResolved.map(resolvedLine));
  section(`조치대기 ${shownWaiting.length}건`, shownWaiting.map((i) => waitingLine(i, now)));
  if (hidden > 0) lines.push(`외 ${hidden}건`);
  if (suppressedCount > 0) lines.push(`알림 직전에 정상화돼 보내지 않은 건 ${suppressedCount}건`);

  return {
    key: "digest-incident",
    icon: "📋",
    title: "지난 24시간 자동화 작업",
    detail: lines.join("\n"),
    ackField: "digestedAt",
    incidentIds: shownResolved.map((i) => i.id),
  };
}
