import type { InvoiceMailSummary } from "../campaign-invoices";
import type { ParsedEtaxInvoice } from "./etax-xml";

/**
 * 파싱된 계산서 → 월정산 계산서 판정용 요약(`campaign-invoices.ts`). 수취 조회 API 와 발행 자동 확정
 * 크론(T-242)이 같은 모양을 쓴다 — 화면이 고른 후보와 크론이 고른 후보가 갈리지 않게 한 곳에 둔다.
 * 품목명은 줄 이름을 이어 붙인다(셀러 실명이 들어갈 수 있다 — 오너 전용, 로그 금지, P0).
 */
export function toInvoiceMailSummary(parsed: ParsedEtaxInvoice | null, receivedAt: string): InvoiceMailSummary | null {
  if (!parsed) return null;
  const names = parsed.lineItems
    .map((line) => line.name?.trim())
    .filter((name): name is string => Boolean(name));
  return {
    issueId: parsed.issueId,
    typeCode: parsed.typeCode,
    writtenDate: parsed.writtenDate,
    invoicerBusinessNumber: parsed.invoicerBusinessNumber,
    invoiceeBusinessNumber: parsed.invoiceeBusinessNumber,
    supplyAmount: parsed.amounts.supplyAmount,
    taxAmount: parsed.amounts.taxAmount,
    totalAmount: parsed.amounts.totalAmount,
    itemName: names.length > 0 ? names.join(" · ") : null,
    receivedAt,
  };
}
