import { describe, expect, it } from "vitest";
import { canTransition, type ActionProposalStatus } from "../actionProposalRepository";

// 청사진 §2 상태기계 표를 그대로 검증한다.
//
// | from | to | 조건 |
// |---|---|---|
// | DRAFT | PENDING_APPROVAL | WRITE+payload 유효 / READ+reviewRequired |
// | DRAFT | EXECUTED | READ이고 reviewRequired=false |
// | PENDING_APPROVAL | APPROVED | 승인 권한 통과 |
// | PENDING_APPROVAL | REJECTED | 반려 |
// | APPROVED | EXECUTED | payload 전부 성공 |
// | APPROVED | FAILED | 실행 오류 |
// | FAILED | APPROVED | 재실행 허용 |
//
// EXECUTED/REJECTED 재전이 금지 (FAILED→APPROVED만 예외).

describe("canTransition — 허용된 전이", () => {
  it("DRAFT -> PENDING_APPROVAL (READ)", () => {
    expect(canTransition("DRAFT", "PENDING_APPROVAL", "READ")).toBe(true);
  });

  it("DRAFT -> PENDING_APPROVAL (WRITE)", () => {
    expect(canTransition("DRAFT", "PENDING_APPROVAL", "WRITE")).toBe(true);
  });

  it("DRAFT -> EXECUTED (READ, reviewRequired=false 즉시 실행 경로)", () => {
    expect(canTransition("DRAFT", "EXECUTED", "READ")).toBe(true);
  });

  it("PENDING_APPROVAL -> APPROVED", () => {
    expect(canTransition("PENDING_APPROVAL", "APPROVED", "WRITE")).toBe(true);
    expect(canTransition("PENDING_APPROVAL", "APPROVED", "READ")).toBe(true);
  });

  it("PENDING_APPROVAL -> REJECTED", () => {
    expect(canTransition("PENDING_APPROVAL", "REJECTED", "WRITE")).toBe(true);
  });

  it("APPROVED -> EXECUTED", () => {
    expect(canTransition("APPROVED", "EXECUTED", "WRITE")).toBe(true);
  });

  it("APPROVED -> FAILED", () => {
    expect(canTransition("APPROVED", "FAILED", "WRITE")).toBe(true);
  });

  it("FAILED -> APPROVED (재실행 허용 예외)", () => {
    expect(canTransition("FAILED", "APPROVED", "WRITE")).toBe(true);
  });
});

describe("canTransition — 금지된 전이 (대표 5건 이상)", () => {
  it("WRITE는 DRAFT -> EXECUTED 직행 금지 (반드시 승인 경유)", () => {
    expect(canTransition("DRAFT", "EXECUTED", "WRITE")).toBe(false);
  });

  it("EXECUTED는 재전이 금지 (터미널 상태)", () => {
    expect(canTransition("EXECUTED", "APPROVED", "WRITE")).toBe(false);
    expect(canTransition("EXECUTED", "DRAFT", "READ")).toBe(false);
  });

  it("REJECTED는 재전이 금지 (터미널 상태)", () => {
    expect(canTransition("REJECTED", "PENDING_APPROVAL", "WRITE")).toBe(false);
    expect(canTransition("REJECTED", "APPROVED", "WRITE")).toBe(false);
  });

  it("FAILED -> APPROVED 외의 다른 전이는 금지", () => {
    expect(canTransition("FAILED", "EXECUTED", "WRITE")).toBe(false);
    expect(canTransition("FAILED", "REJECTED", "WRITE")).toBe(false);
    expect(canTransition("FAILED", "DRAFT", "WRITE")).toBe(false);
  });

  it("DRAFT -> APPROVED 직행 금지 (PENDING_APPROVAL 단계 생략 불가)", () => {
    expect(canTransition("DRAFT", "APPROVED", "WRITE")).toBe(false);
  });

  it("PENDING_APPROVAL -> EXECUTED 직행 금지 (APPROVED 단계 생략 불가)", () => {
    expect(canTransition("PENDING_APPROVAL", "EXECUTED", "WRITE")).toBe(false);
  });

  it("APPROVED -> REJECTED 금지 (반려는 PENDING_APPROVAL에서만 가능)", () => {
    expect(canTransition("APPROVED", "REJECTED", "WRITE")).toBe(false);
  });
});

describe("canTransition — 전체 상태 조합 회귀 (화이트리스트 밖은 전부 false)", () => {
  const allStatuses: ActionProposalStatus[] = [
    "DRAFT",
    "PENDING_APPROVAL",
    "APPROVED",
    "EXECUTED",
    "REJECTED",
    "FAILED",
  ];

  const allowedPairs = new Set([
    "DRAFT->PENDING_APPROVAL",
    "DRAFT->EXECUTED", // READ only, 별도 케이스에서 kind 검증
    "PENDING_APPROVAL->APPROVED",
    "PENDING_APPROVAL->REJECTED",
    "APPROVED->EXECUTED",
    "APPROVED->FAILED",
    "FAILED->APPROVED",
  ]);

  for (const from of allStatuses) {
    for (const to of allStatuses) {
      const key = `${from}->${to}`;
      if (allowedPairs.has(key)) continue;
      it(`${key} (READ)는 금지되어야 한다`, () => {
        expect(canTransition(from, to, "READ")).toBe(false);
      });
    }
  }
});
