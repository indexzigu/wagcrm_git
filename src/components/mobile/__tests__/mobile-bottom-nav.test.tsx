// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MobileBottomNav } from "../mobile-bottom-nav";

// 경로별 숨김 판정을 시험하려고 pathname 을 테스트마다 바꿀 수 있게 둔다(기본 "/").
const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// 모바일 PWA 환경에서만 렌더되는 컴포넌트 — 환경 감지 훅을 고정한다.
vi.mock("@/hooks/use-web-app-environment", () => ({
  useWebAppEnvironment: () => ({
    isReady: true,
    isMobile: true,
    isStandalone: true,
    isIos: false,
  }),
}));

describe("MobileBottomNav — 탭 순서 (오너 피드백 2026-07-15)", () => {
  it("탭 순서는 홈 → 일정 → 캠페인이다", () => {
    render(<MobileBottomNav />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["홈", "일정", "캠페인"]);
  });

  it("탭 경로는 / → /schedule → /pipeline 순서로 매핑된다", () => {
    render(<MobileBottomNav />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/",
      "/schedule",
      "/pipeline",
    ]);
  });

  it("현재 경로 탭만 aria-current=page로 활성화된다 (정확 일치 매칭)", () => {
    render(<MobileBottomNav />);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("aria-current", "page");
    expect(links[1]).not.toHaveAttribute("aria-current");
    expect(links[2]).not.toHaveAttribute("aria-current");
  });
});

describe("MobileBottomNav — 셀러 포털에서는 CRM 탭 바를 그리지 않는다", () => {
  afterEach(() => {
    nav.pathname = "/";
  });

  // 셀러가 포털을 홈 화면에 추가해 열면 이 컴포넌트의 스탠드얼론 게이트를 통과한다 —
  // 셀러는 CRM 사용자가 아니므로 오너용 탭(홈·일정·캠페인)이 보이면 안 된다.
  it.each(["/some-seller", "/some-seller/", "/some-seller/card/abc123", "/p/token-abcdefghijklmnopqrst"])(
    "%s 에서는 렌더하지 않는다",
    (pathname) => {
      nav.pathname = pathname;
      const { container } = render(<MobileBottomNav />);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryAllByRole("link")).toHaveLength(0);
    },
  );

  // 포털 판정(isPortalPublicPath)은 한 세그먼트 경로를 슬러그로 보지만 예약어는 제외한다 —
  // 실제 CRM 화면이 포털로 오판돼 탭 바가 사라지지 않는지 고정한다.
  it.each(["/", "/schedule", "/pipeline", "/settlement", "/sellers", "/deals", "/reports", "/settings"])(
    "CRM 경로 %s 에서는 렌더한다",
    (pathname) => {
      nav.pathname = pathname;
      render(<MobileBottomNav />);
      expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["홈", "일정", "캠페인"]);
    },
  );
});
