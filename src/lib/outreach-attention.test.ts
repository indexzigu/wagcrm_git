import { describe, expect, it } from "vitest";
import {
  daysSince,
  isAwaitingResponse,
  isReminderDue,
  matchesAttention,
} from "./outreach-attention";

const NOW = new Date(2026, 9, 5, 14, 0); // 2026-10-05 14:00 (로컬)

function task(over: Partial<{ status: string; proposedAt: string; updatedAt: string | null; nextReminderAt: string | null }>) {
  return { status: "PROPOSED", proposedAt: new Date(2026, 9, 5, 9).toISOString(), ...over };
}

describe("outreach-attention 판정", () => {
  it("daysSince 는 달력 날짜로 센다 — 어제 밤 11시도 1일이다", () => {
    expect(daysSince(new Date(2026, 9, 4, 23).toISOString(), NOW)).toBe(1);
    expect(daysSince("not-a-date", NOW)).toBeNull();
    expect(daysSince(null, NOW)).toBeNull();
  });

  it("리마인드 기한은 제안중이면서 다음 리마인드 시각이 지난 것만이다", () => {
    const past = new Date(2026, 9, 5, 13).toISOString();
    const future = new Date(2026, 9, 5, 15).toISOString();
    expect(isReminderDue(task({ nextReminderAt: past }), NOW)).toBe(true);
    expect(isReminderDue(task({ nextReminderAt: future }), NOW)).toBe(false);
    expect(isReminderDue(task({ nextReminderAt: past, status: "NEGOTIATION" }), NOW)).toBe(false);
    expect(isReminderDue(task({ nextReminderAt: null }), NOW)).toBe(false);
  });

  it("응답 공백은 진행 중 상태에서 3일 이상 조용한 것이다 — 종결·승인 대기는 아니다", () => {
    const threeDaysAgo = new Date(2026, 9, 2, 10).toISOString();
    const twoDaysAgo = new Date(2026, 9, 3, 10).toISOString();
    expect(isAwaitingResponse(task({ status: "TESTING", updatedAt: threeDaysAgo }), NOW)).toBe(true);
    expect(isAwaitingResponse(task({ status: "TESTING", updatedAt: twoDaysAgo }), NOW)).toBe(false);
    expect(isAwaitingResponse(task({ status: "CONVERTED", updatedAt: threeDaysAgo }), NOW)).toBe(false);
    expect(isAwaitingResponse(task({ status: "PENDING_APPROVAL", updatedAt: threeDaysAgo }), NOW)).toBe(false);
  });

  it("한 태스크가 리마인드와 응답 공백에 겹쳐 세이지 않는다", () => {
    const stale = task({
      updatedAt: new Date(2026, 8, 20).toISOString(),
      nextReminderAt: new Date(2026, 9, 1).toISOString(),
    });
    expect(matchesAttention(stale, "REMINDER_DUE", NOW)).toBe(true);
    expect(matchesAttention(stale, "RESPONSE_GAP", NOW)).toBe(false);
  });

  it("전환 대기는 승인 대기 상태다", () => {
    expect(matchesAttention(task({ status: "PENDING_APPROVAL" }), "PENDING_APPROVAL", NOW)).toBe(true);
    expect(matchesAttention(task({ status: "TESTING" }), "PENDING_APPROVAL", NOW)).toBe(false);
  });
});
