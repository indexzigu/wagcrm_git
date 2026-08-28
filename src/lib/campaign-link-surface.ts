import type { SalesChannel } from "./crm-types";

/**
 * 캠페인 사이드패널이 어떤 **링크 표면**을 기본으로 펼칠지 정한다.
 *
 * ## 왜 분기가 필요한가
 *
 * 운영자가 셀러에게 줄 링크가 두 종류다.
 *
 * - **`nt_*` 파라미터 링크**(`MarketingLinkConverter`) — 네이버 스마트스토어
 *   마케팅분석이 읽는 규격이다. 그 값을 **우리가 읽으려면 스토어 관리자 접근이
 *   필요**하므로, 자사 네이버 스토어에서만 실제로 성과가 회수된다.
 * - **`go.ygrd.kr` 단축링크**(`TrackedLink`) — 스토어와 무관하게 우리 리다이렉터가
 *   클릭을 직접 기록한다. 관리자 접근이 없는 브랜드사·셀러몰에서 유일하게 성립하는
 *   경로다.
 *
 * 둘을 나란히 놓으면 복사 버튼이 둘이 되고, 잘못 고른 사실은 **캠페인이 끝나야**
 * 드러난다(유입 데이터가 0건으로 남는다). 그래서 채널로 하나를 고른다.
 *
 * ## `UNSPECIFIED` 는 숨기지 않는다 (안전 실패)
 *
 * 미지정은 13% 대이고 지금도 계속 생성된다(2026-07-31 실측). 채널을 못 정했다는
 * 이유로 어느 카드도 안 보여주면 **운영자가 링크를 못 만들고 그 이유도 모른다.**
 * `campaign-setup.ts` 가 세팅 창 판정에서 쓰는 원칙과 같다 — *"접어서 시야에서
 * 지우는 것보다 펼쳐두는 쪽이 안전 실패"*. 미지정에는 스토어 무관하게 항상
 * 동작하는 단축링크를 펼치고, 채널을 정하라는 신호를 함께 준다
 * (`needsChannelAssignment` 와 같은 사실을 가리킨다).
 *
 * ## 반대 표면은 접어둘 뿐 없애지 않는다
 *
 * 채널이 잘못 설정돼 있으면 분기가 틀린 카드를 편다. 그때 운영자가 손으로 반대
 * 표면에 갈 수 있어야 한다 — 없애면 채널을 고치기 전까지 작업이 막힌다.
 */
export type CampaignLinkSurface = "SHORT_LINK" | "NAVER_PARAMS";

/**
 * `nt_*` 파라미터가 실제로 회수되는 채널.
 *
 * 자사 **네이버** 스토어 하나뿐이다. `OWN_MALL`(자사몰 기타)·`OWN_MALL_KAKAO` 는
 * 우리 관리자 접근이 있어도 네이버 마케팅분석이 없으므로 `nt_*` 를 해석할 주체가
 * 없다 — 파라미터를 붙여도 읽을 사람이 없다는 뜻이라 단축링크로 보낸다.
 */
const NAVER_PARAM_CHANNELS = new Set<SalesChannel>(["OWN_MALL_NAVER"]);

export type CampaignLinkSurfaceDecision = {
  surface: CampaignLinkSurface;
  /** 판매채널이 미지정이라 분기 근거가 약하다 — 화면이 그 사실을 함께 알린다. */
  channelUnassigned: boolean;
};

export function resolveCampaignLinkSurface(
  salesChannel: SalesChannel,
): CampaignLinkSurfaceDecision {
  return {
    surface: NAVER_PARAM_CHANNELS.has(salesChannel) ? "NAVER_PARAMS" : "SHORT_LINK",
    channelUnassigned: salesChannel === "UNSPECIFIED",
  };
}

/**
 * 우리가 붙이는 추적 파라미터 — 상품을 **식별하지 않는다**.
 *
 * `nt_*` 는 `MarketingLinkConverter` 가, `utm_*` 는 외부 도구가 붙인다. 둘 다 목적지가
 * 상품 페이지인지 판단할 때는 없는 것으로 친다.
 */
const TRACKING_PARAM_PREFIXES = ["nt_", "utm_"];

/**
 * 도메인만 있고 상품을 가리키지 않는 자리표시자인가.
 *
 * ## 실사고 (2026-07-31)
 *
 * 한 캠페인의 `baseNaverLink` 가 `https://smartstore.naver.com` 이었다. 형식상 유효한
 * URL 이라 종전 가드(빈 값·`pending` 만 차단)를 그대로 통과했고, **단축링크가 발급돼
 * 팔로워를 스토어 홈으로 보내는 상태**가 됐다. 셀러에게 뿌린 뒤였다면 그 회차 유입은
 * 통째로 무의미해지고, 링크는 살아 있으므로 아무 에러도 나지 않아 **캠페인이 끝날 때까지
 * 아무도 모른다.**
 *
 * ## 판정
 *
 * 추적 파라미터를 걷어낸 뒤 **경로도 없고 쿼리도 없으면** 자리표시자로 본다.
 *
 * 추적 파라미터를 먼저 걷는 이유는 위 사고의 실제 값이
 * `https://smartstore.naver.com/?nt_source=…` 였기 때문이다 — 우리 변환기가 붙인
 * 파라미터가 "쿼리가 있으니 상품 링크"로 오판되게 만든다.
 *
 * 반대로 **추적용이 아닌 쿼리가 남아 있으면 통과시킨다.** `https://shop.example.com/?goods=123`
 * 처럼 루트에서 쿼리로 상품을 가리키는 스토어가 실제로 있고, 그런 곳까지 막으면 운영자가
 * 발급 자체를 못 하게 된다. 이 가드의 목적은 **명백한 자리표시자**를 걸러내는 것이지
 * URL 을 심사하는 것이 아니다.
 */
export function isPlaceholderTargetUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return true; // 파싱조차 안 되면 목적지로 쓸 수 없다.
  }

  const hasPath = url.pathname.replace(/\/+$/, "") !== "";
  if (hasPath) return false;

  const meaningfulParams = [...url.searchParams.keys()].filter(
    (key) => !TRACKING_PARAM_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix)),
  );
  return meaningfulParams.length === 0;
}

/**
 * 셀러에게 내보낼 목적지로 **실제로 쓸 값**을 고른다.
 *
 * 우선순위는 `generatedTrackingLink` → `baseNaverLink` 이되 **자리표시자는 건너뛴다.**
 * 캠페인은 자리표시자로 태어나고(`campaign-creation-sheet`·`campaign-creation-form` 이
 * 목적지를 하드코딩한다) 그 위에서 `generatedTrackingLink` 가 만들어지므로
 * (`buildNaverTrackingLink(자리표시자)` = `https://…/?nt_source=…`), 단순 `||` 로 고르면
 * **나중에 저장한 진짜 상품 링크가 영원히 가려지고 발급이 계속 거절된다.**
 *
 * 빈 값·`pending` 에 더해 **도메인 루트 자리표시자**도 미확정으로 본다
 * (`isPlaceholderTargetUrl` 의 실사고 참조).
 */
export function pickConfirmedTargetLink(campaign: {
  baseNaverLink?: string | null;
  generatedTrackingLink?: string | null;
}): string | null {
  for (const value of [campaign.generatedTrackingLink, campaign.baseNaverLink]) {
    const trimmed = (value ?? "").trim();
    if (trimmed === "" || trimmed.toLowerCase() === "pending") continue;
    if (isPlaceholderTargetUrl(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/**
 * 캠페인에 셀러로 내보낼 목적지가 정해져 있는가.
 *
 * P2 **Unconfirmed Link Guard** 의 상속이다 — 미확정 값에는 링크 액션을 노출하지 않는다.
 * 판정은 `pickConfirmedTargetLink` 하나가 한다 — 여기서 조건을 다시 쓰면 화면은 "확정"인데
 * 발급은 거절하는 상태가 생긴다.
 */
export function hasConfirmedTargetLink(campaign: {
  baseNaverLink?: string | null;
  generatedTrackingLink?: string | null;
}): boolean {
  return pickConfirmedTargetLink(campaign) !== null;
}
