import { describe, expect, it } from "vitest";
import { applyPartnerEnrichment, planPartnerEnrichment } from "../partner-enrichment";

describe("planPartnerEnrichment", () => {
  it("기안이 비어 있는 칸만 채우고, 같은 값은 SAME, 다른 값은 기안 값을 유지한다", () => {
    const plan = planPartnerEnrichment(
      { name: "테스트공급", type: "VENDOR", ceoName: "대화대표", businessNumber: "111-22-33333" },
      {
        businessNumber: "1112233333",
        ceoName: "계산서대표",
        address: "서울 가상로 1",
        representativeEmail: "vendor-tax@example.com",
      },
    );
    expect(plan.rows).toEqual([
      { field: "businessNumber", invoiceValue: "1112233333", proposedValue: "111-22-33333", outcome: "SAME" },
      { field: "ceoName", invoiceValue: "계산서대표", proposedValue: "대화대표", outcome: "KEEP" },
      { field: "address", invoiceValue: "서울 가상로 1", proposedValue: null, outcome: "FILL" },
      { field: "representativeEmail", invoiceValue: "vendor-tax@example.com", proposedValue: null, outcome: "FILL" },
    ]);
    expect(plan.fills).toEqual({ address: "서울 가상로 1", representativeEmail: "vendor-tax@example.com" });
  });

  it("계산서에 없는 칸은 줄을 만들지 않는다", () => {
    expect(planPartnerEnrichment({ name: "x" }, {}).rows).toEqual([]);
  });
});

describe("applyPartnerEnrichment", () => {
  it("빈 칸만 채우고 원본 객체를 바꾸지 않는다", () => {
    const original = { name: "테스트공급", type: "VENDOR", ceoName: "대화대표" };
    const result = applyPartnerEnrichment(original, {
      ceoName: "계산서대표",
      businessType: "도소매",
      businessNumber: "111-22-33333",
    });
    expect(result.partner).toEqual({
      name: "테스트공급",
      type: "VENDOR",
      ceoName: "대화대표",
      businessType: "도소매",
      businessNumber: "1112233333",
    });
    expect(result.filled).toEqual(["businessNumber", "businessType"]);
    expect(original).toEqual({ name: "테스트공급", type: "VENDOR", ceoName: "대화대표" });
  });
});

describe("planPartnerEnrichment — 저장할 수 없는 값", () => {
  it("계약 검사를 넘지 못한 빈 칸은 INVALID 로 두고 채울 값에서 뺀다", () => {
    const plan = planPartnerEnrichment(
      { name: "x" },
      { address: "아주 긴 주소", ceoName: "대표" },
      (field) => field !== "address",
    );
    expect(plan.rows.map((row) => [row.field, row.outcome])).toEqual([
      ["ceoName", "FILL"],
      ["address", "INVALID"],
    ]);
    expect(plan.fills).toEqual({ ceoName: "대표" });
  });
});
