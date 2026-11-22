// Instagram/Facebook Graph API 버전의 단일 출처(SSOT).
// 다른 파일에 "v23.0" 같은 버전 리터럴을 쓰지 않는다 — instagram-graph-version.contract.test.ts 가 막는다.
// 버전을 올릴 때는 이 파일의 두 곳(GRAPH_API_VERSION, 만료표)만 고친다.

export const GRAPH_API_VERSION = "v23.0";

export const GRAPH_API_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** 버전 접두 없는 경로(`/123?fields=...`)를 현재 버전의 전체 URL 로 만든다. */
export function graphUrl(pathAndQuery: string): string {
  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return `${GRAPH_API_BASE_URL}${path}`;
}

/** ApiCallLog 등에 남기는 엔드포인트 문자열(`GET /v23.0/...`) */
export function graphEndpointLabel(pathWithoutVersion: string): string {
  const path = pathWithoutVersion.startsWith("/") ? pathWithoutVersion : `/${pathWithoutVersion}`;
  return `GET /${GRAPH_API_VERSION}${path}`;
}

// 만료일(UTC, 해당 일 0시)은 Meta 공개 변경 이력에서 손으로 옮긴 값이다.
// 출처: https://developers.facebook.com/docs/graph-api/changelog/versions/
export const GRAPH_VERSION_EXPIRY: Readonly<Record<string, string>> = {
  "v19.0": "2026-05-21",
  "v20.0": "2026-09-24",
  "v21.0": "2027-01-21",
  "v23.0": "2027-10-08",
};

export const GRAPH_EXPIRY_WARNING_DAYS = 60;

const MS_PER_DAY = 86_400_000;

export type GraphVersionExpiry = {
  /** 만료일까지 남은 일수(올림). 이미 지났으면 0 이하. 만료표에 없으면 null */
  daysUntilExpiry: number | null;
  /** 만료까지 60일 이하(이미 만료 포함)면 true */
  withinWarningWindow: boolean;
  expired: boolean;
  /** 만료표에 없는 버전 */
  unknown: boolean;
};

/** 순수 함수 — 현재 시각은 호출자가 넘긴다. */
export function evaluateGraphVersionExpiry(version: string, now: Date): GraphVersionExpiry {
  const iso = GRAPH_VERSION_EXPIRY[version];
  if (!iso) return { daysUntilExpiry: null, withinWarningWindow: false, expired: false, unknown: true };
  // `|| 0` 은 만료 직후 24시간의 -0 을 0 으로 정규화한다.
  const days = Math.ceil((Date.parse(`${iso}T00:00:00Z`) - now.getTime()) / MS_PER_DAY) || 0;
  return {
    daysUntilExpiry: days,
    withinWarningWindow: days <= GRAPH_EXPIRY_WARNING_DAYS,
    expired: days <= 0,
    unknown: false,
  };
}
