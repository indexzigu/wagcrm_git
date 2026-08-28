/**
 * 가격표 행 → 상위딜(MAIN)·하위품목딜(OPTION) 그룹핑 SSOT (순수 모듈).
 *
 * 서버 반영 실행기(apply-executor.buildApplyActions)와 검수 화면의 "딜 반영 미리보기"가
 * 이 모듈 하나를 공유한다 — 프리뷰가 보여주는 구조와 실제 반영 결과가 갈라지면 안 되기
 * 때문에, 그룹핑 규칙을 여기 밖에 다시 구현하는 것을 금지한다.
 *
 * 클라이언트 컴포넌트가 직접 import하므로 이 파일은 순수해야 한다 — prisma·repository·
 * 서버 전용 모듈 import 금지.
 */
import { formatOptionDealName, getDisplayDealName } from "@/lib/deal-display";

/** 반영/프리뷰가 소비하는 행 입력. PriceSheetRow의 부분집합(optionName은 그룹핑에 쓰인다). */
export type ApplyRowInput = {
  id: string;
  mappingStatus: string;
  mappedDealId: string | null;
  productName: string | null;
  optionName?: string | null;
  sellingPrice: unknown;
  supplyPrice: unknown;
  listPrice: unknown;
  floorPrice: unknown;
  commissionRate: unknown;
  discountRate: unknown;
};

export type DealCreatePayload = {
  dealName: string;
  brandName?: string | null;
  partnerId?: string | null;
  costPrice: number;
  sellingPrice: number;
  supplyPrice?: number | null;
  listPrice?: number | null;
  floorPrice?: number | null;
  totalCommissionRate?: number | null;
  discountRate?: number | null;
  // 상위/하위 딜 구분(가격표 그룹핑). 단일 신규딜은 기본값(MAIN/부모없음)으로 생성된다.
  dealType?: string;
  parentDealId?: string | null;
  optionSortOrder?: number;
  // 딜 패널 옵션 관례와 동일한 구조 필드 — 상위딜은 unit만(옵션 등록 폼의 단위 설정),
  // 하위딜은 unitQuantity(+unit)·supplementaryInfo까지 옵션명에서 파싱해 채운다.
  unit?: string | null;
  unitQuantity?: number | null;
  supplementaryInfo?: string | null;
};

export function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "object" && "toString" in value) return Number((value as { toString(): string }).toString());
  return Number(value);
}

/**
 * 가격표 행의 비율(0~1 소수) → 딜의 비율(퍼센트 수치). **두 저장소의 관례가 다르다.**
 *
 * · `PriceSheetRow.commissionRate` — `parseRateCell`(value-parse.ts)이 /100 하므로 50% = `0.5`.
 * · `Deal.totalCommissionRate` — `computeSupplyPrice`(deals-panel·campaign-deals-table)가
 *   /100 하므로 50% = `50`.
 *
 * 이 경계에서 변환하지 않으면 50% 짜리 행이 딜에 **0.5%** 로 저장된다. 표시만의 문제가
 * 아니다 — 그 딜의 판매가를 수정하는 순간 공급가가 `판매가 × (1 - 0.5/100)` = 판매가의
 * **99.5%** 로 재계산돼 발주까지 흘러갈 수 있다. 프로덕션 딜 161건 중 19건이 이 상태로
 * 저장돼 있었다(2026-08-01 실측, 오너 확인 후 기존 데이터는 보존하기로 결정).
 *
 * ⛔ 반대 방향으로 "통일"하지 말 것 — 딜의 퍼센트 관례가 이미 정상 딜 124건과
 * `computeSupplyPrice` 두 구현, 캠페인 표 전반에 퍼져 있다. 경계에서 변환하는 것이
 * 훨씬 좁은 수술이다.
 */
export function rateToDealPercent(value: unknown): number | null {
  const rate = decimalToNumber(value);
  if (rate === null || !Number.isFinite(rate)) return null;
  // 소수점 둘째 자리까지 — 0.3333 → 33.33. 곱셈 부동소수 오차(33.329999…)를 남기지 않는다.
  return Math.round(rate * 10000) / 100;
}

// 옵션명 파서 — 딜 패널 옵션 관례의 구조 필드(수량·단위·보조정보)를 옵션명에서 복원한다.
// "파이토 샐러드샷 2박스 (1개월분)" → { base: "파이토 샐러드샷", quantity: 2, unit: "박스",
// supplementary: "1개월분" }. 순서: 끝 괄호(보조정보) → 끝 수량+단위 → 남는 것이 베이스.
// 단위 앞에 숫자가 붙어야만 매칭돼 "포켓"의 '포'는 걸리지 않는다.
const PACK_UNIT_WORDS = "개|통|팩|박스|세트|병|캔|포";
const PACK_QTY_RE = new RegExp(`(\\d+)\\s*(${PACK_UNIT_WORDS})`, "g");
const TRAILING_PAREN_RE = /\(([^()]*)\)\s*$/;
const TRAILING_QTY_UNIT_RE = new RegExp(`\\s*(\\d+)\\s*(${PACK_UNIT_WORDS})\\s*$`);

export type ParsedOptionName = {
  /** 수량·단위·보조정보를 뗀 제품 정체성("애사비 젤리"). 그룹핑 2차 키. */
  base: string | null;
  quantity: number | null;
  unit: string | null;
  /** 끝 괄호 안 텍스트("1개월분") — 딜 패널의 보조 정보 필드로 들어간다. */
  supplementary: string | null;
};

// 괄호 안이 순수 "수량+단위"("(2박스)")인지 판별 — 이 경우 보조정보가 아니라 구성 수량이다.
const PAREN_PURE_QTY_RE = new RegExp(`^(\\d+)\\s*(${PACK_UNIT_WORDS})$`);

export function parseOptionName(optionName: string | null | undefined): ParsedOptionName {
  if (!optionName) return { base: null, quantity: null, unit: null, supplementary: null };
  let rest = optionName.trim();

  // 끝 괄호를 먼저 분리하되, 내용이 순수 수량+단위("(2박스)")면 보조정보가 아니라
  // 구성 수량 후보로 든다 — 괄호를 무조건 보조정보로 삼키면 "제품명 (2박스)" 형태에서
  // 수량이 유실돼 상위딜이 빈 컨테이너(0원)가 되고 딜명 중복 표기 폴백이 재발한다.
  let supplementary: string | null = null;
  let parenQty: { quantity: number; unit: string } | null = null;
  const paren = rest.match(TRAILING_PAREN_RE);
  if (paren) {
    const inner = paren[1].trim();
    const innerQty = inner.match(PAREN_PURE_QTY_RE);
    if (innerQty && Number.isFinite(Number(innerQty[1]))) {
      parenQty = { quantity: Number(innerQty[1]), unit: innerQty[2] };
    } else {
      supplementary = inner || null;
    }
    rest = rest.replace(TRAILING_PAREN_RE, "").trim();
  }

  let quantity: number | null = null;
  let unit: string | null = null;
  const trailing = rest.match(TRAILING_QTY_UNIT_RE);
  if (trailing) {
    // 괄호 밖 끝 수량이 구성 수량의 정본 — 괄호 안 수량 후보는 보조정보로 강등한다
    // ("베이스 2박스 (1개)" → 수량 2박스, 보조정보 "1개").
    quantity = Number(trailing[1]);
    unit = trailing[2];
    rest = rest.replace(TRAILING_QTY_UNIT_RE, "").trim();
    if (parenQty && supplementary === null) {
      supplementary = `${parenQty.quantity}${parenQty.unit}`;
    }
  } else if (parenQty) {
    quantity = parenQty.quantity;
    unit = parenQty.unit;
  } else {
    // 수량이 끝에 없으면 참고값으로만 취한다(마지막 매치) — 베이스는 자르지 않는다.
    // 제품명 앞쪽 용량 숫자보다 구성 수량이 뒤에 오는 관례를 따른다.
    PACK_QTY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((match = PACK_QTY_RE.exec(rest)) !== null) last = match;
    if (last) {
      quantity = Number(last[1]);
      unit = last[2];
    }
  }

  return {
    base: rest.length > 0 ? rest : null,
    quantity: quantity !== null && Number.isFinite(quantity) ? quantity : null,
    unit,
    supplementary,
  };
}

/** 옵션명의 구성 수량("…젤리 2팩" → 2). 상위딜 가격 상속의 "단위 1" 판정에 쓴다. */
export function extractPackQuantity(optionName: string | null | undefined): number | null {
  return parseOptionName(optionName).quantity;
}

/**
 * 옵션명에서 "구성 베이스"(수량·단위·보조정보를 뗀 제품 정체성)를 뽑는다 — 그룹핑 2차 키.
 * 좌측 제품명이 같아도(오입력 등) 구성 베이스가 다르면 서로 다른 딜로 갈린다
 * (콜라겐 vs 애사비젤리). 수량만 다른 옵션(3통/6통/9통)은 같은 베이스로 남는다.
 */
export function extractOptionBase(optionName: string | null | undefined): string | null {
  return parseOptionName(optionName).base;
}

// 제품명이 "브랜드 제품라인 …"(3토큰 이상)일 때만 첫 토큰(브랜드)을 딜명에서 뗀다.
// 2토큰 이름("애사비 젤리")은 첫 토큰이 브랜드가 아닐 확률이 높아 보수적으로 유지 —
// 잘못 떼면 딜명이 "젤리"처럼 망가지는데, 브랜드 중복 표기는 검수에서 고치면 그만이다.
function stripBrandFromProductName(productName: string): string {
  const trimmed = productName.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 3) return trimmed;
  if (!extractBrandName(trimmed)) return trimmed;
  return tokens.slice(1).join(" ");
}

// 그룹핑 키: 문자열을 공백 정규화 + 소문자화. 표시는 원본(첫 행)을 쓴다.
function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// 제품명에서 브랜드명을 추출한다 — 이 도메인의 가격표 제품명은 "브랜드 제품라인 …"
// 형태가 관례라 첫 공백 토큰을 브랜드 후보로 본다("비비랩 애사비 젤리" → "비비랩").
// 괄호 등 장식은 벗기고, 1글자 토큰은 브랜드로 보기 어려워 버린다(검수자가 수정 가능한
// 제안값이지 확정값이 아니다).
export function extractBrandName(productName: string | null | undefined): string | null {
  if (!productName) return null;
  const first = productName.trim().split(/\s+/)[0] ?? "";
  const cleaned = first.replace(/[()[\]{}]/g, "").trim();
  return cleaned.length >= 2 ? cleaned : null;
}

export type PartnerOption = { id: string; name: string };

/**
 * 브랜드명으로 거래처를 자동 매칭한다 — 정확 일치 우선, 없으면 포함 관계
 * (거래처명 ⊇ 브랜드 또는 브랜드 ⊇ 거래처명). 검수 화면의 기본값 제안용이며,
 * 최종 연결은 항상 검수자가 확인·수정한다.
 */
export function matchPartnerByBrand(
  partners: PartnerOption[],
  brandName: string | null | undefined
): PartnerOption | null {
  if (!brandName) return null;
  const key = normalizeKey(brandName);
  if (!key) return null;
  const exact = partners.find((p) => normalizeKey(p.name) === key);
  if (exact) return exact;
  return (
    partners.find((p) => {
      const pk = normalizeKey(p.name);
      return pk.length > 0 && (pk.includes(key) || key.includes(pk));
    }) ?? null
  );
}

/**
 * 그룹 단위 반영 오버라이드 — 검수 화면에서 확인·수정한 브랜드명·거래처 연결.
 * undefined 필드 = 기본값 사용(브랜드는 extractBrandName 추출값, 거래처는 시트 거래처),
 * null = 명시적으로 비움. 키는 ComputedDealGroup.groupKey.
 */
export type DealGroupOverride = {
  brandName?: string | null;
  partnerId?: string | null;
};

/** 묶음 그룹의 고정 groupKey — 브랜드·거래처 오버라이드가 이 키로 걸린다. */
export const BUNDLE_GROUP_KEY = "__bundle__";

/**
 * 묶음의 상위딜 대상.
 * EXISTING의 이름·브랜드·거래처는 **서버가 DB에서 재해석한 값**이 정본이다
 * (클라이언트가 보낸 값을 그대로 믿지 않는다 — apply 라우트가 덮어쓴다).
 */
export type BundleTarget =
  | { kind: "NEW"; parentDealName: string }
  | {
      kind: "EXISTING";
      dealId: string;
      parentDealName: string;
      parentBrandName: string | null;
      parentPartnerId: string | null;
    };

/**
 * 시트 단위 반영 방식. AUTO = 현행 규칙(제품명+구성베이스).
 * BUNDLE = 신규 행들을 한 상위딜의 하위품목으로 묶는다. excludedRowIds에 든 행은
 * 묶음에서 빠져 AUTO 규칙으로 따로 처리된다.
 */
export type BundlePolicy =
  | { mode: "AUTO" }
  | { mode: "BUNDLE"; target: BundleTarget; excludedRowIds: string[] };

/** 신규 행 하나를 DealCreatePayload로 변환한다(필수값 없으면 null). */
export function toCreatePayload(
  row: ApplyRowInput,
  partnerId: string | null,
  overrides: Partial<DealCreatePayload> = {}
): DealCreatePayload | null {
  const sellingPrice = decimalToNumber(row.sellingPrice);
  if (!row.productName || sellingPrice === null) return null;
  const supplyPrice = decimalToNumber(row.supplyPrice);
  return {
    dealName: row.productName,
    partnerId,
    costPrice: supplyPrice ?? 0,
    sellingPrice,
    supplyPrice,
    listPrice: decimalToNumber(row.listPrice),
    floorPrice: decimalToNumber(row.floorPrice),
    // 비율만 단위가 다르다 — 가격표는 0~1 소수, 딜은 퍼센트 수치(rateToDealPercent 참조).
    totalCommissionRate: rateToDealPercent(row.commissionRate),
    discountRate: rateToDealPercent(row.discountRate),
    ...overrides,
  };
}

/** 그룹 하나 = 반영 시 생성될 딜 1개(단일) 또는 상위딜+하위품목딜 묶음. */
export type ComputedDealGroup = {
  /** 안정 식별 키(제품명+구성베이스 정규화) — 클라이언트 오버라이드와 서버 반영이 공유한다. */
  groupKey: string;
  /** 상위딜(또는 단일 딜) 이름 — 동명이인 구분이 필요하면 "제품명 - 구성베이스". */
  parentDealName: string;
  /** 제품명에서 추출한 브랜드명 제안(오버라이드 없을 때의 기본값). */
  suggestedBrandName: string | null;
  /** 생성될 상위딜(단일 그룹이면 그 딜 자체) payload. */
  parent: DealCreatePayload;
  /** 하위품목딜 payload 목록. 단일 그룹(옵션 1개)이면 null — 평평한 딜 하나로 생성된다. */
  options: DealCreatePayload[] | null;
  /**
   * 상위딜 가격의 출처: 단일 딜 자신 / "단위 1" 기본 옵션 상속 / 빈 컨테이너(0원) /
   * 기존 딜에 붙임(상위딜을 만들지 않음).
   */
  parentPriceSource: "single" | "base-option" | "empty" | "existing";
  /** 기존 딜에 붙이는 묶음이면 그 딜 id. null이면 상위딜을 새로 만든다. */
  attachToDealId: string | null;
  /** 이 그룹에 포함된 행 id들(프리뷰 ↔ 검수표 상호 하이라이트용). */
  rowIds: string[];
};

export type DealGroupComputation = {
  groups: ComputedDealGroup[];
  /** NEW_DEAL인데 필수값(제품명/판매가) 누락으로 반영에서 제외될 행 id들. */
  skippedRowIds: string[];
};

/**
 * NEW_DEAL 행들을 (제품명 + 구성 베이스)로 그룹핑한다 — 반영 실행기와 프리뷰의 공용 SSOT.
 * 좌측 제품명이 같아도(소스 오입력 등) 구성 베이스가 다르면 서로 다른 딜로 갈린다
 * (예: "저분자콜라겐S" vs "애사비 젤리"). 수량만 다른 옵션(3통/6통/9통)은 같은 베이스라
 * 한 딜로 묶인다 — LLM의 표 세그먼트에 의존하지 않는 결정적 규칙.
 * · 그룹 크기 1 → 평범한 단일 상위딜(options=null).
 * · 그룹 크기 ≥2 → 상위딜(MAIN) 1 + 하위품목딜(OPTION) N. 상위딜 가격은 "단위 1"
 *   (1개/1통/1팩 등) 옵션이 있으면 상속, 없으면 빈 컨테이너 0원(오너 결정 2026-07-16).
 * · 같은 제품명이 구성 베이스 여러 개로 갈릴 때만 상위딜명을 "제품명 - 구성베이스"로 구분.
 */
function computeAutoGroups(
  rows: ApplyRowInput[],
  partnerId: string | null,
  // 그룹별 브랜드·거래처 오버라이드(키 = groupKey). 검수 화면이 확인·수정한 값을 반영
  // 실행기에 그대로 전달한다 — 미전달 그룹은 브랜드=추출 제안값, 거래처=시트 거래처.
  overrides?: Record<string, DealGroupOverride>
): DealGroupComputation {
  const KEY_SEP = "\u0000"; // 정규화 텍스트에 나올 수 없는 구분자(제품명·베이스 경계 충돌 방지)
  const buckets = new Map<
    string,
    { productName: string; optionBase: string | null; rows: ApplyRowInput[] }
  >();
  const skippedRowIds: string[] = [];

  for (const row of rows) {
    if (row.mappingStatus !== "NEW_DEAL") continue;
    if (!row.productName) {
      skippedRowIds.push(row.id);
      continue;
    }
    const optionBase = extractOptionBase(row.optionName);
    const key = `${normalizeKey(row.productName)}${KEY_SEP}${optionBase ? normalizeKey(optionBase) : ""}`;
    const existing = buckets.get(key);
    if (existing) existing.rows.push(row);
    else buckets.set(key, { productName: row.productName, optionBase, rows: [row] });
  }

  // 같은 제품명이 몇 개의 서로 다른 구성 베이스로 갈리는지 — 2개 이상이면 이름 구분이 필요하다.
  const baseCountByProduct = new Map<string, number>();
  for (const bucket of buckets.values()) {
    const pk = normalizeKey(bucket.productName);
    baseCountByProduct.set(pk, (baseCountByProduct.get(pk) ?? 0) + 1);
  }

  const groups: ComputedDealGroup[] = [];

  for (const [groupKey, bucket] of buckets.entries()) {
    // 그룹별 유효값: 브랜드는 오버라이드 > 추출 제안, 거래처는 오버라이드 > 시트 거래처.
    // undefined(미전달)와 null(명시적 비움)을 구분한다 — `??`로 합치면 "연결 안 함"이
    // 시트 거래처로 되살아난다(매핑 해제 null 버그와 같은 결).
    const override = overrides?.[groupKey];
    const suggestedBrandName = extractBrandName(bucket.productName);
    const brandName =
      override?.brandName !== undefined ? override.brandName : suggestedBrandName;
    const groupPartnerId =
      override?.partnerId !== undefined ? override.partnerId : partnerId;

    const validRows: ApplyRowInput[] = [];
    for (const row of bucket.rows) {
      if (toCreatePayload(row, groupPartnerId) !== null) validRows.push(row);
      else skippedRowIds.push(row.id);
    }
    if (validRows.length === 0) continue;

    // 상위딜명: 브랜드는 brandName 필드가 전담하므로 딜명에서는 뗀다(딜 패널 관례 —
    // "파이토 샐러드샷"처럼 딜명에 브랜드가 없다). 동명이인 방지: 같은 제품명이 여러
    // 베이스로 갈릴 때만 구성 베이스를 붙인다.
    const strippedProductName = stripBrandFromProductName(bucket.productName);
    const needsDisambiguation =
      (baseCountByProduct.get(normalizeKey(bucket.productName)) ?? 1) > 1 && !!bucket.optionBase;
    const parentDealName = needsDisambiguation
      ? `${strippedProductName} - ${bucket.optionBase}`
      : strippedProductName;

    // 옵션명 파싱 결과(수량·단위·보조정보) — 옵션 딜명과 구조 필드 양쪽에 쓴다.
    const parsedByRowId = new Map(validRows.map((r) => [r.id, parseOptionName(r.optionName)]));
    // 상위딜 unit = 옵션들의 공통 단위(첫 파싱값). 딜 패널의 "새 옵션 등록" 폼이 이 값으로
    // 수량 입력 단위를 잡는다. unitQuantity는 상위딜엔 두지 않는다(표시명이 옵션처럼 변한다).
    const parentUnit =
      validRows.map((r) => parsedByRowId.get(r.id)?.unit).find((u) => !!u) ?? null;

    if (validRows.length === 1) {
      groups.push({
        groupKey,
        parentDealName,
        suggestedBrandName,
        parent: toCreatePayload(validRows[0], groupPartnerId, {
          dealName: parentDealName,
          brandName,
          unit: parentUnit,
        })!,
        options: null,
        parentPriceSource: "single",
        attachToDealId: null,
        rowIds: [validRows[0].id],
      });
      continue;
    }

    // 상위딜 가격의 출처: "단위 1" 기본 옵션(1개/1통/1팩 등)이 있으면 그 행, 없으면 빈 컨테이너.
    const baseRow =
      validRows.find((r) => parsedByRowId.get(r.id)?.quantity === 1) ?? null;

    const parent: DealCreatePayload = baseRow
      ? toCreatePayload(baseRow, groupPartnerId, {
          dealName: parentDealName,
          brandName,
          dealType: "MAIN",
          unit: parentUnit,
        })!
      : {
          dealName: parentDealName,
          brandName,
          partnerId: groupPartnerId,
          costPrice: 0,
          sellingPrice: 0,
          supplyPrice: null,
          listPrice: null,
          floorPrice: null,
          totalCommissionRate: null,
          discountRate: null,
          dealType: "MAIN",
          unit: parentUnit,
        };

    groups.push({
      groupKey,
      parentDealName,
      suggestedBrandName,
      parent,
      options: validRows.map((r, index) => {
        const parsed = parsedByRowId.get(r.id)!;
        // 옵션 딜명은 딜 패널 옵션 등록과 같은 정본 조합기(getDisplayDealName)를 쓴다 —
        // "상위딜명 - 2팩 (28포)" 형태. 제품명을 다시 붙여 중복 표기하지 않는다.
        // 수량·단위를 못 뽑은 옵션명만 기존 "상위딜명 - 옵션명" 폴백.
        const optionDealName =
          parsed.quantity !== null && parsed.unit
            ? getDisplayDealName({
                dealName: parentDealName,
                unit: parsed.unit,
                unitQuantity: parsed.quantity,
                supplementaryInfo: parsed.supplementary,
              })
            : formatOptionDealName(parentDealName, r.optionName ?? parentDealName);
        return toCreatePayload(r, groupPartnerId, {
          dealName: optionDealName,
          brandName,
          dealType: "OPTION",
          optionSortOrder: index,
          unit: parsed.unit,
          unitQuantity: parsed.quantity,
          supplementaryInfo: parsed.supplementary,
        })!;
      }),
      parentPriceSource: baseRow ? "base-option" : "empty",
      attachToDealId: null,
      rowIds: validRows.map((r) => r.id),
    });
  }

  return { groups, skippedRowIds };
}

/** BUNDLE 모드: 대상 행 전체를 상위딜 1개의 하위품목으로 묶는다. */
function computeBundleGroup(
  rows: ApplyRowInput[],
  partnerId: string | null,
  target: BundleTarget,
  overrides?: Record<string, DealGroupOverride>
): { group: ComputedDealGroup | null; skippedRowIds: string[] } {
  const skippedRowIds: string[] = [];

  // 기존 딜에 붙일 때는 브랜드·거래처가 부모 값으로 고정된다 — 오버라이드를 받지 않는다
  // (부모와 자식의 거래처가 갈리면 발주 브랜드 판정이 어긋난다, 설계 §3 가드 2).
  const override = overrides?.[BUNDLE_GROUP_KEY];
  const brandName =
    target.kind === "EXISTING"
      ? target.parentBrandName
      : override?.brandName !== undefined
        ? override.brandName
        : null;
  const groupPartnerId =
    target.kind === "EXISTING"
      ? target.parentPartnerId
      : override?.partnerId !== undefined
        ? override.partnerId
        : partnerId;

  const validRows: ApplyRowInput[] = [];
  for (const row of rows) {
    if (toCreatePayload(row, groupPartnerId) !== null) validRows.push(row);
    else skippedRowIds.push(row.id);
  }
  if (validRows.length === 0) return { group: null, skippedRowIds };

  const parentDealName = target.parentDealName;

  // ⛔ parseOptionName을 부르지 않는다. 서로 다른 제품의 묶음은 수량 변형이 아니고,
  // 제품명의 스펙 문자열("2mm", "40cm+4cm")이 수량으로 오인된다(설계 §2).
  const options = validRows.map((row, index) =>
    toCreatePayload(row, groupPartnerId, {
      // 옵션명 조합은 AUTO 경로와 같은 정본(formatOptionDealName)을 쓴다 — 인라인으로
      // 다시 짜면 "상위딜명 - 제품명"을 무조건 이어붙여, 상위딜이 제품명 그대로 등록된
      // 경우("협의 단계에 딜 기본정보만 먼저 등록") "제품A - 제품A"처럼 중복 표기된다.
      dealName: formatOptionDealName(parentDealName, row.productName ?? parentDealName),
      brandName,
      dealType: "OPTION",
      optionSortOrder: index,
      unit: null,
      unitQuantity: null,
      supplementaryInfo: null,
    })!
  );

  const parent: DealCreatePayload = {
    dealName: parentDealName,
    brandName,
    partnerId: groupPartnerId,
    costPrice: 0,
    sellingPrice: 0,
    supplyPrice: null,
    listPrice: null,
    floorPrice: null,
    totalCommissionRate: null,
    discountRate: null,
    dealType: "MAIN",
    unit: null,
  };

  return {
    group: {
      groupKey: BUNDLE_GROUP_KEY,
      parentDealName,
      // 필드 계약(주석)상 "오버라이드 적용 전" 추출 제안값이어야 한다 — brandName은 이미
      // 오버라이드가 적용된 유효값이라 여기 쓰면 우연히 맞아떨어질 뿐인 계약 위반이 된다.
      // EXISTING 묶음은 부모 브랜드를 제안값으로, NEW 묶음은 브랜드를 추출할 원천이 없어 null.
      suggestedBrandName: target.kind === "EXISTING" ? target.parentBrandName : null,
      parent,
      options,
      parentPriceSource: target.kind === "EXISTING" ? "existing" : "empty",
      attachToDealId: target.kind === "EXISTING" ? target.dealId : null,
      rowIds: validRows.map((r) => r.id),
    },
    skippedRowIds,
  };
}

/**
 * 신규 행 → 딜 구조 계산의 단일 진입점. 반영 실행기와 검수 화면 프리뷰가 공유한다.
 * · bundle 미전달 또는 mode:"AUTO" → 현행 규칙(제품명 + 구성 베이스).
 * · mode:"BUNDLE" → 제외되지 않은 NEW_DEAL 행 전체를 상위딜 1개 아래로 묶고,
 *   제외된 행은 AUTO 규칙으로 따로 처리한다.
 */
export function computeDealGroups(
  rows: ApplyRowInput[],
  partnerId: string | null,
  overrides?: Record<string, DealGroupOverride>,
  bundle?: BundlePolicy
): DealGroupComputation {
  if (!bundle || bundle.mode === "AUTO") {
    return computeAutoGroups(rows, partnerId, overrides);
  }

  const excluded = new Set(bundle.excludedRowIds);
  const bundleRows = rows.filter((r) => r.mappingStatus === "NEW_DEAL" && !excluded.has(r.id));
  // 제외된 행만 AUTO로 넘긴다. NEW_DEAL이 아닌 행은 어느 쪽에서도 그룹이 되지 않으므로
  // 그대로 넘겨도 무해하다(computeAutoGroups가 mappingStatus로 거른다).
  const autoRows = rows.filter((r) => r.mappingStatus !== "NEW_DEAL" || excluded.has(r.id));

  const auto = computeAutoGroups(autoRows, partnerId, overrides);
  const { group, skippedRowIds } = computeBundleGroup(bundleRows, partnerId, bundle.target, overrides);

  return {
    groups: group ? [group, ...auto.groups] : auto.groups,
    skippedRowIds: [...skippedRowIds, ...auto.skippedRowIds],
  };
}
