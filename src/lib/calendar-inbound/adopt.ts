// [캘린더수집] 기안 결정 뒤 수집 행(CalendarInboundEvent) 정리 — 출처 읽기 + 상태 표기.
// 설계 정본: docs/private/specs/2026-10-21-calendar-inbound-sync-design.md §3①·§6·§8-b.
//
// 흐름(호출부):
//  - 승인 실행 성공 → `approveProposal` 이 커밋 뒤 장부 넘겨받기(`adoptCalendarEventIntoLedger`) →
//    `markInboundAdopted` → 그다음 후속 처리(캘린더 동기화가 넘겨받은 원본을 제자리 갱신).
//  - 승인 실행 실패(FAILED) → `resetInboundForRetry` — 재판정 대기로 적어 다음 스캔이 최신 값으로 다시 판정한다.
//  - 반려 → `markInboundRejected` — 같은 일정을 다시 기안하지 않는다.
//
// ⚠️ 상태 표기 세 함수(`markInboundAdopted`·`markInboundRejected`·`resetInboundForRetry`)는 **커밋 뒤** 단계에서
//    불린다 — 호출부는 실패를 잡아 console.error 로 보고하고 이미 커밋된 승인·반려를 실패로 되돌리지 않는다.
//    예외: `claimInboundRowForApproval` 은 승인 전이(tx1) **안에서** 불리고, 실패하면 승인 자체를 취소한다.
// ⚠️ 상태 표기는 행이 **아직 그 기안을 가리킬 때만** 적는다(조건부 갱신). 그 사이 행이 새 기안으로 넘어갔으면
//    옛 기안의 결과로 새 기안의 행을 덮지 않는다 — 0건이면 경고만 남긴다.
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { INBOUND_STATUS } from "./status";

export { CALENDAR_INBOUND_CREATED_BY, calendarInboundRefSchema, readCalendarInboundRef, type CalendarInboundRef } from "./ref";

/**
 * 승인돼 처리 끝 — 장부 넘겨받기 여부와 무관하게 ADOPTED(다음 스캔이 멱등 제외).
 * `skipReason` 은 넘겨받지 못한 사유(장부 키 충돌 `ledger_conflict`)를 남길 때만 채운다.
 */
export async function markInboundAdopted(
  inboundId: string,
  proposalId: string,
  campaignId: string | null,
  opts: { skipReason?: string | null } = {},
): Promise<void> {
  await updateInbound(inboundId, proposalId, {
    status: INBOUND_STATUS.ADOPTED,
    campaignId,
    skipReason: opts.skipReason ?? null,
  });
}

/** 오너가 반려 — 같은 일정을 다시 기안하지 않는다(지문이 바뀌면 스캔이 다시 판정한다). */
export async function markInboundRejected(inboundId: string, proposalId: string): Promise<void> {
  await updateInbound(inboundId, proposalId, { status: INBOUND_STATUS.REJECTED });
}

/**
 * 승인 실행 실패 — REJECTED 와 달리 닫지 않는다. 다음 스캔이 상태(PENDING_RETRY)만 보고 최신 값으로 다시
 * 판정한다(같은 값이면 noop → ADOPTED). `proposalId` 는 마지막 기안 기록으로 남긴다.
 * ⛔ 지문을 비우지 말 것 — 다음 스캔 전에 오너가 FAILED 카드를 재시도해 성공하면 행은 ADOPTED 가 되는데,
 *    지문이 비어 있으면 스캔이 「바뀐 일정」으로 보고 다시 기안한다(회차 표기 없는 제목이면 새 회차가 둘).
 */
export async function resetInboundForRetry(inboundId: string, proposalId: string): Promise<void> {
  await updateInbound(inboundId, proposalId, { status: INBOUND_STATUS.PENDING_RETRY });
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

/**
 * 승인이 수집 행을 잡는다 — 행이 **아직 이 기안을 가리킬 때만** 조건부로 갱신하고 `updatedAt` 을 올린다. 승인 전이
 * (tx1)와 **같은 트랜잭션**에서 부른다. 사전 확인(`findInboundRow`)과 tx1 사이에 재판정 스캔이 행을 새 기안으로
 * 넘기면 여기서 0건이 되어 옛 기안은 승인되지 않는다. 반대로 승인이 먼저 잡으면 `updatedAt` 이 바뀌어 스캔의 조건부
 * 쓰기(scan.ts)가 0건이 되고 스캔은 그 일정을 건너뛴다 — 같은 일정이 두 번 반영되지 않는다.
 */
export async function claimInboundRowForApproval(
  tx: Prisma.TransactionClient,
  inboundId: string,
  proposalId: string,
): Promise<boolean> {
  const { count } = await tx.calendarInboundEvent.updateMany({
    where: { id: inboundId, proposalId },
    // 값은 그대로 — 행 잠금과 `updatedAt` 갱신이 목적이다(@updatedAt 에 기대지 않고 명시).
    data: { proposalId, updatedAt: new Date() },
  });
  return count === 1;
}

async function updateInbound(
  inboundId: string,
  proposalId: string,
  data: { status: string; campaignId?: string | null; skipReason?: string | null },
): Promise<void> {
  // 조건부 updateMany — 행이 지워졌거나 다른 기안으로 넘어갔으면 던지지 않고 0건으로 끝난다. 그 경우는 보고만 한다.
  const { count } = await getPrisma().calendarInboundEvent.updateMany({ where: { id: inboundId, proposalId }, data });
  if (count === 0) {
    console.warn(
      `[calendar-inbound] 수집 행 ${inboundId} 가 없거나 기안 ${proposalId} 를 가리키지 않아 상태(${data.status})를 적지 않음`,
    );
  }
}
