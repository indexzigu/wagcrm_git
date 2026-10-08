import type { IntegrityIssueType } from "./data-integrity";

/**
 * 데이터 점검 유형의 **화면 낱말** — 데스크톱 데이터 점검 카드와 모바일 리스크 카드가 같은 말을 쓴다.
 * 종전에는 데스크톱만 문장(「종료됐으나 실매출 미입력」)이었다. 문장은 버리지 않고 설명창으로
 * 옮긴다(`IntegrityIssue.label` 이 그 문장이다 — 멤버 수·미확인 칸·지연 일수 같은 세부를 담는다).
 * 상태 낱말 기준(오너 확정 2026-10-08, 설계 정본 docs/private/specs/2026-10-08-status-wording-proposal.md A15).
 */
export const INTEGRITY_ISSUE_WORD: Record<IntegrityIssueType, string> = {
  NEGATIVE_SALES: "매출음수",
  SETTLEMENT_INCOMPLETE: "정산불일치",
  SETTLEMENT_NOT_STARTED: "정산미착수",
  MISSING_SALES: "실매출미입력",
};
