/**
 * 에이전트 「기록 수정」(`update_record`) 기안의 **화면 이름·값 표기**.
 * 결재함 미리보기(클라이언트)와 실행기·기안 도구(서버)가 같은 글을 쓴다.
 *
 * ⚠️ 클라이언트에서도 import 한다 — 서버 전용 모듈(계약 `agent-worker/contracts.ts` 는 `node:crypto`,
 * `activity-log.ts` 는 Prisma)을 여기로 끌어오지 말 것.
 * ⚠️ 엔티티 목록의 정본은 계약의 `AgentJobRecordEntityTypeSchema` 다(파이썬 미러가 그 파일의 글자를
 * 읽는다). 아래 표가 같은 키를 갖는지는 `record-update-labels.test.ts` 가 대조한다.
 *
 * 칸 이름은 이미 있는 표를 다시 쓴다 — 딜·거래처·셀러는 감사 기록 표(`FIELD_LABELS`), 캠페인 금액 칸은
 * 재무 카드 이름(`SETTLEMENT_AMOUNT_FIELD_LABELS`). 캠페인의 나머지 칸만 여기서 이름을 준다.
 * 표에 없는 칸은 **칸 이름 그대로** 보인다(지어낸 이름보다 원래 이름이 덜 틀린다).
 */
import { FIELD_LABELS } from "./field-labels";
import { SETTLEMENT_AMOUNT_FIELD_LABELS } from "./settlement-amount-fields";
import {
  campaignStatusLabels,
  dealStatusLabels,
  salesChannelLabels,
  type CampaignStatus,
  type DealStatus,
  type SalesChannel,
} from "./crm-types";

export const RECORD_ENTITY_LABELS = {
  CAMPAIGN: "캠페인",
  DEAL: "딜",
  PARTNER: "거래처",
  SELLER: "셀러",
} as const;

export type RecordEntityType = keyof typeof RECORD_ENTITY_LABELS;

export function isRecordEntityType(value: unknown): value is RecordEntityType {
  return typeof value === "string" && Object.hasOwn(RECORD_ENTITY_LABELS, value);
}

/** 캠페인 칸 이름 — 캠페인 상세·정산 카드의 칸 제목을 따른다. */
const CAMPAIGN_FIELD_LABELS: Record<string, string> = {
  ...SETTLEMENT_AMOUNT_FIELD_LABELS,
  status: "캠페인 상태",
  salesChannel: "판매 채널",
  startDate: "시작일",
  endDate: "종료일",
  quantity: "판매 수량",
  itemCount: "품목 수",
  totalMarginRate: "총 수수료율",
  sellerMarginRate: "셀러 수수료율",
  netMarginRate: "순 마진율",
  isManualMargin: "수수료율 수동",
  isManualSettlementSales: "영업 수익 수동",
  isManualSellerExpense: "판매대행비 수동",
  isManualTaxExpense: "제세공과금 수동",
  isDepositReceived: "입금 완료",
  depositReceivedAt: "입금일",
  isPayoutCompleted: "지급 완료",
  payoutCompletedAt: "지급일",
  isSupplierPayoutCompleted: "공급사 지급 완료",
  supplierPayoutCompletedAt: "공급사 지급일",
  returnPeriodEndDate: "반품기간 종료일",
  sellerFeeBasisOverride: "정산 기준액",
  supplierInvoiceIssuedAt: "공급사 계산서일",
  sellerInvoiceIssuedAt: "셀러 계산서일",
  expectedDepositDate: "입금 예정일",
  expectedPayoutDate: "지급 예정일",
  expectedSupplierPayoutDate: "공급사 지급 예정일",
  accountingCompletedAt: "회계 처리일",
  invoiceInfo: "계산서 정보",
  notesFromImport: "계산서 정보",
  roundNumber: "회차",
  campaignName: "캠페인 이름",
  dealId: "딜",
  sellerId: "셀러",
  baseNaverLink: "상품 링크",
  dropReason: "드랍 사유",
  sellerTaxType: "셀러 과세 유형",
};

export function recordFieldLabel(entityType: RecordEntityType, field: string): string {
  const table = entityType === "CAMPAIGN" ? CAMPAIGN_FIELD_LABELS : FIELD_LABELS;
  return Object.hasOwn(table, field) ? table[field] : field;
}

/**
 * 값 한 칸의 표기. `null` 은 「비어 있음」(0·빈 글과 다르다), 참거짓은 「예/아니오」,
 * 상태·채널은 화면 이름으로 적는다. 승인자가 무엇 위에 무엇을 덮어쓰는지 읽을 수 있어야 한다.
 */
export function formatRecordValue(entityType: RecordEntityType, field: string, value: unknown): string {
  if (value === null || value === undefined) return "비어 있음";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (typeof value === "number") return value.toLocaleString("ko-KR");
  const text = String(value);
  if (entityType === "CAMPAIGN" && field === "salesChannel" && Object.hasOwn(salesChannelLabels, text)) {
    return salesChannelLabels[text as SalesChannel];
  }
  if (entityType === "CAMPAIGN" && field === "status" && Object.hasOwn(campaignStatusLabels, text)) {
    return campaignStatusLabels[text as CampaignStatus];
  }
  if (entityType === "DEAL" && field === "status" && Object.hasOwn(dealStatusLabels, text)) {
    return dealStatusLabels[text as DealStatus];
  }
  return text === "" ? "빈 글" : text;
}
