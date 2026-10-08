/**
 * 에이전트 「정산 금액 수정」(`update_settlement_amount`)이 고칠 수 있는 캠페인 금액 칸과
 * 그 **화면 이름**. 결재함 미리보기(클라이언트)와 실행기·기안 도구(서버)가 같은 이름을 쓴다.
 *
 * ⚠️ 클라이언트에서도 import 한다 — 서버 전용 모듈(계약 `agent-worker/contracts.ts` 는
 * `node:crypto` 를 쓴다)을 여기로 끌어오지 말 것.
 *
 * ⚠️ 칸 목록의 정본은 계약의 `AgentJobSettlementAmountFieldSchema` 다(파이썬 미러가 그 파일의
 * **글자**를 읽으므로 거기 펼쳐 적었다). 이 표가 같은 키를 갖는지는
 * `settlement-amount-fields.test.ts` 가 대조한다.
 *
 * 이름은 재무 카드(`campaign-side-panel.tsx`)의 칸 제목을 그대로 따른다 — 승인자는 그 화면에서
 * 이 숫자를 본 사람이고, 다른 이름을 쓰면 「어느 칸 얘기인가」를 다시 맞춰 봐야 한다.
 */
export const SETTLEMENT_AMOUNT_FIELD_LABELS = {
  actualSales: "총 거래액",
  settlementSales: "영업 수익",
  sellerExpense: "판매대행비",
  taxExpense: "제세공과금",
  operatingExpense: "공동 운영 비용",
  miscExpense: "기타 조정 비용",
  settlementSupplyCost: "공급가액",
  settlementGoodsCost: "물품대금",
} as const;

export type SettlementAmountField = keyof typeof SETTLEMENT_AMOUNT_FIELD_LABELS;

export function isSettlementAmountField(value: unknown): value is SettlementAmountField {
  return typeof value === "string" && Object.hasOwn(SETTLEMENT_AMOUNT_FIELD_LABELS, value);
}

/**
 * 금액 한 칸의 표기. `null` 은 「비어 있음」이다 — **0원과 다르다**(물품대금의 0 은 「다른
 * 캠페인 계산서에 합산됨」 표시이고 null 은 미입력이다). 둘을 같은 글자로 쓰면 승인자가
 * 무엇을 무엇으로 바꾸는지 읽을 수 없다.
 */
export function formatSettlementAmountKrw(value: number | null): string {
  return value === null ? "비어 있음" : `${value.toLocaleString("ko-KR")}원`;
}
