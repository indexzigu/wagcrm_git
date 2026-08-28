// @vitest-environment jsdom
// `hideSns` 계약 — SNS 표시(플랫폼 아이콘 + @계정명) **전체**를 숨긴다.
//
// 왜 렌더 테스트인가: 이 버그는 **소스 그렙으로 잡을 수 없다.** 아이콘의 hue(`text-pink-500/80`·
// `text-red-500/80`)는 소스에 정당하게 존재했고 실제로 렌더도 됐다 — 결함은 색이 아니라 **가드가
// 없던 것**이었다(`{!hideSns && snsHandle && ...}` 이 @계정명에만 걸려 있었다). 자매 파일
// `category-color-reclaim.test.ts` 가 스스로 경고하는 함정("그렙은 그 코드가 렌더에 도달하는지
// 못 본다")의 실제 사례라, 여기서는 DOM 을 직접 센다.
//
// 인과 주의(시간순): 이 프롭은 도입(`34b1475`, 2026-06-19)부터 "소셜 아이콘 및 계정명 제거"를
// 선언했다 — P8 색 원칙 성문화(2026-07-15)보다 4주 앞선다. 그러니 이건 **계약 버그**이지 색
// 정책이 새로 내린 판단이 아니다. 고치면서 P8("범주는 색을 받지 않는다") 위반이 결과적으로
// 같이 닫혔을 뿐이다 — 모바일 영업 화면이 `hideSns={true}` 로 "SNS 안 보여준다"를 선언했는데도
// 플랫폼 hue 가 새던 구멍.
//
// 범위 경계: 아이콘이 **정당하게 뜨는** 데스크톱 9개 호출부(`hideSns` 기본 false)의 hue 회수는
// D2 소관이다(`seller-identity-info.tsx:46,49`). 이 PR 은 그 두 줄을 건드리지 않는다 —
// 색 정책이 아니라 **계약 버그**만 고친다.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SellerIdentityInfo } from "../seller-identity-info";

describe("SellerIdentityInfo — hideSns 계약", () => {
  it("hideSns=true 면 플랫폼 아이콘과 @계정명이 둘 다 사라진다 (이름만 남는다)", () => {
    const { container, queryByText, getByText } = render(
      <SellerIdentityInfo
        sellerName="테스트 셀러"
        snsType="INSTAGRAM"
        snsHandle="test_handle"
        variant="compact"
        hideSns={true}
      />,
    );

    // 이름은 남는다 — hideSns 는 SNS 표시만 끄는 것이지 정체를 지우는 게 아니다.
    expect(getByText("테스트 셀러")).toBeInTheDocument();

    // @계정명 없음 (이건 원래도 통과했다)
    expect(queryByText(/@test_handle/)).not.toBeInTheDocument();

    // 아이콘 없음 — **이 단언이 회귀 전에는 실패했다.** lucide 아이콘은 svg 로 렌더된다.
    expect(container.querySelectorAll("svg")).toHaveLength(0);
  });

  it("hideSns=true 면 플랫폼 hue(pink/red)가 DOM 에 존재하지 않는다", () => {
    for (const snsType of ["INSTAGRAM", "YOUTUBE"]) {
      const { container } = render(
        <SellerIdentityInfo
          sellerName="테스트 셀러"
          snsType={snsType}
          snsHandle="test_handle"
          variant="compact"
          hideSns={true}
        />,
      );
      expect(container.innerHTML).not.toMatch(/pink-500|red-500/);
    }
  });

  it("hideSns 기본값(false)에서는 아이콘·계정명이 그대로 렌더된다 — 데스크톱 9개 호출부 보존", () => {
    // 음성 대조군: 위 단언이 "항상 0개"라서 통과하는 게 아님을 증명한다.
    const { container, getByText } = render(
      <SellerIdentityInfo sellerName="테스트 셀러" snsType="INSTAGRAM" snsHandle="test_handle" variant="compact" />,
    );

    expect(getByText(/@test_handle/)).toBeInTheDocument();
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(1);
  });
});
