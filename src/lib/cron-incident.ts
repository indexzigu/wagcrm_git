import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import type { CronErrorKind } from "@/lib/cron-error-kind";

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
 */
export async function recordIncidentOccurrence(input: {
  jobKey: string;
  kind: IncidentKind;
  errorKind: CronErrorKind | null;
  message: string;
  at?: Date;
}): Promise<{ id: string; opened: boolean } | null> {
  try {
    const prisma = getPrisma();
    const at = input.at ?? new Date();
    const signature = incidentSignature(input);
    const lastMessage = input.message.slice(0, LAST_MESSAGE_MAX);

    const existing = await prisma.cronIncident.findFirst({
      where: { signature, status: { in: OPEN_STATUSES } },
      orderBy: { firstSeenAt: "desc" },
    });
    if (existing) {
      await prisma.cronIncident.update({
        where: { id: existing.id },
        data: { occurrences: { increment: 1 }, lastSeenAt: at, lastMessage },
      });
      return { id: existing.id, opened: false };
    }

    const created = await prisma.cronIncident.create({
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
  } catch (error) {
    console.error("[CronIncident] 사고 기록 실패", error);
    return null;
  }
}

/**
 * 정상 실행 증거로 그 작업의 열린(`open`) 사고를 닫고 닫은 개수를 돌려준다.
 * `waiting_owner` 는 닫지 않는다 — 배포 반영 확인은 별도 2단계다. DB 오류는 console.error 후 0.
 */
export async function resolveOpenIncidents(input: {
  jobKey: string;
  kinds: IncidentKind[];
  evidence: { runAt: Date; produced?: number; targets?: number };
}): Promise<number> {
  try {
    const prisma = getPrisma();
    const { runAt, produced, targets } = input.evidence;
    const result = await prisma.cronIncident.updateMany({
      where: { jobKey: input.jobKey, kind: { in: input.kinds }, status: "open" },
      data: {
        status: "resolved",
        normalizedAt: new Date(),
        normalizedEvidence: { runAt: runAt.toISOString(), produced, targets } as Prisma.InputJsonValue,
      },
    });
    return result.count;
  } catch (error) {
    console.error("[CronIncident] 사고 종결 실패", error);
    return 0;
  }
}
