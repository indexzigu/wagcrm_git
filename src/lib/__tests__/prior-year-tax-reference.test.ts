import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ reminderSettings: { findFirst } }),
}));
vi.mock("../prisma", () => ({
  getPrisma: () => ({ reminderSettings: { findFirst } }),
}));

import {
  PRIOR_YEAR_TAX_REFERENCE_KEY,
  derivePriorYearTaxReference,
  loadPriorYearTaxReference,
  parsePriorYearTaxReference,
} from "@/lib/prior-year-tax-reference";

// 픽스처는 일부러 가짜임이 드러나는 둥근 수다 — 실제 신고 수치를 테스트에 적지 않는다(P0).
const STORED = {
  incomeYear: 2000,
  filingYear: 2001,
  businessContext: "테스트 기준",
  totalIncome: 1_000,
  deductions: 200,
  taxableIncome: 800,
  calculatedTax: 100,
  finalDeterminedTax: 80,
  vatHalfYears: [
    { periodLabel: "상반기", taxableSales: 600, payableVat: 60 },
    { periodLabel: "하반기", taxableSales: 1_800, payableVat: 180 },
  ],
};

function settingsWith(value: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, [PRIOR_YEAR_TAX_REFERENCE_KEY]: value });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  findFirst.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("derivePriorYearTaxReference", () => {
  it("파생값을 저장된 원자료에서 계산한다", () => {
    const reference = derivePriorYearTaxReference(
      STORED as Parameters<typeof derivePriorYearTaxReference>[0],
    );

    expect(reference).toMatchObject({
      incomeYear: 2000,
      filingYear: 2001,
      taxableIncome: 800,
      finalDeterminedTax: 80,
      effectiveTaxRate: 10,
      vatAnnualTaxableSales: 2_400,
      firstHalfSalesRatio: 25,
      secondHalfSalesRatio: 75,
      firstHalfMonthlyAverage: 100,
      secondHalfMonthlyAverage: 300,
    });
    expect(reference.vatHalfYears).toHaveLength(2);
  });

  it("분모가 0 이면 비율은 0 이다(NaN·Infinity 를 내지 않는다)", () => {
    const reference = derivePriorYearTaxReference({
      ...STORED,
      taxableIncome: 0,
      vatHalfYears: [
        { periodLabel: "상반기", taxableSales: 0, payableVat: 0 },
        { periodLabel: "하반기", taxableSales: 0, payableVat: 0 },
      ],
    } as Parameters<typeof derivePriorYearTaxReference>[0]);

    expect(reference.effectiveTaxRate).toBe(0);
    expect(reference.firstHalfSalesRatio).toBe(0);
    expect(reference.secondHalfSalesRatio).toBe(0);
  });
});

describe("parsePriorYearTaxReference", () => {
  it("키가 없으면 조용히 null 이다 — 미등록은 정상 상태", () => {
    expect(parsePriorYearTaxReference(null)).toBeNull();
    expect(parsePriorYearTaxReference(JSON.stringify({ scheduleThresholds: {} }))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("같은 JSON 의 다른 키와 함께 있어도 읽는다", () => {
    const reference = parsePriorYearTaxReference(
      settingsWith(STORED, { scheduleThresholds: { idealDays: 60 } }),
    );
    expect(reference?.vatAnnualTaxableSales).toBe(2_400);
    expect(warn).not.toHaveBeenCalled();
  });

  it("모양이 깨졌으면 null + 경고 — 경고에는 필드 경로만 있고 값은 없다", () => {
    // 식별 가능한 값을 심어 두고, 그 값이 로그에 실리지 않는지를 본다.
    const leaky = { ...STORED, totalIncome: "98765432", taxableIncome: -13579 };

    expect(parsePriorYearTaxReference(settingsWith(leaky))).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0].map(String).join(" ");
    expect(logged).toContain("totalIncome");
    expect(logged).toContain("taxableIncome");
    expect(logged).not.toContain("98765432");
    expect(logged).not.toContain("13579");
  });

  it("반기가 둘이 아니면 미등록으로 본다", () => {
    const oneHalf = { ...STORED, vatHalfYears: [STORED.vatHalfYears[0]] };
    expect(parsePriorYearTaxReference(settingsWith(oneHalf))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("JSON 자체가 깨졌으면 null + 경고(내용은 싣지 않는다)", () => {
    expect(parsePriorYearTaxReference("{not json 24680")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].map(String).join(" ")).not.toContain("24680");
  });
});

describe("loadPriorYearTaxReference", () => {
  it("설정 행이 없으면 null 이다", async () => {
    findFirst.mockResolvedValue(null);
    await expect(loadPriorYearTaxReference()).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("최신 설정 행에서 읽는다", async () => {
    findFirst.mockResolvedValue({ settings: settingsWith(STORED) });

    const reference = await loadPriorYearTaxReference();

    expect(reference?.finalDeterminedTax).toBe(80);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { updatedAt: "desc" } }),
    );
  });

  it("DB 실패는 삼키지 않는다 — 미등록과 장애를 구분한다", async () => {
    findFirst.mockRejectedValue(new Error("db down"));
    await expect(loadPriorYearTaxReference()).rejects.toThrow("db down");
  });
});
