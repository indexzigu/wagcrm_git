import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isRemoteDatabaseUrl } from "@/lib/prisma-client";
import type { CronErrorKind } from "@/lib/cron-error-kind";
import { ownerActionFor, shouldEscalate } from "@/lib/cron-incident-escalation";

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
 * 기준이라, 재시도가 횟수를 올리면 정상화를 앞당기려던 장치가 알림을 앞당긴다. 열린 사고가 없으면
 * (재시도 사이에 정상화로 닫혔다 등) 평소처럼 새로 연다.
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
    const retried = attempt != null && attempt > 1;
    const result = await prisma.cronIncident.updateMany({
      where: { jobKey: input.jobKey, kind: { in: input.kinds }, status: { in: OPEN_STATUSES }, prNumber: null },
      data: {
        status: "resolved",
        normalizedAt: new Date(),
        normalizedEvidence: {
          runAt: runAt.toISOString(),
          produced,
          targets,
          ...(retried ? { attempt } : {}),
        } as Prisma.InputJsonValue,
        ...(retried ? { layer: 1 } : {}),
      },
    });
    return result.count;
  } catch (error) {
    console.error("[CronIncident] 사고 종결 실패", error);
    return 0;
  }
}

/**
 * `open` 사고 중 승격 규칙(`shouldEscalate`)에 걸리는 것을 `waiting_owner` 로 올리고 오너 조치 문구를 붙인다.
 * 바꾼 개수를 돌려준다. 이미 올린 사고는 조회 대상이 아니라 두 번 불러도 같은 결과다.
 * `now` 는 호출 시각 계약용이다(알림 표시는 호출처가 한다). 던지지 않는다 — DB 오류는 console.error 후 0.
 */
export async function escalatePendingIncidents(now: Date): Promise<number> {
  void now;
  try {
    const prisma = getPrisma();
    const rows = await prisma.cronIncident.findMany({
      where: { status: "open" },
      select: { id: true, kind: true, errorKind: true, occurrences: true },
    });
    let changed = 0;
    for (const row of rows) {
      const incident = {
        kind: row.kind as IncidentKind,
        errorKind: (row.errorKind ?? null) as CronErrorKind | null,
        occurrences: row.occurrences,
      };
      if (!shouldEscalate(incident)) continue;
      try {
        // 조회 뒤 정상화로 닫힌 사고를 되살리지 않도록 아직 open 인 것만 바꾼다.
        await prisma.cronIncident.update({
          where: { id: row.id, status: "open" },
          data: { status: "waiting_owner", ownerAction: ownerActionFor(incident) },
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
