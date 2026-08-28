// @vitest-environment jsdom
// 「가격조회」 트리거 라벨 계약 (오너 지시 2026-08-28).
//
// 종전 라벨 「최저가 조회」는 매출 상세 내역 헤더에서 폭을 크게 먹어 한 줄에 들어가지
// 못하게 만든 요인 중 하나였다. 라벨만 짧게 바꾸고 기능은 그대로다.
// ⚠️ 홈 「최저가 방어」 카드 등 다른 표면의 「최저가」 표기는 대상이 아니다.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarketPriceMonitor } from "../market-price-monitor";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

describe("MarketPriceMonitor — 트리거 라벨", () => {
  it("버튼 라벨이 「가격조회」다", () => {
    render(
      <MarketPriceMonitor
        items={[{ id: "d1", name: "테스트 딜", searchQuery: "테스트 딜", sellingPrice: 10_000 }]}
        campaignShippingFee={null}
        campaignFreeShippingThreshold={null}
      />,
    );
    expect(screen.getByRole("button", { name: /가격조회/ })).toBeInTheDocument();
    expect(screen.queryByText("최저가 조회")).not.toBeInTheDocument();
  });
});
