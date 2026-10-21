// @vitest-environment jsdom
/**
 * 공용 요약띠 — 정산 관리·판매 관리가 같은 띠를 쓴다(애플 UI 리뉴얼 묶음 2).
 * 그룹 사이 세로 헤어라인 · 빈 값 「—」 · 숫자 자리 고정 · 아이콘 · 불투명 면을 고정한다.
 */
import { render, screen, within } from "@testing-library/react";
import { Wallet } from "lucide-react";
import { describe, expect, it } from "vitest";
import { MoneySummaryStrip, moneyFlowGroup } from "../money-summary-strip";
import { MONEY_DIRECTION_ICON } from "@/lib/money-direction";

const groups = [
  [
    { key: "gross", label: "총거래액", value: 1_234_567 },
    { key: "commission", label: "수수료매출", value: null, icon: Wallet },
  ],
  [
    { key: "deposit", label: "입금대기", value: 1000, icon: MONEY_DIRECTION_ICON.in },
    { key: "payout", label: "지급대기", value: 2000, icon: MONEY_DIRECTION_ICON.out },
  ],
] as const;

function renderStrip() {
  render(<MoneySummaryStrip groups={groups} />);
  return screen.getByRole("group", { name: "금액 요약" });
}

describe("MoneySummaryStrip", () => {
  it("그룹 2개면 그룹 사이에만 세로 헤어라인 1개", () => {
    const root = renderStrip();
    const ruled = root.querySelectorAll(".border-l");
    expect(ruled).toHaveLength(1);
    expect(ruled[0].className).toContain("border-border");
    expect(within(ruled[0] as HTMLElement).getByText("입금대기:")).toBeTruthy();
  });

  it("값은 천 단위 + 원, null 은 「—」", () => {
    renderStrip();
    expect(screen.getByText("1,234,567원")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("값 span 은 숫자 자리 고정·굵게·본문색", () => {
    renderStrip();
    const value = screen.getByText("1,234,567원");
    expect(value.className).toContain("tabular-nums");
    expect(value.className).toContain("font-semibold");
    expect(value.className).toContain("text-foreground");
  });

  it("아이콘 prop 을 렌더하고 두 번째 그룹은 입금대기→지급대기 순서·방향 아이콘을 유지한다", () => {
    const root = renderStrip();
    const icons = root.querySelectorAll("svg");
    expect(icons).toHaveLength(3);
    const labels = Array.from(root.querySelectorAll("[data-slot='money-summary-label']")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["총거래액:", "수수료매출:", "입금대기:", "지급대기:"]);
    const second = root.querySelector(".border-l") as HTMLElement;
    const secondIcons = second.querySelectorAll("svg");
    expect(secondIcons[0].getAttribute("class")).toContain("lucide-circle-arrow-down");
    expect(secondIcons[1].getAttribute("class")).toContain("lucide-circle-arrow-up");
  });

  it("불투명 면 — 반투명 유리를 쓰지 않는다", () => {
    const root = renderStrip();
    expect(root.className).not.toContain("backdrop-blur");
    expect(root.className).not.toContain("bg-white/");
    expect(root.className).toContain("bg-card");
    expect(root.className).toContain("border-border");
  });

  it("돈 흐름 네 칸은 총거래액 → 수수료매출 → 셀러지급액 → 매출총이익 순서", () => {
    const items = moneyFlowGroup({ grossMerchandise: 1, commissionRevenue: 2, sellerPayout: 3, grossProfit: 4 });
    expect(items.map((item) => [item.label, item.value])).toEqual([
      ["총거래액", 1],
      ["수수료매출", 2],
      ["셀러지급액", 3],
      ["매출총이익", 4],
    ]);
  });
});
