import { describe, expect, it } from "vitest";
import { resolveSalesReportOptionLabel } from "@/lib/order-converter/sales-report-options";

describe("resolveSalesReportOptionLabel", () => {
  it("uses the order's selected option instead of a product-level mapping label", () => {
    expect(
      resolveSalesReportOptionLabel(
        "[비비랩] 지오프리질 유산균",
        "[비비랩] 지오프리질 유산균 / 1통 (1개월분)",
      ),
    ).toBe("1통 (1개월분)");
  });

  it("keeps a standalone selected option unchanged", () => {
    expect(resolveSalesReportOptionLabel("상품 A", "2박스")).toBe("2박스");
  });

  it("groups missing or product-only option values as the default option", () => {
    expect(resolveSalesReportOptionLabel("상품 A", "")).toBe("기본 옵션");
    expect(resolveSalesReportOptionLabel("상품 A", "상품 A")).toBe("기본 옵션");
  });
});
