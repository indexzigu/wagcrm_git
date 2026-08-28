import { describe, it, expect } from "vitest";
import { calculateFollowUp, getDaysDiff } from "./followup-engine";

describe("followup-engine", () => {
  describe("getDaysDiff", () => {
    it("should calculate exact days difference ignoring hours", () => {
      const from = new Date("2026-06-01T15:00:00");
      const to = new Date("2026-06-15T09:00:00");
      expect(getDaysDiff(from, to)).toBe(14);
    });

    it("should calculate 0 for the same calendar date", () => {
      const from = new Date("2026-06-01T01:00:00");
      const to = new Date("2026-06-01T23:00:00");
      expect(getDaysDiff(from, to)).toBe(0);
    });

    it("should return negative values if to is before from", () => {
      const from = new Date("2026-06-15T00:00:00");
      const to = new Date("2026-06-01T00:00:00");
      expect(getDaysDiff(from, to)).toBe(-14);
    });
  });

  describe("calculateFollowUp", () => {
    const refDate = new Date("2026-06-30T12:00:00");

    describe("nextReminderAt 우선순위 룰", () => {
      it("nextReminderAt이 현재 시점 이하(오늘 또는 과거)이면 MANUAL_REMINDER 뱃지를 반환한다", () => {
        const task = {
          status: "PROPOSED",
          proposalSentAt: "2026-06-01T00:00:00", // +29일 경과 상태이나 nextReminderAt 우선
          nextReminderAt: "2026-06-30T00:00:00", // 오늘 자정 예정
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).not.toBeNull();
        expect(result?.type).toBe("MANUAL_REMINDER");
        expect(result?.label).toBe("지정일 팔로업 필요");
      });

      it("nextReminderAt이 과거 일자이면 경과 일수와 함께 MANUAL_REMINDER 뱃지를 반환한다", () => {
        const task = {
          status: "PROPOSED",
          proposalSentAt: "2026-06-01T00:00:00",
          nextReminderAt: "2026-06-28T00:00:00", // 2일 지남
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).not.toBeNull();
        expect(result?.type).toBe("MANUAL_REMINDER");
        expect(result?.elapsedDays).toBe(2);
      });

      it("nextReminderAt이 미래 시점이면 뱃지를 반환하지 않는다", () => {
        const task = {
          status: "PROPOSED",
          proposalSentAt: "2026-06-01T00:00:00",
          nextReminderAt: "2026-07-01T00:00:00", // 내일 예정
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).toBeNull();
      });
    });

    describe("PROPOSED 상태 자동 팔로업 룰", () => {
      it("발송일 기준 14일 미만이면 뱃지를 반환하지 않는다", () => {
        const task = {
          status: "PROPOSED",
          proposalSentAt: "2026-06-17T00:00:00", // 13일 경과
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).toBeNull();
      });

      it("발송일 기준 14일 이상 28일 미만이면 1차 리마인드 권장 뱃지를 반환한다", () => {
        const task = {
          status: "PROPOSED",
          proposalSentAt: "2026-06-16T00:00:00", // 14일 경과
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).not.toBeNull();
        expect(result?.type).toBe("1ST_REMINDER");
        expect(result?.label).toBe("1차 리마인드 권장");
      });

      it("발송일 기준 28일 이상이면 2차 리마인드 권장 뱃지를 반환한다", () => {
        const task = {
          status: "PROPOSED",
          proposalSentAt: "2026-06-02T00:00:00", // 28일 경과
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).not.toBeNull();
        expect(result?.type).toBe("2ND_REMINDER");
        expect(result?.label).toBe("2차 리마인드 권장");
      });
    });

    describe("TESTING / SAMPLE_TESTING 상태 자동 팔로업 룰", () => {
      it("상태 변경일(updatedAt) 기준 14일 미만이면 뱃지를 반환하지 않는다", () => {
        const task = {
          status: "TESTING",
          updatedAt: "2026-06-17T00:00:00", // 13일 경과
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).toBeNull();
      });

      it("상태 변경일(updatedAt) 기준 14일 이상이면 샘플 진행상황 체크 요망 뱃지를 반환한다", () => {
        const task = {
          status: "TESTING",
          updatedAt: "2026-06-16T00:00:00", // 14일 경과
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).not.toBeNull();
        expect(result?.type).toBe("SAMPLE_CHECK");
        expect(result?.label).toBe("샘플 진행상황 체크 요망");
      });

      it("SAMPLE_TESTING 상태 명칭도 호환되어 뱃지를 반환한다", () => {
        const task = {
          status: "SAMPLE_TESTING",
          updatedAt: "2026-06-16T00:00:00", // 14일 경과
        };
        const result = calculateFollowUp(task, refDate);
        expect(result).not.toBeNull();
        expect(result?.type).toBe("SAMPLE_CHECK");
      });
    });
  });
});
