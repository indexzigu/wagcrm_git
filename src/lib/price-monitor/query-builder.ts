// 시장 최저가 모니터링 검색쿼리 파생 — 순수함수(서버/클라 공유, fs/prisma 의존 없음).
//
// 설계(청사진 §설계-쿼리): searchKeyword는 메인 딜에서 AI로 1회만 추출되며 수량을 포함하지 않는다
// (extract-info route 프롬프트 제약조건 2번 참조). 옵션(자식 딜)별 검색쿼리는 이 공용
// searchKeyword에 "옵션 자신의" 수량 토큰(unitQuantity+unit)을 붙여 파생한다.
//
// 버그②③ 복구: 기존 campaign-deals-table.tsx는 supplementaryInfo.searchKeyword를 전혀
// 읽지 않고 매 옵션 쿼리를 mainDealName 기반으로만 만들어(자식 옵션 차별화 실패) 있었다.
// 이 함수가 그 로직을 대체한다.

export type QueryBuilderInput = {
  /** AI가 메인 딜에서 1회 추출한 핵심 상품명. supplementaryInfo JSON의 searchKeyword. */
  searchKeyword?: string | null;
  /** searchKeyword가 없을 때의 폴백 재료 */
  brandName?: string | null;
  dealName?: string | null;
  /** 옵션(자식) 자신의 수량/단위 — core에 옵션별로 다르게 붙는 부분 */
  unitQuantity?: number | null;
  unit?: string | null;
  /**
   * 자식 딜(하위 옵션) 자신의 dealName. 있으면 core+옵션토큰(색상/맛/구성 등)+수량토큰
   * 순서로 쿼리가 파생된다(C1-1). 없으면 기존 동작과 바이트 동일(회귀 금지).
   */
  childDealName?: string | null;
  /** childDealName에서 접두어로 제거할 부모 딜명. childDealName과 함께 사용. */
  parentDealName?: string | null;
};

/**
 * dealName 문자열에서 "숫자+unit" 패턴을 찾아 수량을 역추출한다.
 * unitQuantity 컬럼이 비어있을 때의 폴백 경로(기존 campaign-deals-table.tsx 로직과 동형).
 */
export function inferQuantityFromName(
  name: string | null | undefined,
  unit: string | null | undefined,
): number | null {
  if (!name || !unit) return null;
  // 정규식 특수문자가 unit에 섞여 있으면 안전하게 이스케이프
  const escapedUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = name.match(new RegExp(`(\\d+)\\s*${escapedUnit}`));
  return match ? parseInt(match[1], 10) : null;
}

/** "4박스" 같은 옵션 수량 토큰 문자열을 만든다. 수량/단위가 없으면 빈 문자열. */
export function buildQuantityToken(
  unitQuantity: number | null | undefined,
  unit: string | null | undefined,
): string {
  const qty = unitQuantity ?? null;
  if (qty != null && unit) return `${qty}${unit}`;
  if (unit) return unit;
  return "";
}

/**
 * supplementaryInfo 컬럼(JSON 문자열: { searchKeyword, referenceUrl, supplementaryInfo } 또는
 * 레거시 자유 텍스트)에서 AI가 추출한 searchKeyword만 뽑아낸다.
 *
 * 버그② 복구 대상: 기존에는 이 값을 읽는 소비처가 전혀 없어 AI 추출 결과가 검색쿼리에
 * 반영되지 않았다(campaign-deals-table.tsx:120-174).
 */
export function parseSearchKeywordFromSupplementaryInfo(
  supplementaryInfo: string | null | undefined,
): string | null {
  if (!supplementaryInfo) return null;
  try {
    const parsed = JSON.parse(supplementaryInfo);
    if (parsed && typeof parsed === "object" && typeof parsed.searchKeyword === "string") {
      return parsed.searchKeyword.trim() || null;
    }
  } catch {
    // 레거시 자유 텍스트 — searchKeyword 없음으로 취급(브랜드+딜명 폴백 경로가 처리)
  }
  return null;
}

/**
 * supplementaryInfo 컬럼에서 AI가 추출한 modelName만 뽑아낸다(P1-5).
 * parseSearchKeywordFromSupplementaryInfo와 동형 — JSON parse, 문자열 검증, trim, 레거시
 * 자유텍스트/필드 없음은 null.
 */
export function parseModelNameFromSupplementaryInfo(
  supplementaryInfo: string | null | undefined,
): string | null {
  if (!supplementaryInfo) return null;
  try {
    const parsed = JSON.parse(supplementaryInfo);
    if (parsed && typeof parsed === "object" && typeof parsed.modelName === "string") {
      return parsed.modelName.trim() || null;
    }
  } catch {
    // 레거시 자유 텍스트 — modelName 없음으로 취급
  }
  return null;
}

/**
 * 정규식 특수문자를 이스케이프한다 (unit/qtyToken 등 사용자 데이터를 RegExp에 안전하게
 * 삽입하기 위함).
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 괄호 주석(예: "(4개월분)")을 제거하고 trim한다. */
function stripParenthetical(value: string): string {
  return value.replace(/\([^)]*\)/g, "").trim();
}

/**
 * value에서 qtyToken과 동일한 "숫자+단위" 패턴 중복을 제거한다.
 * qtyToken이 비어있으면 원문 그대로 반환.
 */
function stripDuplicateQtyToken(value: string, qtyToken: string | null | undefined): string {
  if (!qtyToken) return value;
  const escaped = escapeRegExp(qtyToken);
  return value.replace(new RegExp(escaped, "g"), "").trim();
}

/**
 * 문자열 양끝에 남은 구분자 파편(대시/엔대시/공백)을 제거한다(Critical 2 보강).
 *
 * 부모 접두어가 단어 경계 불일치로 인정되지 않은 경우(예: "레몬즙 - 12박스"에서 "레몬"이
 * 접두어로 인정되지 않음), qtyToken만 제거하고 나면 "레몬즙 -"처럼 끝에 구분자가 덜렁
 * 남을 수 있다. 이 함수는 그 파편을 마저 정리한다.
 */
function stripDanglingSeparators(value: string): string {
  return value.replace(/^[\s\-–]+|[\s\-–]+$/g, "").trim();
}

/**
 * text가 prefix "접두어"로 시작하되, 그 접두어가 진짜 단어 경계에서 끝나는지 검사한다
 * (Critical 2 회귀 수정). extractOptionToken과 scripts/backfill-child-deals.ts의
 * isStandardChildName 양쪽에서 공유하는 단일 진실 소스 — 판정 로직이 두 곳에서 따로
 * 구현되어 있다가 어긋나는 것을 방지한다.
 *
 * startsWith만으로 판정하면 "레몬즙".startsWith("레몬")처럼 부분 문자열 오매치가 발생해
 * "레몬즙 - 12박스"에서 "레몬"을 접두어로 잘못 인식, 잔여 "즙 -"이 쓰레기 토큰으로
 * 쿼리에 섞여 들어간다(또는 백필 리포트의 비정형 목록에서 이 행이 누락된다). 접두어
 * 다음 문자가 문자열 끝이거나 공백/`-`/`–`/`(` 중 하나일 때만 "진짜 접두어"로 인정한다.
 */
export function hasWordBoundaryPrefix(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) return false;
  const nextChar = text.charAt(prefix.length);
  if (nextChar === "") return true; // 접두어가 문자열 전체와 동일
  return /[\s\-–(]/.test(nextChar);
}

/**
 * 자식 딜의 dealName에서 부모 접두어와 수량 중복을 제거해 "옵션 토큰"(색상/맛/구성 등
 * 자식 고유의 차별화 요소)만 남긴다(C1-1).
 *
 * 규칙(청사진 §C1-1 + Critical 2 회귀 수정):
 * - childDealName이 parentDealName으로 시작하고, 그 접두어가 단어 경계(문자열 끝/공백/
 *   `-`/`–`/`(`)에서 끝나면(hasWordBoundaryPrefix) 접두어를 제거하고 이어지는 구분자
 *   (`-`, `–`, 공백)를 strip한다. 부분 문자열 오매치(예: "레몬즙".startsWith("레몬"))는
 *   접두어로 인정하지 않는다 — 이 경우 비정형(전체 문자열에 정리만 적용) 경로를 탄다.
 * - 괄호 주석 `\([^)]*\)` 제거.
 * - 남은 문자열에서 qtyToken과 동일한 패턴 중복 제거.
 * - 부모 접두어가 없으면(비정형, 예: "1통") childDealName 전체에 같은 정리를 적용한다.
 */
export function extractOptionToken(
  childDealName: string,
  parentDealName: string | null | undefined,
  qtyToken: string | null | undefined,
): string {
  const trimmedChild = childDealName.trim();
  const trimmedParent = parentDealName?.trim();

  let remainder = trimmedChild;

  if (trimmedParent && hasWordBoundaryPrefix(trimmedChild, trimmedParent)) {
    remainder = trimmedChild.slice(trimmedParent.length);
    // 이어지는 구분자(대시, 엔대시, 공백) 제거
    remainder = remainder.replace(/^[\s\-–]+/, "");
  }

  remainder = stripParenthetical(remainder);
  remainder = stripDuplicateQtyToken(remainder, qtyToken);
  remainder = stripDanglingSeparators(remainder);

  return remainder;
}

/**
 * 옵션(또는 메인 딜)별 최종 검색쿼리를 파생한다.
 * core = searchKeyword (AI 추출, 없으면 brandName+dealName 폴백)
 * token = 이 옵션 자신의 수량 토큰
 *
 * childDealName이 전달되면(C1-1): 결과 = core + 옵션토큰(extractOptionToken) + 수량토큰.
 * childDealName이 없으면 기존 동작과 바이트 동일(회귀 금지).
 *
 * Critical 1 회귀 수정: childDealName 경로에서 수량이 unitQuantity로도, dealName에서의
 * 역추출로도 확정되지 않으면(resolvedQty === null) — 즉 "이 옵션이 정말 이 수량인지"를
 * 알 수 없으면 — 수량 토큰에 bare unit("박스" 등)만 붙이지 않는다. bare unit은 부모에서
 * 상속된 unit일 뿐 이 자식의 실제 수량과 무관할 수 있어(예: 자식 dealName="1통", 부모
 * unit="박스") 쓰레기 토큰을 만든다. 이 억제는 childDealName이 있을 때만 적용하며,
 * childDealName이 없는 기존 경로(단독/부모 딜)의 bare-unit 동작은 절대 변경하지 않는다
 * (기존 테스트 바이트 동일 불변식).
 */
export function buildSearchQuery(input: QueryBuilderInput): string {
  const { searchKeyword, brandName, dealName, unitQuantity, unit, childDealName, parentDealName } = input;

  const core = (searchKeyword && searchKeyword.trim())
    ? searchKeyword.trim()
    : [brandName, dealName].filter(Boolean).join(" ").trim();

  const resolvedQty = unitQuantity ?? inferQuantityFromName(dealName, unit);

  if (childDealName && childDealName.trim()) {
    // childDealName 경로 전용: qty가 확정되지 않으면 bare-unit을 억제한다(Critical 1).
    const token = resolvedQty != null ? buildQuantityToken(resolvedQty, unit) : "";
    const optionToken = extractOptionToken(childDealName, parentDealName, token);
    return [core, optionToken, token].filter(Boolean).join(" ").trim() || dealName?.trim() || "";
  }

  const token = buildQuantityToken(resolvedQty, unit);
  return [core, token].filter(Boolean).join(" ").trim() || dealName?.trim() || "";
}

/** cron/price-monitoring이 딜/부모딜 raw 필드를 넘길 때의 입력 shape. */
export type MonitorDealFields = {
  dealName: string;
  brandName: string | null;
  unit: string | null;
  unitQuantity: number | null;
  supplementaryInfo: string | null;
  dealType?: string | null;
  parentDealId?: string | null;
};

export type ResolvedMonitorFields = {
  /** 딜 자신의 dealName (알림 제목 등 "이 딜을 사람이 알아볼 이름"에 사용 — 항상 자기 자신) */
  dealName: string;
  /**
   * buildSearchQuery의 core 폴백 재료(searchKeyword ?? brandName+coreDealName)로 사용할
   * dealName. 청사진 §C1-1: "core는 기존 규칙: searchKeyword ?? brand+부모dealName" —
   * 자식 딜이면 부모의 dealName, 부모/단독 딜이면 자기 자신의 dealName과 동일하다.
   */
  coreDealName: string;
  brandName: string | null;
  unit: string | null;
  unitQuantity: number | null;
  searchKeyword: string | null;
  /** AI가 추출한 모델명/모델코드(P3-2). 자식 ?? 부모 순서로 해소한다. */
  modelName: string | null;
  /** buildSearchQuery에 그대로 전달할 자식/부모 dealName (자식이 아니면 둘 다 null) */
  childDealName: string | null;
  parentDealName: string | null;
};

/**
 * cron/price-monitoring의 fetchMonitorTargets에서 사용하는 순수 해소 로직(C1-3).
 *
 * 자식 딜(부모 참조가 있는 딜)이면 searchKeyword/brandName/unit을 "자식 ?? 부모" 순서로
 * 해소하고, buildSearchQuery에 전달할 childDealName/parentDealName을 채운다. core 폴백
 * 재료(coreDealName)는 청사진 규칙대로 부모의 dealName을 사용한다(자식 자신의 dealName은
 * 옵션 토큰으로만 반영되며 core에는 섞이지 않는다 — 그래야 "1통" 같은 비정형 이름도
 * core(부모 브랜드+이름)로 정상 복구된다).
 * 부모/단독 딜(parentDeal이 없음)이면 기존 동작과 동일하게 자기 자신의 필드만 사용하고
 * childDealName/parentDealName은 null로 둔다(회귀 금지).
 */
export function resolveMonitorFields(
  deal: MonitorDealFields,
  parentDeal: MonitorDealFields | null,
): ResolvedMonitorFields {
  if (!parentDeal) {
    return {
      dealName: deal.dealName,
      coreDealName: deal.dealName,
      brandName: deal.brandName,
      unit: deal.unit,
      unitQuantity: deal.unitQuantity,
      searchKeyword: parseSearchKeywordFromSupplementaryInfo(deal.supplementaryInfo),
      modelName: parseModelNameFromSupplementaryInfo(deal.supplementaryInfo),
      childDealName: null,
      parentDealName: null,
    };
  }

  const searchKeyword =
    parseSearchKeywordFromSupplementaryInfo(deal.supplementaryInfo) ??
    parseSearchKeywordFromSupplementaryInfo(parentDeal.supplementaryInfo);
  const modelName =
    parseModelNameFromSupplementaryInfo(deal.supplementaryInfo) ??
    parseModelNameFromSupplementaryInfo(parentDeal.supplementaryInfo);
  const brandName = deal.brandName ?? parentDeal.brandName;
  const unit = deal.unit ?? parentDeal.unit;
  const unitQuantity = deal.unitQuantity ?? null;

  return {
    dealName: deal.dealName,
    coreDealName: parentDeal.dealName,
    brandName,
    unit,
    unitQuantity,
    searchKeyword,
    modelName,
    childDealName: deal.dealName,
    parentDealName: parentDeal.dealName,
  };
}

/**
 * 최저가 모니터링 수집 시간창(오너 확정 2026-07-13, Option A): 캠페인 판매기간 전후 각 N일만
 * 감시한다. 위반 감시는 "판매 진행 전후 1주일" 정도면 충분하다는 운영 판단.
 *
 * 기존 게이트는 `campaign.status === "ACTIVE"`(수동 칸반 상태)였다. 이는 실제 판매기간
 * (startDate/endDate)과 분리돼 있어: ① PREPARATION 단계의 판매 직전 세팅주(週)를 놓치고,
 * ② 오너가 CLOSED로 옮기는 순간 감시가 끊겨 마감 후 주를 놓쳤으며, ③ 반대로 상태 전이를
 * 잊으면 종료된 캠페인을 영구 수집(자기교정 불가)했다. 날짜 기반으로 바꾸면 endDate+N일에
 * 자동으로 꺼지고 startDate−N일에 자동으로 켜진다. 상태는 DROPPED(드랍)만 명시 제외한다.
 */
export const MONITOR_WINDOW_DAYS = 7;

/**
 * fetchMonitorTargets의 Prisma where 절을 만든다(순수 — `now`를 주입받아 결정론적 테스트 가능).
 *
 * 규칙: `monitorEnabled` 딜 AND `status ≠ DROPPED` AND `startDate ≤ now+N일` AND
 * `endDate ≥ now−N일`. 이는 "now이 [startDate−N일, endDate+N일] 구간에 든다"와 동치다.
 * (query-builder.ts는 prisma 무의존 계약이라 반환 타입을 명시하지 않고 구조적 객체로 두어
 * 호출부의 findMany에서 CampaignDealWhereInput로 구조 검증받는다.)
 */
export function buildMonitorWindowWhere(now: Date, windowDays: number = MONITOR_WINDOW_DAYS) {
  const ms = windowDays * 24 * 60 * 60 * 1000;
  return {
    deal: { monitorEnabled: true },
    campaign: {
      status: { not: "DROPPED" },
      startDate: { lte: new Date(now.getTime() + ms) },
      endDate: { gte: new Date(now.getTime() - ms) },
    },
  };
}
