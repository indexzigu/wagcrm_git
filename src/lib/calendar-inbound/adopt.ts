// [캘린더수집] 기안 결정 뒤 수집 행(CalendarInboundEvent) 정리 — 출처 읽기 + 상태 표기.
// 설계 정본: docs/private/specs/2026-10-21-calendar-inbound-sync-design.md §3①·§6·§8-b.
//
// 흐름(호출부):
//  - 승인 실행 성공 → `approveProposal` 이 커밋 뒤 장부 넘겨받기(`adoptCalendarEventIntoLedger`) →
//    `markInboundAdopted` → 그다음 후속 처리(캘린더 동기화가 넘겨받은 원본을 제자리 갱신).
//  - 승인 실행 실패(FAILED) → `resetInboundForRetry` — 지문을 비워 다음 스캔이 최신 값으로 다시 판정한다.
//  - 반려 → `markInboundRejected` — 같은 일정을 다시 기안하지 않는다.
//
// ⚠️ 이 함수들은 모두 **커밋 뒤** 단계에서 불린다 — 호출부는 실패를 잡아 console.error 로 보고하고
//    이미 커밋된 승인·반려를 실패로 되돌리지 않는다.
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { parseStoredJson } from "@/lib/stored-json";
import { INBOUND_STATUS } from "./status";

/** 캘린더 수집이 기안을 올릴 때 쓰는 createdBy — 사람 승인자와 겹치지 않는다(self-approval 게이트). */
export const CALENDAR_INBOUND_CREATED_BY = "SYSTEM_CALENDAR_INBOUND";

/**
 * 기안 `sourceRef.calendarInbound` 모양 — 스캔(Task 7)이 쓰고 승인·반려·결재 카드가 읽는다.
 * 카드 표시용 칸(summary·날짜·htmlLink·warnings)도 함께 싣는다.
 */
export const calendarInboundRefSchema = z.object({
  /** CalendarInboundEvent.id */
  inboundId: z.string().min(1),
  /** 구글 이벤트 id */
  eventId: z.string().min(1),
  calendarId: z.string().min(1),
  ledgerKind: z.enum(["campaign", "deposit", "payout", "supplierPayout"]),
  /** false = 장부는 건드리지 않고 처리 끝으로만 표기(제안 단계 캠페인 대상 등). */
  adopt: z.boolean(),
  summary: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  htmlLink: z.string().nullable(),
  warnings: z.array(z.string()),
});

export type CalendarInboundRef = z.infer<typeof calendarInboundRefSchema>;

const sourceRefSchema = z.object({ calendarInbound: calendarInboundRefSchema });

/**
 * 기안의 `sourceRef` 에서 캘린더 출처를 읽는다. 없거나 모양이 틀리면 null(= 캘린더 출신이 아니다).
 * 🪤 raw Prisma 로 읽은 Json 은 SQLite 레인에서 문자열이다 — `parseStoredJson` 을 거친다(`stored-json.ts`).
 */
export function readCalendarInboundRef(sourceRef: unknown): CalendarInboundRef | null {
  const parsed = sourceRefSchema.safeParse(parseStoredJson<unknown>(sourceRef));
  return parsed.success ? parsed.data.calendarInbound : null;
}

/**
 * 승인돼 처리 끝 — 장부 넘겨받기 여부와 무관하게 ADOPTED(다음 스캔이 멱등 제외).
 * `skipReason` 은 넘겨받지 못한 사유(장부 키 충돌 `ledger_conflict`)를 남길 때만 채운다.
 */
export async function markInboundAdopted(
  inboundId: string,
  campaignId: string | null,
  opts: { skipReason?: string | null } = {},
): Promise<void> {
  await updateInbound(inboundId, {
    status: INBOUND_STATUS.ADOPTED,
    campaignId,
    skipReason: opts.skipReason ?? null,
  });
}

/** 오너가 반려 — 같은 일정을 다시 기안하지 않는다(지문이 바뀌면 스캔이 다시 판정한다). */
export async function markInboundRejected(inboundId: string): Promise<void> {
  await updateInbound(inboundId, { status: INBOUND_STATUS.REJECTED });
}

/**
 * 승인 실행 실패 — REJECTED 와 달리 닫지 않는다. 지문을 비워 다음 스캔이 최신 값으로 다시 판정한다
 * (같은 값이면 noop → ADOPTED). `proposalId` 는 마지막 기안 기록으로 남긴다.
 */
export async function resetInboundForRetry(inboundId: string): Promise<void> {
  await updateInbound(inboundId, { status: INBOUND_STATUS.PENDING_RETRY, fingerprint: "" });
}

/**
 * 수집 행이 지금 가리키는 기안 — 없으면 null(행이 지워졌다). 승인 전 「재기안으로 대체됐나」 판정에 쓴다
 * (`approveProposal`). 재판정 대기 행을 다시 기안하면 스캔이 `proposalId` 를 새 기안으로 바꾼다.
 */
export async function findInboundRow(inboundId: string): Promise<{ proposalId: string | null } | null> {
  return getPrisma().calendarInboundEvent.findUnique({
    where: { id: inboundId },
    select: { proposalId: true },
  });
}

async function updateInbound(
  inboundId: string,
  data: { status: string; campaignId?: string | null; skipReason?: string | null; fingerprint?: string },
): Promise<void> {
  // updateMany — 행이 지워졌어도 던지지 않고 0건으로 끝난다. 그 경우는 보고만 한다.
  const { count } = await getPrisma().calendarInboundEvent.updateMany({ where: { id: inboundId }, data });
  if (count === 0) {
    console.warn(`[calendar-inbound] 수집 행 ${inboundId} 가 없어 상태(${data.status})를 적지 못함`);
  }
}
