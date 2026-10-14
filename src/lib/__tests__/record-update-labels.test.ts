import { describe, expect, it } from "vitest";
import { FIELD_LABELS as FIELD_LABELS_FROM_ACTIVITY_LOG } from "@/lib/activity-log";
import { FIELD_LABELS } from "@/lib/field-labels";
import { formatRecordValue, recordFieldLabel } from "@/lib/record-update-labels";

describe("record-update-labels", () => {
  it("감사 기록 표는 옮긴 뒤에도 같은 객체다(activity-log 가 다시 내보낸다)", () => {
    expect(FIELD_LABELS_FROM_ACTIVITY_LOG).toBe(FIELD_LABELS);
  });

  it("칸 이름 — 캠페인은 캠페인 표, 나머지는 감사 기록 표, 없으면 칸 이름 그대로", () => {
    expect(recordFieldLabel("CAMPAIGN", "salesChannel")).toBe("판매 채널");
    expect(recordFieldLabel("CAMPAIGN", "settlementSales")).toBe("영업 수익");
    expect(recordFieldLabel("DEAL", "sellingPrice")).toBe("판매가");
    expect(recordFieldLabel("SELLER", "unknownFieldX")).toBe("unknownFieldX");
  });

  it("값 표기 — 비어 있음·참거짓·채널·상태 화면 이름", () => {
    expect(formatRecordValue("CAMPAIGN", "supplierInvoiceIssuedAt", null)).toBe("비어 있음");
    expect(formatRecordValue("CAMPAIGN", "isManualMargin", true)).toBe("예");
    expect(formatRecordValue("CAMPAIGN", "salesChannel", "BRAND_MALL")).toBe("브랜드몰");
    expect(formatRecordValue("CAMPAIGN", "status", "COMPLETED")).not.toBe("COMPLETED");
    expect(formatRecordValue("DEAL", "sellingPrice", 12000)).toBe("12,000");
    expect(formatRecordValue("PARTNER", "notes", "")).toBe("빈 글");
  });
});
