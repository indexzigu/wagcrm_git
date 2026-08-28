/**
 * 셀 원본 값 → 표준 필드 값 결정적 변환. LLM은 관여하지 않는다(경로 A는 구조만 반환).
 */
import type { StandardField } from "./types";
import { NUMERIC_FIELDS } from "./types";

/** "30,900" / 30900 / "30900원" 등을 숫자로. 파싱 불가면 null. */
export function parseNumericCell(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const str = String(value).trim();
  if (str === "") return null;

  // 비율 필드용: "33%" -> 0.33 처리는 parseRateCell에서 별도 수행.
  const cleaned = str.replace(/[,\s원₩]/g, "");
  if (cleaned === "") return null;

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * 수수료율/할인율처럼 0~1 소수 또는 "33%" 문자열로 들어올 수 있는 값을 0~1 소수로 정규화.
 * 원본이 이미 0.33 같은 소수(엑셀 퍼센트 서식)면 그대로 두고, "33%"/"33"(1보다 큰 정수)이면 /100.
 */
export function parseRateCell(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 1 ? value / 100 : value;
  }
  const str = String(value).trim();
  if (str === "") return null;
  const hasPercent = str.includes("%");
  const cleaned = str.replace(/[%,\s]/g, "");
  if (cleaned === "") return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  if (hasPercent) return num / 100;
  return num > 1 ? num / 100 : num;
}

export function parseFieldValue(field: StandardField, raw: unknown): string | number | null {
  if (field === "productName" || field === "optionName" || field === "note") {
    if (raw === null || raw === undefined) return null;
    const str = String(raw).trim();
    return str === "" ? null : str;
  }
  if (field === "commissionRate" || field === "discountRate") {
    return parseRateCell(raw);
  }
  if (NUMERIC_FIELDS.includes(field)) {
    return parseNumericCell(raw);
  }
  return null;
}
