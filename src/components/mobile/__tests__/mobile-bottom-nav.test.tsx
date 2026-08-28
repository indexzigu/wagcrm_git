import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MobileBottomNav } from "../mobile-bottom-nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
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
