// 캠페인 링크 표면 분기 계약.
//
// 이 판정이 틀리면 운영자가 **틀린 링크를 셀러에게 준다** — 그리고 그 사실은 캠페인이
// 끝나 유입 데이터가 0건인 것을 볼 때까지 드러나지 않는다. 실패가 조용한 부류라 계약으로
// 고정한다.

import { describe, expect, it } from "vitest";
import type { SalesChannel } from "../crm-types";
import {
  hasConfirmedTargetLink,
  isPlaceholderTargetUrl,
  pickConfirmedTargetLink,
  resolveCampaignLinkSurface,
} from "../campaign-link-surface";

const ALL_CHANNELS: SalesChannel[] = [
  "UNSPECIFIED",
  "OWN_MALL",
  "OWN_MALL_NAVER",
  "OWN_MALL_KAKAO",
  "SELLER_MALL",
  "BRAND_MALL",
];

describe("resolveCampaignLinkSurface", () => {
  it("자사 네이버 스토어에서만 nt_* 표면을 편다", () => {
    // nt_* 는 네이버 마케팅분석이 읽는 규격이고, 그 값을 회수하려면 스토어 관리자
    // 접근이 필요하다. 자사 네이버 스토어가 그 조건을 만족하는 유일한 채널이다.
    expect(resolveCampaignLinkSurface("OWN_MALL_NAVER").surface).toBe("NAVER_PARAMS");
  });

  it("관리자 접근이 없는 채널은 전부 단축링크로 보낸다", () => {
    // 브랜드사몰·셀러몰이 A-Z 설계서가 상정한 바로 그 상황이다 — 상대 스토어라
    // 파라미터를 심어도 읽을 주체가 우리 쪽에 없다.
    for (const channel of ["BRAND_MALL", "SELLER_MALL"] as SalesChannel[]) {
      expect(resolveCampaignLinkSurface(channel).surface).toBe("SHORT_LINK");
    }
  });

  it("자사몰이어도 네이버가 아니면 단축링크다", () => {
    // 🪤 "우리 스토어면 nt_* 가 통한다" 는 오독. 관리자 접근이 아니라 **네이버
    // 마케팅분석의 존재**가 조건이다. 자사몰 기타·카카오에는 그게 없다.
    expect(resolveCampaignLinkSurface("OWN_MALL").surface).toBe("SHORT_LINK");
    expect(resolveCampaignLinkSurface("OWN_MALL_KAKAO").surface).toBe("SHORT_LINK");
  });

  it("미지정은 숨기지 않고 단축링크를 펴되 채널 미지정을 함께 알린다", () => {
    // 미지정은 13% 대이고 지금도 생성된다. 어느 카드도 안 보여주면 운영자가 링크를
    // 못 만들고 이유도 모른다 — campaign-setup 의 "펼쳐두는 쪽이 안전 실패" 와 같은 판정.
    const decision = resolveCampaignLinkSurface("UNSPECIFIED");
    expect(decision.surface).toBe("SHORT_LINK");
    expect(decision.channelUnassigned).toBe(true);
  });

  it("미지정이 아닌 채널에는 미지정 신호를 켜지 않는다", () => {
    // 음성 대조군 — 플래그가 상수 true 로 고장나면 모든 캠페인에 "채널을 정하세요"
    // 안내가 상시로 떠서 신호 가치를 잃는다.
    for (const channel of ALL_CHANNELS.filter((c) => c !== "UNSPECIFIED")) {
      expect(resolveCampaignLinkSurface(channel).channelUnassigned).toBe(false);
    }
  });

  it("모든 채널이 두 표면 중 하나로 반드시 배정된다", () => {
    // 채널 enum 에 값이 추가됐는데 분기를 안 고치면 여기서 걸린다.
    for (const channel of ALL_CHANNELS) {
      expect(["SHORT_LINK", "NAVER_PARAMS"]).toContain(
        resolveCampaignLinkSurface(channel).surface,
      );
    }
  });
});

describe("hasConfirmedTargetLink — P2 Unconfirmed Link Guard 상속", () => {
  it("둘 중 하나라도 확정 URL 이면 통과한다", () => {
    // ⚠️ 픽스처에 **경로가 있어야 한다** — 도메인 루트는 2026-07-31 부터 자리표시자로
    // 본다(아래 케이스). 종전 픽스처가 `https://example.com` 이었고 규칙 추가와 함께
    // 여기서 먼저 깨졌다.
    expect(hasConfirmedTargetLink({ baseNaverLink: "https://example.com/goods/1" })).toBe(true);
    expect(
      hasConfirmedTargetLink({ generatedTrackingLink: "https://example.com/goods/1?nt_source=x" }),
    ).toBe(true);
  });

  it("도메인 루트 자리표시자는 미확정으로 본다 (실사고 2026-07-31)", () => {
    // 실제로 프로덕션 캠페인에 `https://smartstore.naver.com` 이 들어 있었고, 형식상
    // 유효한 URL 이라 종전 가드를 통과해 **팔로워를 스토어 홈으로 보내는 링크**가
    // 발급됐다. 링크가 살아 있어 에러가 안 나므로 캠페인이 끝날 때까지 드러나지 않는다.
    expect(hasConfirmedTargetLink({ baseNaverLink: "https://smartstore.naver.com" })).toBe(false);
    expect(hasConfirmedTargetLink({ baseNaverLink: "https://smartstore.naver.com/" })).toBe(false);
    // 사고 당시의 실제 값 — 우리 변환기가 붙인 nt_* 때문에 "쿼리가 있다"로 오판되기 쉽다.
    expect(
      hasConfirmedTargetLink({
        generatedTrackingLink: "https://smartstore.naver.com/?nt_source=INSTAGRAM&nt_medium=abc",
        baseNaverLink: "https://smartstore.naver.com",
      }),
    ).toBe(false);
  });

  it("빈 값·공백·pending 은 미확정으로 본다", () => {
    // `""` 와 `"pending"` 은 P2 가 명시한 미확정 표기값이다. 공백만 든 문자열도
    // 사람이 지웠다는 뜻이므로 같이 막는다.
    expect(hasConfirmedTargetLink({})).toBe(false);
    expect(hasConfirmedTargetLink({ baseNaverLink: "", generatedTrackingLink: "" })).toBe(false);
    expect(hasConfirmedTargetLink({ baseNaverLink: "   " })).toBe(false);
    expect(hasConfirmedTargetLink({ baseNaverLink: "pending" })).toBe(false);
    expect(hasConfirmedTargetLink({ generatedTrackingLink: "PENDING" })).toBe(false);
    expect(hasConfirmedTargetLink({ baseNaverLink: null, generatedTrackingLink: null })).toBe(false);
  });
});

describe("isPlaceholderTargetUrl", () => {
  it("경로가 있으면 상품 링크로 본다", () => {
    // 이 가드의 목적은 URL 심사가 아니라 **명백한 자리표시자** 걸러내기다.
    for (const url of [
      "https://opuscom.shop.blogpay.co.kr/view/good/dPY6hE",
      "https://smartstore.naver.com/brand/products/123",
      "https://shop.example.com/p", // 짧아도 경로는 경로다
    ]) {
      expect(isPlaceholderTargetUrl(url), url).toBe(false);
    }
  });

  it("경로 없는 도메인 루트는 자리표시자다", () => {
    for (const url of [
      "https://smartstore.naver.com",
      "https://smartstore.naver.com/",
      "https://smartstore.naver.com//", // 슬래시만 여러 개
      "  https://smartstore.naver.com  ", // 앞뒤 공백
    ]) {
      expect(isPlaceholderTargetUrl(url), url).toBe(true);
    }
  });

  it("추적 파라미터만 붙은 루트도 자리표시자다", () => {
    // 🪤 우리 변환기가 붙인 nt_* 를 "쿼리가 있으니 상품 링크"로 읽으면 사고가 그대로 재현된다.
    expect(isPlaceholderTargetUrl("https://smartstore.naver.com/?nt_source=INSTAGRAM")).toBe(true);
    expect(isPlaceholderTargetUrl("https://example.com/?utm_source=ig&utm_medium=social")).toBe(true);
    expect(isPlaceholderTargetUrl("https://example.com/?NT_SOURCE=x")).toBe(true); // 대소문자 무관
  });

  it("추적용이 아닌 쿼리가 남으면 통과시킨다", () => {
    // 루트에서 쿼리로 상품을 가리키는 스토어가 실제로 있다. 그것까지 막으면 운영자가
    // 발급 자체를 못 한다 — 이 규칙은 fail-closed 가 아니라 **명백한 것만** 막는다.
    expect(isPlaceholderTargetUrl("https://shop.example.com/?goods=123")).toBe(false);
    expect(isPlaceholderTargetUrl("https://shop.example.com/?goods=123&utm_source=ig")).toBe(false);
  });

  it("파싱 불가한 값은 자리표시자로 본다", () => {
    expect(isPlaceholderTargetUrl("그냥 문자열")).toBe(true);
    expect(isPlaceholderTargetUrl("")).toBe(true);
  });
});

describe("pickConfirmedTargetLink", () => {
  it("자리표시자에서 파생된 트래킹 링크를 건너뛰고 실제 상품 링크를 고른다", () => {
    // 캠페인 생성이 자리표시자 위에서 generatedTrackingLink 를 만든다
    // (buildNaverTrackingLink(자리표시자) = ".../?nt_source=…").
    // 단순 `||` 로 고르면 나중에 저장한 진짜 상품 링크가 영원히 가려져 발급이 계속 거절된다.
    expect(
      pickConfirmedTargetLink({
        generatedTrackingLink: "https://smartstore.naver.com/?nt_source=INSTAGRAM",
        baseNaverLink: "https://brand.example.com/view/good/AbC123",
      }),
    ).toBe("https://brand.example.com/view/good/AbC123");
  });

  it("확정된 트래킹 링크가 있으면 그것을 우선한다", () => {
    expect(
      pickConfirmedTargetLink({
        generatedTrackingLink: "https://brand.example.com/view/good/AbC123?nt_source=INSTAGRAM",
        baseNaverLink: "https://brand.example.com/view/good/AbC123",
      }),
    ).toBe("https://brand.example.com/view/good/AbC123?nt_source=INSTAGRAM");
  });

  it("둘 다 미확정이면 null 이다", () => {
    expect(
      pickConfirmedTargetLink({ generatedTrackingLink: "pending", baseNaverLink: "" }),
    ).toBeNull();
    expect(
      pickConfirmedTargetLink({
        generatedTrackingLink: "https://smartstore.naver.com/?nt_source=INSTAGRAM",
        baseNaverLink: "https://smartstore.naver.com",
      }),
    ).toBeNull();
  });

  it("hasConfirmedTargetLink 와 판정이 갈리지 않는다", () => {
    // 두 함수가 따로 판정하면 화면은 "확정"인데 발급은 거절하는 상태가 생긴다.
    const cases = [
      { generatedTrackingLink: "pending", baseNaverLink: "https://brand.example.com/p/1" },
      { generatedTrackingLink: "", baseNaverLink: "" },
      {
        generatedTrackingLink: "https://smartstore.naver.com",
        baseNaverLink: "https://smartstore.naver.com",
      },
    ];
    for (const c of cases) {
      expect(hasConfirmedTargetLink(c)).toBe(pickConfirmedTargetLink(c) !== null);
    }
  });
});
