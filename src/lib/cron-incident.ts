import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isRemoteDatabaseUrl } from "@/lib/prisma-client";
import { isTransientErrorKind, type CronErrorKind } from "@/lib/cron-error-kind";
import { ownerActionFor, shouldEscalate } from "@/lib/cron-incident-escalation";
import { isProxyJob, matchPlaybook, type PlaybookMatch } from "@/lib/cron-incident-playbook";
import { toKstYmd } from "@/lib/date-utils";

/**
 * 자동 작업 사고 장부 — 같은 원인의 반복 실패를 한 건의 사고로 묶는다.
 * 호출처(system-task-status 래퍼)의 응답을 막지 않도록 DB 오류는 로그만 남기고 삼키지 않되 던지지도 않는다.
 */

/** A=실패 기록, B=성공 기록인데 산출 없음, C=알림 자체가 틀림(2단계부터) */
export type IncidentKind = "A" | "B" | "C";

const SIGNATURE_MESSAGE_MAX = 200;
const LAST_MESSAGE_MAX = 1000;
const OPEN_STATUSES = ["open", "waiting_owner"];

/**
 * 「이번 재시도 주기」로 보는 창 — 재시도로 정상화됐을 때 회차·1층을 찍을 A 사고를 이 안에서 본 것으로 좁힌다.
 * 첫 실패부터 마지막 재시도 성공까지 걸릴 수 있는 최장 시간에서 나왔다: 재시도 대기
 * `RETRY_DELAYS_SEC`(600 + 1800초 = 40분) + 실행 3회 각각 최장 15분(`run-cron.sh` 의 `curl -m 900`, 45분)
 * + 앱 응답 없음 재시도 대기 2분 = 87분. 시계 오차·느린 기록을 덮도록 여유를 더해 2시간으로 둔다.
 * (`cron-incident.test.ts` 가 이 창이 위 합보다 큰지 확인한다.)
 */
export const RETRY_CYCLE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * 메시지에서 매번 달라지는 부분을 지워 같은 원인이 같은 서명이 되게 한다.
 * 순서가 의미를 가진다 — 시각·식별자를 먼저 바꿔야 그 안의 숫자가 `#` 으로 먼저 먹히지 않는다.
 */
export function normalizeIncidentMessage(message: string): string {
  return message
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<t>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\bc[a-z0-9]{24}\b/g, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/@[\w.]+/g, "@<h>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SIGNATURE_MESSAGE_MAX);
}

export function incidentSignature(input: {
  jobKey: string;
  kind: IncidentKind;
  errorKind: CronErrorKind | null;
  message: string;
}): string {
  return `${input.jobKey}|${input.kind}|${input.errorKind ?? "-"}|${normalizeIncidentMessage(input.message)}`;
}

/**
 * 사고 발생 1회를 장부에 반영한다. 같은 서명의 열린 사고가 있으면 횟수만 늘리고(opened:false),
 * 없으면 새로 연다(opened:true). DB 오류는 console.error 후 null.
 *
 * `isRetryAttempt` = 자동 재시도 회차(2회차 이상)의 실패. 열린 사고가 있으면 반복 횟수를 **올리지 않고**
 * 마지막 메시지·시각만 갱신한다(⚙️K1) — 오너 알림 기준 「같은 원인 2회 연속」의 「회」는 정기 실행
 * 기준이라, 재시도가 횟수를 올리면 정상화를 앞당기려던 장치가 알림을 앞당긴다.
 * 같은 서명의 열린 사고가 없을 때:
 *  - 이번 종류가 일시 장애면 그 작업의 열린 A 사고(마지막으로 본 것)에 접는다 — 같은 일시 장애가 메시지만
 *    바뀌어 서명이 갈라져도(시간 초과 문구가 회차마다 다르다 등) 재시도가 새 사고를 열면 「반복 1」짜리
 *    사고가 늘어 위 ⚙️K1 이 막으려던 알림 증가가 다른 문으로 들어온다.
 *  - 일시 장애가 아닌 종류(인증·설정 등)면 평소처럼 새로 연다 — 그런 원인은 첫 기록에서 바로 오너에게
 *    올라가는 것이 이미 승격 규칙(`shouldEscalate`)이라 접어서 숨길 이유가 없다.
 *  - 접을 A 가 없으면(재시도 사이에 정상화로 닫혔다 등) 평소처럼 새로 연다.
 */
export async function recordIncidentOccurrence(input: {
  jobKey: string;
  kind: IncidentKind;
  errorKind: CronErrorKind | null;
  message: string;
  at?: Date;
  isRetryAttempt?: boolean;
}): Promise<{ id: string; opened: boolean } | null> {
  try {
    const prisma = getPrisma();
    const at = input.at ?? new Date();
    const signature = incidentSignature(input);
    const lastMessage = input.message.slice(0, LAST_MESSAGE_MAX);

    // 조회→쓰기 사이에 같은 서명의 동시 기록이 끼면 사고가 둘로 갈라진다(조회 시점엔 둘 다 「없음」).
    // 같은 서명끼리만 직렬화하도록 트랜잭션 안에서 서명 해시로 자문 잠금을 잡는다(커밋 때 자동 해제).
    // sqlite(로컬 개발)에는 이 함수가 없고 단일 쓰기라 건너뛴다.
    return await prisma.$transaction(async (tx) => {
      if (isRemoteDatabaseUrl()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${signature}))`;
      }
      const existing = await tx.cronIncident.findFirst({
        where: { signature, status: { in: OPEN_STATUSES } },
        orderBy: { firstSeenAt: "desc" },
      });
      if (existing) {
        await tx.cronIncident.update({
          where: { id: existing.id },
          data: input.isRetryAttempt
            ? { lastSeenAt: at, lastMessage }
            : { occurrences: { increment: 1 }, lastSeenAt: at, lastMessage },
        });
        return { id: existing.id, opened: false };
      }

      if (input.isRetryAttempt && input.kind === "A" && input.errorKind && isTransientErrorKind(input.errorKind)) {
        // 위 서명 잠금은 서명이 같은 기록끼리만 막는다. 여기서는 서명이 **다른** 재시도 실패 둘이 동시에
        // 「접을 A 없음」을 보고 각자 새 사고를 여는 틈이 생기므로 작업 단위 잠금을 하나 더 잡는다.
        // 잠금 순서는 언제나 서명 → 작업이고 작업 잠금을 먼저 잡는 경로가 없어 교착이 생기지 않는다.
        if (isRemoteDatabaseUrl()) {
          const jobLockKey = `job:${input.jobKey}|A`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${jobLockKey}))`;
        }
        const openA = await tx.cronIncident.findFirst({
          where: { jobKey: input.jobKey, kind: "A", status: { in: OPEN_STATUSES } },
          orderBy: { lastSeenAt: "desc" },
        });
        if (openA) {
          // 정상화(`resolveOpenIncidents`)는 이 잠금을 잡지 않으므로 그 사이 닫혔을 수 있다 —
          // 아직 열린 것만 바꾸고, 바뀐 줄이 없으면 닫힌 사고를 되살리지 않고 아래에서 새로 연다.
          const folded = await tx.cronIncident.updateMany({
            where: { id: openA.id, status: { in: OPEN_STATUSES } },
            data: { lastSeenAt: at, lastMessage },
          });
          if (folded.count > 0) return { id: openA.id, opened: false };
        }
      }

      const created = await tx.cronIncident.create({
        data: {
          jobKey: input.jobKey,
          kind: input.kind,
          errorKind: input.errorKind,
          signature,
          status: "open",
          firstSeenAt: at,
          lastSeenAt: at,
          lastMessage,
        },
      });
      return { id: created.id, opened: true };
    });
  } catch (error) {
    console.error("[CronIncident] 사고 기록 실패", error);
    return null;
  }
}

/**
 * 정상 실행 증거로 그 작업의 열린(`open`·`waiting_owner`) 사고를 닫고 닫은 개수를 돌려준다.
 * PR 이 붙은 사고(`prNumber` 있음)는 닫지 않는다 — 고친 코드가 배포에 반영됐는지의 판정은 5단계 몫이다.
 * `evidence.attempt` 가 2 이상이면 자동 재시도 회차가 정상으로 끝난 것이라 증거에 회차를 남기고
 * 처리 층을 1(자동 재시도)로 찍는다 — 묶음 요약이 이것으로 「자동 재시도로 정상화」를 적는다.
 * 단 찍는 대상은 **이번 재시도 주기 안에 본 A 사고**(`lastSeenAt >= runAt - RETRY_CYCLE_WINDOW_MS`)뿐이다.
 * 같은 성공으로 함께 닫히는 B 나 어제부터 조치대기였던 A 는 재시도가 고친 것이 아니므로 평소처럼 닫는다
 * — 찍으면 묶음 요약이 오너가 손볼 일이었던 사고를 「자동 재시도로 정상화」로 적는다.
 * DB 오류는 console.error 후 0.
 */
export async function resolveOpenIncidents(input: {
  jobKey: string;
  kinds: IncidentKind[];
  evidence: { runAt: Date; produced?: number; targets?: number; attempt?: number };
}): Promise<number> {
  try {
    const prisma = getPrisma();
    const { runAt, produced, targets, attempt } = input.evidence;
    const normalizedAt = new Date();
    const evidence = { runAt: runAt.toISOString(), produced, targets };
    const where = { jobKey: input.jobKey, kind: { in: input.kinds }, status: { in: OPEN_STATUSES }, prNumber: null };
    const plainData = {
      status: "resolved",
      normalizedAt,
      normalizedEvidence: evidence as Prisma.InputJsonValue,
    };
    const retried = attempt != null && attempt > 1 && input.kinds.includes("A");
    if (!retried) {
      const result = await prisma.cronIncident.updateMany({ where, data: plainData });
      return result.count;
    }
    // 이번 재시도 주기에 본 A 를 먼저 찍어 닫고, 남은 열린 사고(B·옛 A)는 평소처럼 닫는다.
    // 첫 쓰기로 닫힌 줄은 열린 상태 조건에서 빠지므로 둘째 쓰기가 다시 건드리지 않는다.
    return await prisma.$transaction(async (tx) => {
      const stamped = await tx.cronIncident.updateMany({
        where: {
          jobKey: input.jobKey,
          kind: "A",
          status: { in: OPEN_STATUSES },
          prNumber: null,
          // 상한 runAt: 이 성공 뒤에 겹친 실행이 남긴 실패는 이번 재시도가 고친 것이 아니다.
          lastSeenAt: { gte: new Date(runAt.getTime() - RETRY_CYCLE_WINDOW_MS), lte: runAt },
        },
        data: {
          status: "resolved",
          normalizedAt,
          normalizedEvidence: { ...evidence, attempt } as Prisma.InputJsonValue,
          layer: 1,
        },
      });
      const rest = await tx.cronIncident.updateMany({ where, data: plainData });
      return stamped.count + rest.count;
    });
  } catch (error) {
    console.error("[CronIncident] 사고 종결 실패", error);
    return 0;
  }
}

/**
 * 그 작업의 그날(KST) 프록시 장부(`ProxyRequestDaily`, source `cron:<작업>`)가 「요청 > 0 이고 전부 실패」인가.
 * 대상(호스트)별 줄을 합쳐서 본다. 조회 실패는 console.error 후 null — 플레이북을 안 쓸 뿐 승격은 그대로 간다.
 */
export async function readProxyLedgerAllFailed(jobKey: string, day: string): Promise<boolean | null> {
  try {
    const rows = await getPrisma().proxyRequestDaily.findMany({
      where: { day, source: `cron:${jobKey}` },
      select: { requests: true, failures: true },
    });
    let requests = 0;
    let failures = 0;
    for (const r of rows) {
      requests += r.requests;
      failures += r.failures;
    }
    return requests > 0 && failures >= requests;
  } catch (error) {
    console.error("[CronIncident] 프록시 장부 조회 실패(플레이북 미적용, 승격은 계속)", jobKey, day, error);
    return null;
  }
}

/**
 * `open` 사고 중 승격 규칙(`shouldEscalate`)에 걸리는 것을 `waiting_owner` 로 올리고 오너 조치 문구를 붙인다.
 * 바꾼 개수를 돌려준다. 이미 올린 사고는 조회 대상이 아니라 두 번 불러도 같은 결과다.
 *
 * 알려진 원인(플레이북, `cron-incident-playbook.ts`)이면 원인·확신·그 원인의 할 일 문장을 적고 처리 층을 2로
 * 찍는다. 안 맞으면 지금처럼 종류별 일반 문장(`ownerActionFor`)이고 원인 칸은 비운다.
 * 프록시 장부는 플레이북이 아직 안 맞은 프록시 작업의 A 사고에만, 작업·날짜당 한 번 읽는다. 날짜는 사고를
 * 마지막으로 본 시각의 KST 날짜다(자정 직후 승격이 어제 실패를 오늘 장부로 판정하지 않게). 장부로 프록시
 * 한도가 확정된 사고는 일시 장애(예: 주문 동기화의 「fetch failed」)로 분류돼 있어도 첫 회에 올린다 —
 * 한도 소진은 재시도로 안 풀린다.
 * 던지지 않는다 — DB 오류는 console.error 후 0.
 */
export async function escalatePendingIncidents(now: Date): Promise<number> {
  try {
    const prisma = getPrisma();
    const rows = await prisma.cronIncident.findMany({
      where: { status: "open" },
      select: {
        id: true,
        jobKey: true,
        kind: true,
        errorKind: true,
        occurrences: true,
        lastMessage: true,
        lastSeenAt: true,
      },
    });
    const ledgerCache = new Map<string, Promise<boolean | null>>();
    const ledgerAllFailed = (jobKey: string, day: string) => {
      const key = `${jobKey}|${day}`;
      let hit = ledgerCache.get(key);
      if (!hit) {
        hit = readProxyLedgerAllFailed(jobKey, day);
        ledgerCache.set(key, hit);
      }
      return hit;
    };
    let changed = 0;
    for (const row of rows) {
      const incident = {
        kind: row.kind as IncidentKind,
        errorKind: (row.errorKind ?? null) as CronErrorKind | null,
        occurrences: row.occurrences,
      };
      const playbookInput = {
        jobKey: row.jobKey,
        kind: incident.kind,
        errorKind: incident.errorKind,
        lastMessage: row.lastMessage ?? null,
      };
      let playbook: PlaybookMatch | null = matchPlaybook(playbookInput);
      if (!playbook && incident.kind === "A" && isProxyJob(row.jobKey)) {
        const day = toKstYmd(row.lastSeenAt ?? now);
        const allFailed = await ledgerAllFailed(row.jobKey, day);
        if (allFailed) playbook = matchPlaybook({ ...playbookInput, proxyLedgerAllFailed: true });
      }
      if (!shouldEscalate(incident) && playbook?.id !== "proxy-quota") continue;
      try {
        // 조회 뒤 정상화로 닫힌 사고를 되살리지 않도록 아직 open 인 것만 바꾼다.
        await prisma.cronIncident.update({
          where: { id: row.id, status: "open" },
          data: playbook
            ? {
                status: "waiting_owner",
                ownerAction: playbook.ownerAction,
                cause: playbook.cause,
                causeConfidence: playbook.confidence,
                layer: 2,
              }
            : { status: "waiting_owner", ownerAction: ownerActionFor(incident) },
        });
        changed += 1;
      } catch (error) {
        // P2025 = 그 사이 다른 호출이 이미 올렸거나 닫았다 — 경합이지 오류가 아니다.
        if ((error as { code?: unknown })?.code === "P2025") continue;
        console.error("[CronIncident] 사고 승격 실패", row.id, error);
      }
    }
    return changed;
  } catch (error) {
    console.error("[CronIncident] 사고 승격 조회 실패", error);
    return 0;
  }
}
