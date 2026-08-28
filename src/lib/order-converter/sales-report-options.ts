/**
 * Produces the option label used by the sales report from Naver's order data.
 *
 * Product mappings determine whether an order belongs to a campaign and which
 * price applies. They are not the source of truth for the option a customer
 * selected, because a mapping can intentionally contain a product-level name.
 */
export function resolveSalesReportOptionLabel(
  productName: string | null | undefined,
  productOption: string | null | undefined,
): string {
  const normalizedProductName = productName?.trim() ?? "";
  const rawOption = productOption
    ?.replace(/^\s*(?:제품|상품|옵션명?)\s*:\s*/i, "")
    .trim() ?? "";

  if (!rawOption) {
    return "기본 옵션";
  }

  if (!normalizedProductName) {
    return rawOption;
  }

  if (rawOption === normalizedProductName) {
    return "기본 옵션";
  }

  // Some Naver responses repeat the product name before the actual variant.
  // Remove only a leading exact product label so the selected variant remains.
  if (rawOption.startsWith(normalizedProductName)) {
    const variant = rawOption
      .slice(normalizedProductName.length)
      .replace(/^[\s/|:>-]+/, "")
      .trim();

    return variant || "기본 옵션";
  }

  return rawOption;
}
