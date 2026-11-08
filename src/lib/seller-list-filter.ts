// [셀러분석] 셀러 목록 주소 필터 — 주소 파라미터 ↔ 조건 ↔ 셀러 매칭의 단일 진실 원천 (client-safe, 순수).
//
// 왜 있나: 슬랙 봇(hermes)이 「팔로워 1~5만 육아 셀러 중 참여율 3% 이상」 같은 요청을 조건으로 바꿔
// 이 주소 형식의 셀러 목록 링크를 돌려준다. 봇 쪽 파이썬 도구(`plugins/wag-operator/seller_filter_link.py`)는
// 이 파일의 파라미터 이름·순서·단위를 그대로 따르고, 두 레포의 테스트가 같은 예시표(설계 §6)를 고정한다.
// 파라미터 이름을 바꾸면 봇이 만든 링크가 조용히 안 걸린다 — 바꿀 땐 봇 쪽도 같이 바꿀 것.
//
// 원칙(오너 확정 「반영 못한 조건 명시」): 주소 값이 잘못돼 버리는 조건은 `unreadable` 로 돌려줘
// 화면이 「읽지 못한 조건」으로 보이게 한다 — 조용히 버리지 않는다.
//
// 설계 정본: docs/private/specs/2026-11-08-bot-nl-seller-filter.md (로컬 서고)

import { snsTypeLabels, type SellerSummary, type SnsType } from "@/lib/crm-types";
import { formatFollowerCount } from "@/lib/partner-seller-display";
import { matchesSellerSegment, type SellerSegment } from "@/lib/seller-segment";

export type SellerListSegmentFilter = Exclude<SellerSegment, "all">;

export interface SellerListFilter {
  segment?: SellerListSegmentFilter;
  snsType?: SnsType;
  /** 카테고리 부분 일치 낱말(대소문자 무시) */
  category?: string;
  minFollowers?: number;
  maxFollowers?: number;
  /** 참여율 하한 — **퍼센트**(3 = 3%). 판정에 넘기는 참여율 값은 비율(0.03)이다. */
  minEngagementPct?: number;
}

export interface UnreadableSellerListParam {
  param: string;
  value: string;
  /** 화면 표시용 — 「참여율 「abc」」. 영문 파라미터 이름은 화면에 내지 않는다(P2 화면 문구 ③). */
  label: string;
}

const PARAM_LABELS = {
  segment: "세그먼트",
  snsType: "채널",
  category: "카테고리",
  minFollowers: "팔로워 하한",
  maxFollowers: "팔로워 상한",
  "minFollowers~maxFollowers": "팔로워 범위",
  minEr: "참여율",
} as const;
type UnreadableParam = keyof typeof PARAM_LABELS;
const UNREADABLE_VALUE_MAX = 20;

function unreadableLabel(param: UnreadableParam, value: string): string {
  const shown = value.length > UNREADABLE_VALUE_MAX ? `${value.slice(0, UNREADABLE_VALUE_MAX)}…` : value;
  return `${PARAM_LABELS[param]} 「${shown}」`;
}

/**
 * 주소 파라미터 이름 — 순서가 곧 `buildSellerListQuery` 의 출력 순서다(봇 테스트가 문자열로 대조).
 * `q`(검색어)는 기존 `useFilterParams` 가 소유하므로 여기 없다.
 */
export const SELLER_LIST_FILTER_PARAM_KEYS = [
  "segment",
  "snsType",
  "category",
  "minFollowers",
  "maxFollowers",
  "minEr",
] as const;

const SEGMENTS: readonly SellerListSegmentFilter[] = ["active", "prospect", "unanalyzed", "dormant"];

/** 세그먼트 탭 라벨 — 데스크톱 탭과 (탭이 없는) 모바일 칩이 같은 말을 쓴다. */
export const SELLER_SEGMENT_LABELS: Record<SellerSegment, string> = {
  all: "전체",
  active: "거래 셀러",
  prospect: "발굴 후보",
  unanalyzed: "미분석",
  dormant: "휴면",
};
const SNS_TYPES: readonly SnsType[] = ["INSTAGRAM", "YOUTUBE", "X"];
const CATEGORY_MAX_LENGTH = 30;
const NON_NEGATIVE_INT = /^\d{1,10}$/;
/** 0 초과 100 이하, 소수 둘째 자리까지 */
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

function readFollowers(raw: string): number | null {
  if (!NON_NEGATIVE_INT.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function readPercent(raw: string): number | null {
  if (!PERCENT.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n <= 100 ? n : null;
}

/** 주소 → 조건. 값이 잘못된 파라미터는 버리고 `unreadable` 에 원문 그대로 담는다. */
export function parseSellerListFilter(params: Pick<URLSearchParams, "get">): {
  filter: SellerListFilter;
  unreadable: UnreadableSellerListParam[];
} {
  const filter: SellerListFilter = {};
  const unreadable: UnreadableSellerListParam[] = [];
  const reject = (param: UnreadableParam, value: string) =>
    unreadable.push({ param, value, label: unreadableLabel(param, value) });

  const segment = params.get("segment");
  if (segment !== null && segment !== "all") {
    if ((SEGMENTS as readonly string[]).includes(segment)) filter.segment = segment as SellerListSegmentFilter;
    else reject("segment", segment);
  }

  const snsType = params.get("snsType");
  if (snsType !== null) {
    if ((SNS_TYPES as readonly string[]).includes(snsType)) filter.snsType = snsType as SnsType;
    else reject("snsType", snsType);
  }

  const category = params.get("category");
  if (category !== null) {
    const trimmed = category.trim();
    if (trimmed.length > 0 && trimmed.length <= CATEGORY_MAX_LENGTH) filter.category = trimmed;
    else reject("category", category);
  }

  const minRaw = params.get("minFollowers");
  const maxRaw = params.get("maxFollowers");
  const min = minRaw === null ? null : readFollowers(minRaw);
  const max = maxRaw === null ? null : readFollowers(maxRaw);
  if (minRaw !== null && min === null) reject("minFollowers", minRaw);
  if (maxRaw !== null && max === null) reject("maxFollowers", maxRaw);
  if (min !== null && max !== null && min > max) {
    // 범위가 뒤집혔으면 어느 쪽이 맞는지 모른다 — 둘 다 걸지 않고 한 건으로 알린다.
    reject("minFollowers~maxFollowers", `${minRaw}~${maxRaw}`);
  } else {
    if (min !== null) filter.minFollowers = min;
    if (max !== null) filter.maxFollowers = max;
  }

  const erRaw = params.get("minEr");
  if (erRaw !== null) {
    const er = readPercent(erRaw);
    if (er !== null) filter.minEngagementPct = er;
    else reject("minEr", erRaw);
  }

  return { filter, unreadable };
}

/** 조건 → 주소 쿼리(앞의 `?` 없음). 파라미터 순서는 `SELLER_LIST_FILTER_PARAM_KEYS`. */
export function buildSellerListQuery(filter: SellerListFilter): string {
  const params = new URLSearchParams();
  if (filter.segment) params.set("segment", filter.segment);
  if (filter.snsType) params.set("snsType", filter.snsType);
  if (filter.category) params.set("category", filter.category);
  if (filter.minFollowers !== undefined) params.set("minFollowers", String(filter.minFollowers));
  if (filter.maxFollowers !== undefined) params.set("maxFollowers", String(filter.maxFollowers));
  if (filter.minEngagementPct !== undefined) params.set("minEr", String(filter.minEngagementPct));
  // URLSearchParams 는 공백을 + 로 쓰지만 봇(urllib quote)과 맞추려 %20 으로 통일한다.
  return params.toString().replace(/\+/g, "%20");
}

/**
 * 셀러가 조건을 모두 만족하는가. 참여율 조건이 있으면 **미분석 셀러는 빠진다**(값이 없으면 판정 불가 —
 * 칩 문구가 「분석된 셀러만」으로 알린다). 비율×100 비교의 부동소수 오차는 1e-9 여유로 흡수한다.
 */
export function matchesSellerListFilter(
  seller: SellerSummary,
  filter: SellerListFilter,
  context: {
    /** 이 셀러의 AI 분석 참여율(비율). 없으면 미분석 — seller-engagement-rates.ts */
    engagementRate?: number | null;
    now?: Date;
  } = {},
): boolean {
  const now = context.now ?? new Date();
  if (filter.snsType && seller.snsType !== filter.snsType) return false;
  if (filter.category) {
    const own = seller.category?.toLowerCase() ?? "";
    if (!own.includes(filter.category.toLowerCase())) return false;
  }
  if (filter.minFollowers !== undefined && seller.currentFollowers < filter.minFollowers) return false;
  if (filter.maxFollowers !== undefined && seller.currentFollowers > filter.maxFollowers) return false;
  if (filter.minEngagementPct !== undefined) {
    const er = context.engagementRate;
    if (er === null || er === undefined || !Number.isFinite(er)) return false;
    if (er * 100 + 1e-9 < filter.minEngagementPct) return false;
  }
  if (filter.segment && !matchesSellerSegment(seller, filter.segment, now)) return false;
  return true;
}

/**
 * 「링크 조건」 줄의 칩 문구. 세그먼트는 화면의 세그먼트 탭이 이미 보여 주므로 넣지 않는다.
 * 팔로워 표기는 목록 열과 같은 `formatFollowerCount`.
 */
export function describeSellerListFilter(
  filter: SellerListFilter,
  options: { includeSegment?: boolean } = {},
): string[] {
  const chips: string[] = [];
  // 데스크톱은 세그먼트 탭이 이 값을 보여 주므로 칩을 생략한다 — 탭이 없는 모바일만 칩으로 적는다.
  if (options.includeSegment && filter.segment) chips.push(`보기 「${SELLER_SEGMENT_LABELS[filter.segment]}」`);
  if (filter.snsType) chips.push(`채널 ${snsTypeLabels[filter.snsType]}`);
  if (filter.category) chips.push(`카테고리 「${filter.category}」 포함`);
  const { minFollowers: min, maxFollowers: max } = filter;
  if (min !== undefined && max !== undefined) {
    chips.push(`팔로워 ${formatFollowerCount(min)}~${formatFollowerCount(max)}`);
  } else if (min !== undefined) {
    chips.push(`팔로워 ${formatFollowerCount(min)} 이상`);
  } else if (max !== undefined) {
    chips.push(`팔로워 ${formatFollowerCount(max)} 이하`);
  }
  if (filter.minEngagementPct !== undefined) {
    chips.push(`참여율 ${filter.minEngagementPct}% 이상 (분석된 셀러만)`);
  }
  return chips;
}
