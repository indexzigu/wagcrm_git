// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MobileHomeSettlementCard } from "../mobile-home-settlement-card";
import { MONEY_DIRECTION_TEXT } from "@/lib/money-direction";
import type { MobileSettlementCampaign } from "@/lib/mobile-settlement-data";

/**
 * 홈 정산 대기 카드 — 방향(입금/지급) 색 계약.
 *
 * 회귀 배경: 이 카드는 자금 방향을 렌더하는 5개 표면 중 **유일하게 아이콘이 없어**
 * 입금·지급이 라벨 글자로만 구분됐고, 금액은 둘 다 text-slate-800 이었다. 첫 화면인데
 * 가장 약한 표현이었다(오너 지적 2026-07-15 "색이 너무 소극적").
 */

const base: MobileSettlementCampaign = {
  id: "camp-1",
  groupId: null,
  dealName: "테스트 딜",
  sellerName: "셀러 A",
  roundNumber: null,
  status: "SETTLEMENT_WAIT",
  salesChannel: "SELLER_MALL",
  startDate: "2026-07-01",
  endDate: "2026-07-10",
  expectedDepositDate: "2026-07-20",
  expectedPayoutDate: "2026-07-25",
  expectedSupplierPayoutDate: null,
  settlementSales: 12_400_000,
  actualSales: null,
  actualPayoutAmount: null,
  sellerExpense: 8_200_000,
  isDepositReceived: false,
  isPayoutCompleted: false,
  isSupplierPayoutCompleted: false,
};

/** 타일은 aria-label 로 연다 — 시각 텍스트가 아니라 의미로 집는다. */
function tiles() {
  return {
    deposit: screen.getByLabelText("입금 대기 목록 열기"),
    payout: screen.getByLabelText("지급 대기 목록 열기"),
  };
}

describe("MobileHomeSettlementCard — 자금 방향 색", () => {
  it("입금과 지급 타일이 서로 다른 방향 색을 쓴다", () => {
    render(<MobileHomeSettlementCard campaigns={[base]} />);
    const { deposit, payout } = tiles();

    expect(deposit.innerHTML).toContain(MONEY_DIRECTION_TEXT.in);
    expect(payout.innerHTML).toContain(MONEY_DIRECTION_TEXT.out);
    // 대칭 계약: 한쪽만 칠하면 "지급 = 나쁜 것"으로 오독된다.
    expect(deposit.innerHTML).not.toContain(MONEY_DIRECTION_TEXT.out);
    expect(payout.innerHTML).not.toContain(MONEY_DIRECTION_TEXT.in);
  });

  it("방향 아이콘이 존재한다 — 색 단독 인코딩 금지(색각 이상·실외 가독성)", () => {
    const { container } = render(<MobileHomeSettlementCard campaigns={[base]} />);
    // lucide 아이콘은 svg 로 렌더된다. 이전에는 이 카드에 아이콘이 0개였다.
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
  });

  it("금액이 무채색으로 되돌아가지 않는다 — 타일은 초점 숫자다", () => {
    render(<MobileHomeSettlementCard campaigns={[base]} />);
    const { deposit, payout } = tiles();
    // 구 회귀 형태: 양쪽 금액이 text-slate-800 로 같았다.
    for (const tile of [deposit, payout]) {
      expect(tile.innerHTML).not.toContain("tabular-nums tracking-tight text-slate-800");
    }
  });
});
