import type { NaverOrderField, OrderExcelColumnSource } from "@/lib/order-converter/excel-rules";

// 검수 편집 상태 — 스키마의 source와 동일하되, field 타입은 "아직 선택 안 됨"(field: null)을 허용.
// 확정 시 incomplete 열이 있으면 저장을 막는다(빈 필드가 조용히 '비움'으로 확정되는 것 방지).
export type EditableColumnSource =
  | OrderExcelColumnSource
  | { type: "field"; field: null };

export type EditableColumnRule = {
  col: number;
  header: string;
  source: EditableColumnSource;
};

export function isIncompleteSource(source: EditableColumnSource): boolean {
  return source.type === "field" && !source.field;
}

/** 확정 가능 소스로 좁히기 — incomplete면 null. */
export function toConfirmedSource(source: EditableColumnSource): OrderExcelColumnSource | null {
  if (isIncompleteSource(source)) return null;
  return source as OrderExcelColumnSource;
}

/** 구매자/수취인 계열 — 사람도 헷갈리는 위험 필드(흔한 주문에선 값이 같아 오매핑이 안 보임). */
export function riskyFieldNote(source: EditableColumnSource): string | null {
  if (source.type !== "field" || !source.field) return null;
  const field: NaverOrderField = source.field;
  if (field.startsWith("구매자")) {
    return "주문자 정보입니다. 선물 주문에서는 수령인과 다를 수 있어요.";
  }
  if (field.startsWith("수취인")) {
    return "수령인 정보입니다. 선물 주문에서는 구매자와 다릅니다.";
  }
  return null;
}
