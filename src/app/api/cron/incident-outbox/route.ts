import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { getPrisma } from "@/lib/prisma";
import { automationJobName } from "@/lib/automation-incidents";
import type { CronErrorKind } from "@/lib/cron-error-kind";
import {
  escalatePendingIncidents,
  recordIncidentOccurrence,
  resolveOpenIncidents,
  type IncidentKind,
} from "@/lib/cron-incident";
import {
  digestWindow,
  formatDigest,
  formatImmediate,
  formatRecovery,
  type OutboxMessage,
  type ReportIncident,
} from "@/lib/cron-incident-report";

// 사고 알림 목록(outbox) — 크론 자가 복구 2단계.
// 호스트 스크립트가 이 목록을 받아 notify.sh 로 텔레그램에 보내고, 보낸 것만 POST 로 「보냈음」을 찍는다.
// 그래서 GET 은 같은 상태에서 몇 번 불러도 같은 목록을 돌려준다(보냈음 표시는 POST 만 한다).
//
// 레이더가 지켜보는 정기 작업이 아니다 — KNOWN_JOBS 에 넣지 않고 withSystemTaskStatus 로 감싸지 않는다
// (이 라우트가 자기 자신을 사고 장부에 올리면 알림 실패가 알림을 낳는 고리가 생긴다).
//
// immediate: ① 승격 규칙 적용 ② 아직 안 알린 조치대기 사고마다 **알림 직전 재확인** — 그 작업이 마지막 발생
//   뒤에 성공했으면 보내지 않고 사고를 「막힘」으로 닫은 뒤 C 사고 1건을 남겨 즉시 닫는다 ③ 알렸던 사고가
//   정상화됐으면 정상화 알림.
// digest: 아직 요약에 안 실린 정상화 사고(창 끝 기준 7일 안) + 지금 조치대기 + KST 전날 08:00 ~ 오늘 08:00 에
//   막은 개수 → 묶음 알림 1건. 정상화의 하한을 24시간이 아니라 7일로 두는 것은 08:00 회차를 놓친 날의 정상화를
//   다음 날 요약이 잡게 하려는 것이다(digestedAt 이 한 번만 싣게 막는다). 줄마다 날짜가 붙어 24시간 밖인 것도 구분된다.

// ⚠️ `export const dynamic` 를 두지 않는다 — 이 레포는 `cacheComponents` 라 라우트 세그먼트 설정이 빌드를 깬다
// (PR #212 preflight 실측). GET 핸들러는 Next 15+ 기본이 동적이고, 매 요청 인증 헤더를 읽어 캐시될 수 없다.

const ACK_FIELDS = ["alertedAt", "recoveryAlertedAt", "digestedAt"] as const satisfies readonly OutboxMessage["ackField"][];
type AckField = (typeof ACK_FIELDS)[number];

/** 요약이 놓친 정상화를 되짚는 기간 — 08:00 회차가 며칠 빠져도(맥 꺼짐 등) 그 사이 정상화가 사라지지 않게 */
const DIGEST_CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;

// 작업 이름은 화면과 같은 함수로 짓는다 — 목록에 없는 작업은 영문 키 대신 「알 수 없음」(화면 문구 기준 ③).
const jobNameOf = automationJobName;

type IncidentRow = {
  id: string;
  jobKey: string;
  kind: string;
  errorKind: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  ownerAction: string | null;
  cause: string | null;
  causeConfidence: string | null;
  prNumber: number | null;
  normalizedAt: Date | null;
  normalizedEvidence: unknown;
  actions: unknown;
};

function toReport(row: IncidentRow): ReportIncident {
  return {
    id: row.id,
    jobKey: row.jobKey,
    kind: row.kind as IncidentKind,
    errorKind: (row.errorKind ?? null) as CronErrorKind | null,
    firstSeenAt: row.firstSeenAt,
    ownerAction: row.ownerAction,
    // 플레이북이 정한 원인(4단계) — 원문(lastMessage)이 아니라 고정 문장이다. 알림에는 원문을 넣지 않는다.
    cause: row.cause ?? null,
    causeConfidence: row.causeConfidence ?? null,
    prNumber: row.prNumber,
    normalizedAt: row.normalizedAt,
    normalizedEvidence: row.normalizedEvidence,
    actions: row.actions,
  };
}

/**
 * 알림 직전 재확인으로 막는다 — 보내지 않을 사고를 닫고, 「알림이 틀릴 뻔했다」는 C 사고를 남겨 바로 닫는다.
 * PR 이 붙은 사고는 막지 않는다(resolveOpenIncidents 와 같은 기준). 조치대기 상태일 때만 닫는다(그 사이 다른 호출이 닫았으면 P2025, 경합이지 오류가 아니다). 던지지 않는다.
 */
type TaskStatusRow = { status: string; lastRunAt: Date | null; lastProducedAt: Date | null };

/**
 * 마지막 발생 뒤 정상으로 돌아온 실행 시각, 아니면 null.
 * B(결과 0건)는 SUCCESS 로 기록되므로 성공 여부로는 못 가린다 — 대상이 없어 조용히 끝난 실행도 SUCCESS 다.
 * 그래서 B 는 실제 산출(`lastProducedAt`)이 마지막 발생 뒤에 생겼을 때만 정상화로 본다.
 */
function healedSince(row: IncidentRow, s: TaskStatusRow | undefined): Date | null {
  if (!s) return null;
  const after = (d: Date | null) => (d && d.getTime() > row.lastSeenAt.getTime() ? d : null);
  if (row.kind === "B") return after(s.lastProducedAt);
  return s.status === "SUCCESS" ? after(s.lastRunAt) : null;
}

async function suppressIncident(row: IncidentRow, lastRunAt: Date, now: Date): Promise<void> {
  const prisma = getPrisma();
  try {
    await prisma.cronIncident.update({
      where: { id: row.id, status: "waiting_owner", prNumber: null },
      data: {
        status: "resolved",
        suppressedAt: now,
        normalizedAt: now,
        normalizedEvidence: { runAt: lastRunAt.toISOString(), suppressed: true },
      },
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === "P2025") return;
    // 닫기에 실패해도 알림은 보내지 않는다 — 작업은 이미 정상이라 보내면 틀린 알림이 된다. 다음 호출이 다시 시도한다.
    console.error("[incident-outbox] 막힌 사고 닫기 실패", row.id, error);
    return;
  }
  await recordIncidentOccurrence({ jobKey: row.jobKey, kind: "C", errorKind: null, message: "알림 직전 정상화 확인" });
  await resolveOpenIncidents({ jobKey: row.jobKey, kinds: ["C"], evidence: { runAt: lastRunAt } });
}

async function immediateMessages(now: Date): Promise<OutboxMessage[]> {
  const prisma = getPrisma();
  await escalatePendingIncidents(now);

  const messages: OutboxMessage[] = [];
  const pending = (await prisma.cronIncident.findMany({
    where: { status: "waiting_owner", alertedAt: null, kind: { not: "C" } },
    orderBy: { firstSeenAt: "asc" },
  })) as IncidentRow[];

  if (pending.length > 0) {
    const statuses = await prisma.systemTaskStatus.findMany({
      where: { jobKey: { in: [...new Set(pending.map((r) => r.jobKey))] } },
      select: { jobKey: true, status: true, lastRunAt: true, lastProducedAt: true },
    });
    const statusByJob = new Map(statuses.map((s) => [s.jobKey, s]));
    for (const row of pending) {
      const healedAt = row.prNumber == null ? healedSince(row, statusByJob.get(row.jobKey)) : null;
      if (healedAt) {
        await suppressIncident(row, healedAt, now);
        continue;
      }
      messages.push(formatImmediate(toReport(row), jobNameOf(row.jobKey)));
    }
  }

  const recovered = (await prisma.cronIncident.findMany({
    where: { status: "resolved", alertedAt: { not: null }, recoveryAlertedAt: null, suppressedAt: null },
    orderBy: { normalizedAt: "asc" },
  })) as IncidentRow[];
  for (const row of recovered) messages.push(formatRecovery(toReport(row), jobNameOf(row.jobKey), now));

  return messages;
}

async function digestMessages(now: Date): Promise<OutboxMessage[]> {
  const prisma = getPrisma();
  const { start, end } = digestWindow(now);
  const resolvedFloor = new Date(end.getTime() - DIGEST_CATCH_UP_MS);
  const [resolved, waiting, suppressedCount] = await Promise.all([
    prisma.cronIncident.findMany({
      where: {
        status: "resolved",
        kind: { not: "C" },
        normalizedAt: { gte: resolvedFloor, lt: end },
        digestedAt: null,
        suppressedAt: null,
      },
      orderBy: { normalizedAt: "asc" },
    }) as Promise<IncidentRow[]>,
    prisma.cronIncident.findMany({
      where: { status: "waiting_owner", kind: { not: "C" } },
      orderBy: { firstSeenAt: "asc" },
    }) as Promise<IncidentRow[]>,
    prisma.cronIncident.count({ where: { suppressedAt: { gte: start, lt: end } } }),
  ]);
  const withName = (row: IncidentRow) => ({ ...toReport(row), jobName: jobNameOf(row.jobKey) });
  const digest = formatDigest(resolved.map(withName), waiting.map(withName), suppressedCount, now);
  return digest ? [digest] : [];
}

export async function GET(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const mode = new URL(request.url).searchParams.get("mode") ?? "immediate";
  if (mode !== "immediate" && mode !== "digest") {
    return NextResponse.json({ ok: false, error: "mode 는 immediate 또는 digest" }, { status: 400 });
  }
  try {
    const now = new Date();
    const messages = mode === "digest" ? await digestMessages(now) : await immediateMessages(now);
    return NextResponse.json({ ok: true, messages });
  } catch (error) {
    console.error("[incident-outbox] 알림 목록 계산 실패", mode, error);
    return NextResponse.json({ ok: false, error: "알림 목록을 만들지 못했습니다" }, { status: 500 });
  }
}

type Ack = { incidentIds: string[]; ackField: AckField };

function parseAcks(body: unknown): Ack[] | null {
  const acks = (body as { acks?: unknown } | null)?.acks;
  if (!Array.isArray(acks)) return null;
  const parsed: Ack[] = [];
  for (const ack of acks) {
    const { incidentIds, ackField } = (ack ?? {}) as { incidentIds?: unknown; ackField?: unknown };
    if (!Array.isArray(incidentIds) || !incidentIds.every((id) => typeof id === "string")) return null;
    if (typeof ackField !== "string" || !(ACK_FIELDS as readonly string[]).includes(ackField)) return null;
    parsed.push({ incidentIds: incidentIds as string[], ackField: ackField as AckField });
  }
  return parsed;
}

/**
 * 보낸 알림의 확인 표시. 이미 찍힌 칸은 덮지 않는다 — 호스트 스크립트가 재시도해도 처음 보낸 시각이 남는다.
 * 본문이 하나라도 형식에 어긋나면 아무것도 바꾸지 않고 400.
 */
export async function POST(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "본문이 JSON 이 아닙니다" }, { status: 400 });
  }
  const acks = parseAcks(body);
  if (!acks) {
    return NextResponse.json(
      { ok: false, error: "acks 는 { incidentIds: string[], ackField } 의 배열이어야 합니다" },
      { status: 400 },
    );
  }
  try {
    const prisma = getPrisma();
    const now = new Date();
    let updated = 0;
    for (const { incidentIds, ackField } of acks) {
      if (incidentIds.length === 0) continue;
      const result = await prisma.cronIncident.updateMany({
        where: { id: { in: incidentIds }, [ackField]: null },
        data: { [ackField]: now },
      });
      updated += result.count;
    }
    return NextResponse.json({ ok: true, updated });
  } catch (error) {
    console.error("[incident-outbox] 확인 표시 실패", error);
    return NextResponse.json({ ok: false, error: "확인 표시를 남기지 못했습니다" }, { status: 500 });
  }
}
