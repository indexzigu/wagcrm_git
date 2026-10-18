import type { CronErrorKind } from "@/lib/cron-error-kind";
import type { IncidentKind } from "@/lib/cron-incident";
import { incidentCauseLabel, kstDateTime, kstTime } from "@/lib/cron-incident-report";
import { ownerActionFor } from "@/lib/cron-incident-escalation";
import { KNOWN_JOBS } from "@/lib/cron-jobs";
import { UNKNOWN_NAME } from "@/lib/display-label";

/**
 * 자동화 작업 사고 → 오너 화면(크론 자가 복구 2단계). 홈 「오늘 처리할 일」의 「자동화 작업 조치대기」 줄과
 * 설정 「자동화 작업 상태」 설명창의 「이상 기록」이 이 파일 하나로 묶기·정렬·시각을 정한다(client-safe 순수 함수).
 * 원인 낱말은 알림과 같은 `incidentCauseLabel` 이다 — 여기서 원인 문구를 다시 짓지 말 것.
 */

/**
 * `GET /api/system/incidents` 가 내려보내는 칸 — 라우트의 `select` 가 이 목록에서 나온다.
 * ⛔ `lastMessage` 는 넣지 않는다: 실패 원문이라 프록시 주소·토큰이 섞여 있을 수 있다(계약 테스트가 고정).
 */
export const AUTOMATION_INCIDENT_FIELDS = [
  "id",
  "jobKey",
  "kind",
  "errorKind",
  "status",
  "ownerAction",
  "firstSeenAt",
  "normalizedAt",
  "occurrences",
] as const;

export type IncidentStatus = "open" | "waiting_owner" | "resolved";

/** API 응답 한 줄(시각은 JSON 이라 ISO 문자열). */
export type AutomationIncident = {
  id: string;
  jobKey: string;
  kind: IncidentKind;
  errorKind: CronErrorKind | null;
  status: IncidentStatus;
  ownerAction: string | null;
  firstSeenAt: string;
  normalizedAt: string | null;
  occurrences: number;
};

/** 사고 상태 낱말(용어집 「자동화 작업 사고 상태」). 붙여 쓴 한 낱말. */
export const INCIDENT_STATUS_LABELS: Readonly<Record<IncidentStatus, string>> = {
  waiting_owner: "조치대기",
  open: "재확인중",
  resolved: "정상화",
};

/** 작업 이름 — 목록(KNOWN_JOBS)에 없는 작업은 영문 키 대신 「알 수 없음」(화면 문구 기준 ③). */
export function automationJobName(jobKey: string): string {
  return KNOWN_JOBS.find((job) => job.key === jobKey)?.name ?? UNKNOWN_NAME;
}

const time = (iso: string) => new Date(iso).getTime();

/** 조치대기 사고의 할 일 한 문장 — 장부에 적힌 문장, 없으면 알림과 같은 규칙(`ownerActionFor`)으로. */
export function incidentOwnerAction(i: Pick<AutomationIncident, "kind" | "errorKind" | "ownerAction">): string {
  return i.ownerAction || ownerActionFor({ kind: i.kind, errorKind: i.errorKind });
}

/**
 * 「오늘 처리할 일」 줄의 건수·세부. 건수는 **조치대기 사고가 있는 작업 수**(같은 작업의 사고 여러 건은 한 일).
 * 세부: 작업 1개면 「작업 이름 · 원인」, 여럿이면 「가장 오래된 작업 이름 외 N건」. 조치 문장은 싣지 않는다
 * (줄은 「무엇이 몇 건」만 — 할 일은 설명창이 말한다). 조치대기가 없으면 null.
 */
export function summarizeWaitingJobs(
  incidents: readonly AutomationIncident[],
): { jobCount: number; detail: string } | null {
  // 작업마다 가장 오래된 조치대기 사고 하나
  const oldestByJob = new Map<string, AutomationIncident>();
  for (const i of incidents) {
    if (i.status !== "waiting_owner") continue;
    const prev = oldestByJob.get(i.jobKey);
    if (!prev || time(i.firstSeenAt) < time(prev.firstSeenAt)) oldestByJob.set(i.jobKey, i);
  }
  if (oldestByJob.size === 0) return null;
  const jobs = [...oldestByJob.values()].sort((a, b) => time(a.firstSeenAt) - time(b.firstSeenAt));
  const oldest = jobs[0];
  const name = automationJobName(oldest.jobKey);
  const detail =
    jobs.length === 1 ? `${name} · ${incidentCauseLabel(oldest.kind, oldest.errorKind)}` : `${name} 외 ${jobs.length - 1}건`;
  return { jobCount: jobs.length, detail };
}

/**
 * 「이상 기록」 줄의 보조 글(KST). 조치대기·재확인중 = 「MM-DD HH:mm 시작」(2회 이상이면 「 · N회」),
 * 정상화 = 「MM-DD HH:mm 시작 · HH:mm 정상화」.
 */
export function incidentTimeText(i: AutomationIncident): string {
  const start = `${kstDateTime(new Date(i.firstSeenAt))} 시작`;
  if (i.status === "resolved") {
    return i.normalizedAt ? `${start} · ${kstTime(new Date(i.normalizedAt))} 정상화` : start;
  }
  return i.occurrences >= 2 ? `${start} · ${i.occurrences}회` : start;
}

const DETAIL_MAX_LINES = 3;
const STATUS_ORDER: Readonly<Record<IncidentStatus, number>> = { waiting_owner: 0, open: 1, resolved: 2 };

/**
 * 「이상 기록」에 보일 줄. 정렬 = 조치대기(오래된 순) → 재확인중(오래된 순) → 정상화(최근 순).
 * 최대 3줄이되 **조치대기는 자르지 않는다**(오너가 손볼 일이 「외 N건」 속에 숨으면 안 된다).
 */
export function incidentDetailLines(incidents: readonly AutomationIncident[]): {
  shown: AutomationIncident[];
  hiddenCount: number;
} {
  const sorted = [...incidents].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "resolved") return time(b.normalizedAt ?? b.firstSeenAt) - time(a.normalizedAt ?? a.firstSeenAt);
    return time(a.firstSeenAt) - time(b.firstSeenAt);
  });
  const waitingCount = sorted.filter((i) => i.status === "waiting_owner").length;
  const take = Math.max(DETAIL_MAX_LINES, waitingCount);
  return { shown: sorted.slice(0, take), hiddenCount: Math.max(0, sorted.length - take) };
}
