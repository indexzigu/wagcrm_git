// 전년도 신고 기준 참고값 — **DB 에서 읽는 유일한 경로**(서버 전용).
//
// ⛔ **실제 신고 수치를 이 파일이나 다른 추적 파일에 적지 말 것.** 종전에는
// `pnl-report.ts` 가 소득세·부가세 신고 실수치를 상수로 들고 있었는데, 이 레포는
// 공개라 push 순간 밖으로 나간다(P0 Public Repo Data Guard). DB 에 속하는 데이터는
// DB 에 둔다(오너 지시 2026-10-05). 재발은
// `__tests__/prior-year-tax-reference.contract.test.ts` 가 AST 스캔으로 막는다.
//
// **저장 위치:** `ReminderSettings.settings`(단일 행 JSON 문자열)의
// `priorYearTaxReference` 키. 이 레포에 있는 유일한 범용 JSON 설정 저장소라 새 테이블
// 없이 재사용한다 — 모델 이름과 달리 실체는 "운영 설정 한 덩어리"다.
// ⚠️ 그래서 `updateReminderSettings` 는 **자기가 모르는 키를 보존해야 한다**
// (`reminder-settings.ts` — 종전에는 알려진 키만 다시 써서 다른 키를 지웠다).
//
// **저장하는 것은 원자료뿐이다.** 실효세율·반기 비중·월평균은 원자료에서 계산하므로
// 저장하지 않는다 — 둘 다 저장하면 서로 어긋난 값이 생길 수 있다.

import { z } from "zod";

import type { PriorYearTaxReference } from "./pnl-report";
import { getPrisma } from "./prisma";

/** `ReminderSettings.settings` JSON 안에서 이 값이 사는 키. */
export const PRIOR_YEAR_TAX_REFERENCE_KEY = "priorYearTaxReference";

const amount = z.number().nonnegative();

const vatHalfYearSchema = z.object({
  periodLabel: z.string().min(1),
  taxableSales: amount,
  payableVat: amount,
});

/** DB 에 저장되는 모양(원자료). 파생값은 `derivePriorYearTaxReference` 가 만든다. */
export const storedPriorYearTaxReferenceSchema = z.object({
  incomeYear: z.number().int().positive(),
  filingYear: z.number().int().positive(),
  businessContext: z.string(),
  totalIncome: amount,
  deductions: amount,
  taxableIncome: amount,
  calculatedTax: amount,
  finalDeterminedTax: amount,
  /** [상반기, 하반기] — 순서가 의미다(비중·월평균이 이 순서로 계산된다). */
  vatHalfYears: z.tuple([vatHalfYearSchema, vatHalfYearSchema]),
});

export type StoredPriorYearTaxReference = z.infer<typeof storedPriorYearTaxReferenceSchema>;

const MONTHS_PER_HALF_YEAR = 6;

function percentOf(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** 저장된 원자료에서 리포트용 파생값을 계산한다(순수). */
export function derivePriorYearTaxReference(
  stored: StoredPriorYearTaxReference,
): PriorYearTaxReference {
  const [firstHalf, secondHalf] = stored.vatHalfYears;
  const vatAnnualTaxableSales = firstHalf.taxableSales + secondHalf.taxableSales;

  return {
    incomeYear: stored.incomeYear,
    filingYear: stored.filingYear,
    businessContext: stored.businessContext,
    totalIncome: stored.totalIncome,
    deductions: stored.deductions,
    taxableIncome: stored.taxableIncome,
    calculatedTax: stored.calculatedTax,
    finalDeterminedTax: stored.finalDeterminedTax,
    effectiveTaxRate: percentOf(stored.finalDeterminedTax, stored.taxableIncome),
    vatHalfYears: [firstHalf, secondHalf],
    vatAnnualTaxableSales,
    firstHalfSalesRatio: percentOf(firstHalf.taxableSales, vatAnnualTaxableSales),
    secondHalfSalesRatio: percentOf(secondHalf.taxableSales, vatAnnualTaxableSales),
    firstHalfMonthlyAverage: firstHalf.taxableSales / MONTHS_PER_HALF_YEAR,
    secondHalfMonthlyAverage: secondHalf.taxableSales / MONTHS_PER_HALF_YEAR,
  };
}

/**
 * 설정 JSON 문자열에서 참고값을 꺼내 검증한다(순수 — DB 무접촉).
 *
 * 키가 없으면 조용히 `null`(미등록은 정상 상태다). **키가 있는데 모양이 깨졌으면**
 * 경고를 남기고 `null` — 미등록과 같게 그리되 삼키지는 않는다.
 * ⛔ 경고에 값을 싣지 말 것: 어긋난 **필드 경로와 오류 코드만** 남긴다(로그가 수치의
 * 유출 경로가 되지 않도록).
 */
export function parsePriorYearTaxReference(
  settingsJson: string | null | undefined,
): PriorYearTaxReference | null {
  if (!settingsJson) return null;

  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    console.warn("[prior-year-tax-reference] 설정 JSON 을 해석하지 못했습니다 — 기준 자료 미등록으로 처리합니다.");
    return null;
  }

  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    console.warn("[prior-year-tax-reference] 설정 JSON 이 객체가 아닙니다 — 기준 자료 미등록으로 처리합니다.");
    return null;
  }

  const raw = (settings as Record<string, unknown>)[PRIOR_YEAR_TAX_REFERENCE_KEY];
  if (raw === undefined || raw === null) return null;

  const parsed = storedPriorYearTaxReferenceSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
      .join(", ");
    console.warn(
      `[prior-year-tax-reference] 저장된 값의 모양이 맞지 않습니다 — 기준 자료 미등록으로 처리합니다. (${problems})`,
    );
    return null;
  }

  return derivePriorYearTaxReference(parsed.data);
}

/**
 * DB 에서 전년도 신고 기준 참고값을 읽는다. 등록된 행이 없으면 `null`.
 *
 * DB 조회 실패는 잡지 않는다 — 호출부(손익 리포트)의 캠페인 조회도 같은 DB 라 함께
 * 실패하는 것이 맞고, 여기서 삼키면 "미등록"과 "DB 장애"가 구분되지 않는다.
 */
export async function loadPriorYearTaxReference(): Promise<PriorYearTaxReference | null> {
  const row = await getPrisma().reminderSettings.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { settings: true },
  });
  return parsePriorYearTaxReference(row?.settings);
}
