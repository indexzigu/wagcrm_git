/**
 * 거래처 「사업자 정보 동기화」의 칸 판정 — 순수 함수(네트워크·Prisma 무의존).
 *
 * 출처는 셋이고 칸마다 이 순서로 고른다:
 *   1. bizno.net 스크랩 — 대표자·주소·업태·종목 (등록 직후 사업자는 자료가 없어 전부 "-" 로 뜬다)
 *   2. 메일함의 전자세금계산서 — 1이 비운 칸만 보충 (`partner-invoice-lookup.ts`)
 *   3. 이미 저장된 값 — 위 둘이 다 비우면 그대로 둔다
 *
 * ⛔ bizno 는 자료 없는 칸을 "-" 로 그린다. 그것을 값으로 저장하면 「대표자명: -」가 되어
 *    화면에서 채워진 것처럼 보이고, 빈 칸을 세는 판정(보충 조회·빠진 칸 알림)도 속는다.
 *    그래서 저장값의 "-" 도 빈 칸으로 본다 — 재동기화 때 스스로 지워진다.
 */

/** 오너가 「기본 정보」로 보는 칸 — 동기화 뒤에도 비어 있으면 화면이 빠진 칸을 알린다. */
export const CORE_BUSINESS_FIELDS = ["ceoName", "businessType", "businessItem"] as const;
export type CoreBusinessField = (typeof CORE_BUSINESS_FIELDS)[number];

/** 계산서로 보충할 수 있는 칸(기본 정보 + 주소). */
export const SUPPLEMENTABLE_FIELDS = [...CORE_BUSINESS_FIELDS, "address"] as const;
export type SupplementableField = (typeof SUPPLEMENTABLE_FIELDS)[number];

/** 자료 없음 표기: 하이픈·전각 하이픈·대시류 한 글자. */
const PLACEHOLDER_PATTERN = /^[-‐‑‒–—―－]$/;

/** 빈 값·자료 없음 표기("-")를 null 로 접는다. */
export function normalizeBusinessValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || PLACEHOLDER_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export type BusinessFieldValues = Partial<Record<SupplementableField, string | null>>;

export type InvoiceLookupOutcome =
  /** 보충할 칸이 없어 메일함을 열지 않았다 */
  | { status: "SKIPPED" }
  | { status: "FOUND"; values: BusinessFieldValues }
  | { status: "NOT_FOUND" }
  /** 메일함 조회 자체가 실패했다 — 「계산서 없음」과 구분해 화면에 알린다 */
  | { status: "FAILED"; message: string };

/**
 * bizno 결과와 저장값만 보고, 계산서로 보충해야 할 칸을 고른다.
 * 저장값이 이미 진짜 값이면(사업자등록증 업로드 등) 메일함을 열지 않는다.
 */
export function fieldsNeedingSupplement(
  current: BusinessFieldValues,
  scraped: BusinessFieldValues,
): SupplementableField[] {
  return SUPPLEMENTABLE_FIELDS.filter(
    (field) => normalizeBusinessValue(scraped[field]) === null && normalizeBusinessValue(current[field]) === null,
  );
}

export type BusinessFieldResolution = {
  /** DB 에 쓸 칸만(바뀌지 않는 칸은 넣지 않는다). null 은 "-" 같은 자리표시 저장값을 지우는 쓰기다. */
  updates: Partial<Record<SupplementableField, string | null>>;
  /** 계산서에서 채운 칸 */
  filledFromInvoice: SupplementableField[];
  /** 동기화 뒤에도 비어 있는 기본 정보 칸 */
  missingFields: CoreBusinessField[];
};

/** 세 출처를 칸마다 합친다. */
export function resolveBusinessFields(input: {
  current: BusinessFieldValues;
  scraped: BusinessFieldValues;
  invoice: BusinessFieldValues | null;
}): BusinessFieldResolution {
  const updates: BusinessFieldResolution["updates"] = {};
  const filledFromInvoice: SupplementableField[] = [];
  const finalValues: Partial<Record<SupplementableField, string | null>> = {};

  for (const field of SUPPLEMENTABLE_FIELDS) {
    const scraped = normalizeBusinessValue(input.scraped[field]);
    const fromInvoice = normalizeBusinessValue(input.invoice?.[field]);
    const rawCurrent = input.current[field] ?? null;
    const current = normalizeBusinessValue(rawCurrent);

    let next: string | null;
    if (scraped !== null) {
      next = scraped;
    } else if (current !== null) {
      next = current;
    } else if (fromInvoice !== null) {
      next = fromInvoice;
      filledFromInvoice.push(field);
    } else {
      next = null;
    }

    finalValues[field] = next;
    if (next !== rawCurrent) updates[field] = next;
  }

  const missingFields = CORE_BUSINESS_FIELDS.filter((field) => finalValues[field] === null);
  return { updates, filledFromInvoice, missingFields };
}

/** 화면 이름 — `field-labels.ts` 의 같은 칸 이름과 맞춘다. */
const FIELD_NAMES: Record<SupplementableField, string> = {
  ceoName: "대표자명",
  businessType: "업태",
  businessItem: "종목",
  address: "사업장 주소",
};

/** 동기화 응답 중 알림이 읽는 부분. */
export type BusinessSyncNotice = {
  missingFields?: readonly CoreBusinessField[];
  filledFromInvoice?: readonly SupplementableField[];
  invoiceLookup?: { status: string; message?: string };
  /** bizno.net 조회 자체가 실패했다(응답 오류·시간 초과) — 자료 없음과 다르다 */
  biznoFailed?: boolean;
  bizCompanyName?: string | null;
};

/**
 * 동기화 버튼 알림 한 개의 문구.
 * 기본 정보 칸이 남아 비어 있으면 성공처럼 보이지 않게 경고로 알리고, 다음 할 일(사업자등록증
 * 올리기)을 함께 적는다 — 「동기화되었습니다」만 띄우면 빈 칸이 버그처럼 보였다.
 */
export function describeBusinessSync(
  notice: BusinessSyncNotice,
  partnerName: string | null,
): { tone: "success" | "warning"; title: string; description?: string } {
  const missing = notice.missingFields ?? [];
  const filled = notice.filledFromInvoice ?? [];
  const details: string[] = [];

  if (filled.length > 0) {
    details.push(`세금계산서에서 ${filled.map((field) => FIELD_NAMES[field]).join("·")} 채움`);
  }
  if (notice.biznoFailed) {
    details.push("사업자 조회 사이트(bizno) 응답 실패 — 잠시 뒤 다시 시도해 주세요");
  }
  if (notice.invoiceLookup?.status === "FAILED") {
    details.push(`메일함 조회 실패: ${notice.invoiceLookup.message ?? "원인 미상"}`);
  }
  if (notice.bizCompanyName && notice.bizCompanyName !== partnerName) {
    details.push(`조회된 상호: ${notice.bizCompanyName} (거래처명 유지)`);
  }

  if (missing.length > 0) {
    const names = missing.map((field) => FIELD_NAMES[field]).join("·");
    return {
      tone: "warning",
      title: `${names} 정보를 찾지 못했습니다.`,
      description: [...details, "사업자등록증을 올리면 채울 수 있습니다."].join(" · "),
    };
  }
  return {
    tone: "success",
    title: "사업자 정보가 동기화되었습니다.",
    description: details.length > 0 ? details.join(" · ") : undefined,
  };
}
