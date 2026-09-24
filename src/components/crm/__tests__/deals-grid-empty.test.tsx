// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DealsGrid } from "../deals-grid";

/**
 * 검색·필터가 빗나가 0건인 것과 딜이 하나도 없는 것은 다른 상태다 — 종전에는 둘 다
 * 「등록된 딜이 없습니다」라 검색 실패를 딜이 사라진 것으로 읽게 했다(interfaces 점검 #9).
 */
describe("DealsGrid 빈 상태", () => {
  it("필터가 걸린 0건은 조건 불일치로 말하고 필터를 푸는 길을 준다", () => {
    const onClearFilters = vi.fn();
    render(<DealsGrid initialDeals={[]} isFiltered onClearFilters={onClearFilters} />);

    expect(screen.getByText("조건에 맞는 딜이 없습니다")).toBeInTheDocument();
    expect(screen.queryByText("등록된 딜이 없습니다")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("검색어가 있으면 무엇으로 찾았는지 말한다", () => {
    render(<DealsGrid initialDeals={[]} isFiltered filterQuery="콜라겐" onClearFilters={vi.fn()} />);

    expect(screen.getByText("'콜라겐'에 맞는 딜이 없습니다")).toBeInTheDocument();
  });

  it("필터가 없으면 등록 안내를 보인다", () => {
    render(<DealsGrid initialDeals={[]} />);

    expect(screen.getByText("등록된 딜이 없습니다")).toBeInTheDocument();
    expect(screen.queryByText("조건에 맞는 딜이 없습니다")).not.toBeInTheDocument();
  });
});
