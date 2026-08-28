/**
 * PriceSheetRow.flags 계산 — 경로 A/B 공통.
 * 사은품/단독구매불가/음수마진 등 검수자가 바로 봐야 할 신호를 결정적으로 계산한다.
 */
import type { RowFlags } from "./types";

const GIFT_KEYWORDS = ["증정", "사은품", "선착순", "이벤트"];
const SINGLE_PURCHASE_BLOCKED_KEYWORDS = ["단독구매불가", "단독 구매 불가", "묶음구매만"];

export function computeRowFlags(input: {
  productName?: string | null;
  optionName?: string | null;
  note?: string | null;
  sellingPrice?: number | null;
  supplyPrice?: number | null;
  missingRequiredField?: boolean;
}): RowFlags {
  const flags: RowFlags = {};
  const reasons: string[] = [];

  const haystack = [input.productName, input.optionName, input.note].filter(Boolean).join(" ");

  if (GIFT_KEYWORDS.some((kw) => haystack.includes(kw))) {
    flags.giftOrBundle = true;
    reasons.push("증정/사은품 키워드 검출");
  }

  if (SINGLE_PURCHASE_BLOCKED_KEYWORDS.some((kw) => haystack.includes(kw))) {
    flags.singlePurchaseBlocked = true;
    reasons.push("단독구매불가 키워드 검출");
  }

  if (
    typeof input.sellingPrice === "number" &&
    typeof input.supplyPrice === "number" &&
    input.sellingPrice - input.supplyPrice < 0
  ) {
    flags.negativeMargin = true;
    reasons.push("판매가 < 공급가(음수마진)");
  }

  if (input.missingRequiredField) {
    flags.missingRequiredField = true;
    flags.needsReview = true;
    reasons.push("필수 필드 누락");
  }

  if (reasons.length > 0) {
    flags.reason = reasons;
  }

  return flags;
}
