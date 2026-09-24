// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DealProfitabilityTable, type DealProfitabilityRow } from "../deal-profitability-table";

function row(dealId: string, totalMargin: number): DealProfitabilityRow {
  return {
    dealId,
    dealName: `딜-${dealId}`,
    partnerName: "거래처",
    totalRevenue: 100000,
    totalMargin,
    campaignCount: 1,
    bestSeller: null,
  };
}

// 총 마진은 판정값(흑자/적자)이다 — 표 열이라 profit-tone 의 **밀집** 강도를 탄다:
// 흑자·0 은 무색(본문색), 적자만 경고색. 종전엔 부호 무관 무조건 초록이었다.
describe("DealProfitabilityTable — 총 마진 판정색(밀집 강도)", () => {
  function marginCell(text: string) {
    return screen.getByText(text);
  }

  it("흑자는 초록을 받지 않고 본문색을 유지한다", () => {
    render(<DealProfitabilityTable deals={[row("a", 12000)]} />);
    const cell = marginCell("12,000원");
    expect(cell.className).not.toContain("text-money-in-text");
    expect(cell.className).not.toContain("text-status-urgent-text");
    expect(cell.className).toContain("text-foreground");
  });

  it("0 은 손실이 아니므로 경고색을 띄우지 않는다", () => {
    render(<DealProfitabilityTable deals={[row("b", 0)]} />);
    const cell = marginCell("0원");
    expect(cell.className).not.toContain("text-status-urgent-text");
    expect(cell.className).not.toContain("text-money-in-text");
  });

  it("적자는 경고색(status-urgent-text)을 받고 본문색은 밀려난다", () => {
    render(<DealProfitabilityTable deals={[row("c", -3000)]} />);
    const cell = marginCell("-3,000원");
    expect(cell.className).toContain("text-status-urgent-text");
    expect(cell.className).not.toContain("text-foreground");
  });
});
