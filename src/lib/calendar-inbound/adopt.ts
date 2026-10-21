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
import { getPrisma } from "@/lib/prisma";
import { INBOUND_STATUS } from "./status";

export { CALENDAR_INBOUND_CREATED_BY, calendarInboundRefSchema, readCalendarInboundRef, type CalendarInboundRef } from "./ref";

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
