/**
 * 반영 결과 요약 계약 — 「반영 결과」 카드가 읽는 3상태(진행중·완료·실패) 접기.
 *
 * 실패해도 시트 상태는 재시도 가능하도록 되돌아가므로(오너 결정) 제안 레코드가 실패의
 * 유일한 흔적이다. 여기서 상태를 잘못 접으면 실패가 화면에서 사라진다.
 */
import { describe, expect, it } from "vitest";
import { summarizeApplyProposal } from "../apply-summary";

const base = { id: "p1", status: "EXECUTED", executedAt: null, errorMessage: null, executionResult: null };

describe("summarizeApplyProposal — 상태 접기", () => {
  it("EXECUTED 는 완료", () => {
    expect(summarizeApplyProposal({ ...base, status: "EXECUTED" }).outcome).toBe("SUCCEEDED");
  });

  it("FAILED 는 실패", () => {
    expect(summarizeApplyProposal({ ...base, status: "FAILED" }).outcome).toBe("FAILED");
  });

  it("중간 전이 상태는 전부 진행중으로 접는다", () => {
    for (const status of ["DRAFT", "PENDING_APPROVAL", "APPROVED"]) {
      expect(summarizeApplyProposal({ ...base, status }).outcome).toBe("RUNNING");
    }
  });

  it("REJECTED 는 실패로 취급한다(성공으로 보이는 것이 최악이다)", () => {
    expect(summarizeApplyProposal({ ...base, status: "REJECTED" }).outcome).toBe("FAILED");
  });

  it("모르는 상태는 성공으로 접지 않는다", () => {
    expect(summarizeApplyProposal({ ...base, status: "SOMETHING_NEW" }).outcome).toBe("RUNNING");
  });
});

describe("summarizeApplyProposal — 건수 집계", () => {
  it("CREATE·UPDATE 를 각각 센다", () => {
    const summary = summarizeApplyProposal({
      ...base,
      executionResult: {
        results: [
          { dealId: "d1", action: "CREATE" },
          { dealId: "d2", action: "CREATE" },
          { dealId: "d3", action: "UPDATE" },
        ],
      },
    });
    expect(summary.createdCount).toBe(2);
    expect(summary.updatedCount).toBe(1);
  });

  it("executionResult 가 없으면 0건으로 둔다(지어내지 않는다)", () => {
    const summary = summarizeApplyProposal({ ...base, executionResult: null });
    expect(summary.createdCount).toBe(0);
    expect(summary.updatedCount).toBe(0);
  });
});

describe("summarizeApplyProposal — 오류 메시지 노출", () => {
  it("실패일 때만 errorMessage 를 내보낸다", () => {
    expect(
      summarizeApplyProposal({ ...base, status: "FAILED", errorMessage: "실행 중 오류" }).errorMessage
    ).toBe("실행 중 오류");
  });

  it("성공한 제안에 낡은 errorMessage 가 남아 있어도 감춘다", () => {
    expect(
      summarizeApplyProposal({ ...base, status: "EXECUTED", errorMessage: "이전 시도의 오류" })
        .errorMessage
    ).toBeNull();
  });
});

describe("summarizeApplyProposal — 완료 시각", () => {
  it("Date 를 ISO 문자열로 바꾼다", () => {
    const at = new Date("2026-08-01T12:00:00.000Z");
    expect(summarizeApplyProposal({ ...base, executedAt: at }).finishedAt).toBe(at.toISOString());
  });

  it("진행중이면 null 이다", () => {
    expect(summarizeApplyProposal({ ...base, status: "APPROVED" }).finishedAt).toBeNull();
  });
});
