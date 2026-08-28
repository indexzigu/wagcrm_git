// reference-inbox — 미분류 레퍼런스 인박스의 순수 로직 코어(Prisma·HTTP 비의존).
// 일괄 추가 정규화·dedup 집계와 배정 시 중복 승격 판정을 순수 함수로 분리해 단위테스트한다.

import { normalizeReferenceUrl, deriveLinkName } from "./reference-url";

/** 일괄 추가 시 정규화·dedup을 거쳐 실제로 생성할 후보 1건. */
export type PreparedInboxItem = {
  rawUrl: string;
  normalizedUrl: string;
  linkName: string;
};

/** 일괄 추가 계획: 생성 후보 + 부분성공 집계(무효/중복 건수). */
export type PrepareInboxPlan = {
  /** 생성해야 할 항목들(무효·중복 제거 후). */
  toCreate: PreparedInboxItem[];
  /** normalizeReferenceUrl가 null을 반환한(파싱 불가·비 http/https) 건수. */
  invalid: number;
  /** 이미 존재(기존 PENDING) 또는 같은 입력 내 중복으로 걸러진 건수. */
  skipped: number;
};

/**
 * 여러 줄 텍스트를 URL 후보 목록으로 분해한다.
 * 줄바꿈·쉼표·공백(탭 포함)을 구분자로 쓰고, 빈 토큰은 제거한다.
 * 붙여넣기 편의상 여러 구분자를 관대하게 허용한다(정규화 자체는 normalizeReferenceUrl가 담당).
 */
export function splitUrlText(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * 일괄 추가 입력을 정규화·dedup해 생성 계획을 만든다(순수 함수).
 *
 * - 각 raw를 normalizeReferenceUrl로 정규화 → null이면 invalid 집계
 * - 이미 PENDING에 존재하는 normalizedUrl(existingNormalizedUrls)이면 skipped 집계
 * - 같은 입력 배치 안에서 이미 등장한 normalizedUrl이면 skipped 집계(배치 내 중복 방지)
 * - 그 외에는 toCreate에 추가(linkName은 deriveLinkName)
 *
 * DB 조회·쓰기는 호출자(라우트)가 담당한다. 여기서는 집계만 결정한다.
 */
export function prepareInboxItems(
  rawUrls: readonly string[],
  existingNormalizedUrls: Iterable<string>,
): PrepareInboxPlan {
  const seen = new Set<string>(existingNormalizedUrls);
  const toCreate: PreparedInboxItem[] = [];
  let invalid = 0;
  let skipped = 0;

  for (const raw of rawUrls) {
    const normalizedUrl = normalizeReferenceUrl(raw);
    if (normalizedUrl === null) {
      invalid += 1;
      continue;
    }
    if (seen.has(normalizedUrl)) {
      skipped += 1;
      continue;
    }
    seen.add(normalizedUrl);
    toCreate.push({
      rawUrl: raw.trim(),
      normalizedUrl,
      linkName: deriveLinkName(normalizedUrl),
    });
  }

  return { toCreate, invalid, skipped };
}

/**
 * 이미 추출된 콘텐츠 URL 목록으로 인박스에 넣을 항목을 계산한다(순수 함수, R2b).
 *
 * - 입력 contentUrls는 호출부에서 extractContentUrls로 뽑은 정규화·중복 제거된 값(재추출하지 않음)
 * - prepareInboxItems로 기존 dedup(existingNormalizedUrls = PENDING + DISMISSED) 적용
 * - 남은 것만 { normalizedUrl, rawUrl, linkName } 형태로 반환
 *
 * contentUrls가 이미 정규화값이므로 rawUrl == normalizedUrl이며, prepareInboxItems가 다시
 * 정규화해도 멱등이다(무효 0). DB 쓰기는 호출부(라우트)가 담당한다.
 */
export function planKakaoInboxItems(
  contentUrls: readonly string[],
  existingNormalizedUrls: readonly string[],
): { normalizedUrl: string; rawUrl: string; linkName: string }[] {
  if (contentUrls.length === 0) return [];
  const plan = prepareInboxItems(contentUrls, existingNormalizedUrls);
  return plan.toCreate.map((item) => ({
    normalizedUrl: item.normalizedUrl,
    rawUrl: item.rawUrl,
    linkName: item.linkName,
  }));
}

/** 최소한의 Asset 형태(중복 판정에 필요한 externalUrl만) — 판정 함수 입력용. */
export type ExistingAssetLike = { externalUrl: string | null };

/**
 * 배정 대상 딜에 같은 externalUrl(normalizedUrl)을 가진 Asset이 이미 있는지 판정한다(순수 함수).
 * 있으면 Asset을 새로 만들지 않고 인박스 아이템만 제거하는 "중복 승격 방지" 경로로 간다.
 *
 * externalUrl 비교는 정확 일치(정규화는 이미 normalizeReferenceUrl로 끝난 값 기준).
 */
export function findDuplicateAsset<T extends ExistingAssetLike>(
  existingAssets: readonly T[],
  normalizedUrl: string,
): T | null {
  for (const asset of existingAssets) {
    if (asset.externalUrl === normalizedUrl) {
      return asset;
    }
  }
  return null;
}
