// @vitest-environment jsdom
// 정산 선택 액션 바 계약(#439·#440 에서 도입, 2026-08-24 완료 표 선택 확장).
//  ① 선택 0건이면 바 자체가 없다.
//  ② 합계 4종(거래액·영업수익·판매대행비·영업이익)을 라벨과 함께 렌더한다.
//  ③ ⛔ 바는 **하나뿐**이다 — 진행 중·완료 두 표가 각자 바를 띄우면 둘 다 fixed 라
//     겹친다. 그래서 선택 상태는 페이지가 소유하고 두 표는 제어형 prop 을 받는다.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  SettlementSelectionBar,
  SettlementPartnerBreakdownList,
} from "../settlement-selection-bar";
import { buildPartnerSettlementBreakdown } from "@/lib/settlement-partner-breakdown";
import { SettlementTable } from "../settlement-table";
import { SettlementCompletedTable } from "../settlement-completed-table";
import type { CampaignRow } from "@/lib/crm-types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    dealName: "테스트딜",
    campaignName: "테스트딜 - 테스트셀러",
    partnerName: "테스트거래처",
    sellerName: "테스트셀러",
    salesChannel: "OWN_MALL",
    sellerTaxType: "BUSINESS",
    actualSales: 1_000_000,
    settlementSales: 200_000,
    sellerExpense: 120_000,
    operatingProfit: 80_000,
    ...overrides,
  } as CampaignRow;
}

describe("SettlementSelectionBar", () => {
  it("선택 0건이면 렌더하지 않는다", () => {
    render(
      <SettlementSelectionBar
        selectedCampaigns={[]}
        summary={{ actualSales: 0, settlementSales: 0, sellerExpense: 0, operatingProfit: 0 }}
      />,
    );
    expect(screen.queryByText(/선택됨/)).not.toBeInTheDocument();
  });

  it("합계 4종을 라벨과 함께 표시한다", () => {
    render(
      <SettlementSelectionBar
        selectedCampaigns={[makeCampaign(), makeCampaign({ id: "c2" })]}
        summary={{
          actualSales: 1_500_000,
          settlementSales: 300_000,
          sellerExpense: 180_000,
          operatingProfit: -40_000,
        }}
      />,
    );

    expect(screen.getByText("선택됨: 2건")).toBeInTheDocument();
    const summary = within(screen.getByTestId("settlement-selection-summary"));
    expect(summary.getByText("1,500,000")).toBeInTheDocument();
    expect(summary.getByText("300,000")).toBeInTheDocument();
    expect(summary.getByText("180,000")).toBeInTheDocument();
    // 음수 영업이익도 그대로 표시된다(미입력 0 과 구분되는 실제 값)
    expect(summary.getByText("-40,000")).toBeInTheDocument();
    for (const label of ["거래액", "영업수익", "판매대행비", "영업이익"]) {
      expect(summary.getByText(label)).toBeInTheDocument();
    }
  });
});

describe("두 표의 선택 계약", () => {
  it("정산 진행 중 표: 행·전체 선택이 페이지 콜백으로 나간다", () => {
    const onToggleRow = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <SettlementTable
        campaigns={[makeCampaign()]}
        onSelectCampaign={vi.fn()}
        loading={false}
        selectedIds={[]}
        onToggleRow={onToggleRow}
        onToggleAll={onToggleAll}
      />,
    );

    fireEvent.click(screen.getByLabelText("테스트딜 - 테스트셀러 선택"));
    expect(onToggleRow).toHaveBeenCalledWith("c1", true);

    fireEvent.click(screen.getByLabelText("모든 정산 항목 선택"));
    expect(onToggleAll).toHaveBeenCalledWith(["c1"], true);
  });

  it("정산 완료 표도 같은 계약으로 선택된다", () => {
    const onToggleRow = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <SettlementCompletedTable
        campaigns={[makeCampaign({ id: "done1" })]}
        reportCampaigns={[]}
        onSelectCampaign={vi.fn()}
        loading={false}
        selectedIds={[]}
        onToggleRow={onToggleRow}
        onToggleAll={onToggleAll}
      />,
    );

    fireEvent.click(screen.getByLabelText("테스트딜 - 테스트셀러 선택"));
    expect(onToggleRow).toHaveBeenCalledWith("done1", true);

    fireEvent.click(screen.getByLabelText("모든 정산 완료 항목 선택"));
    expect(onToggleAll).toHaveBeenCalledWith(["done1"], true);
  });

  // 2026-08-24 실렌더에서 잡힌 결함의 회귀 — `selectedIds` 는 페이지 전역이라
  // **그 표에 없는 id** 가 섞여 들어온다. 개수만 비교하면 헤더가 거짓 체크되고,
  // 그 상태에서 헤더를 누르면 해제가 나가 "전체 선택"이 한 번은 아무것도 선택하지 않는다.
  // ⚠️ 픽스처에 남의 id 를 섞지 않으면 이 결함은 **발생 자체가 불가능**하다(종전 테스트가
  // 한 표만 렌더해 모집단이 항상 일치했던 것이 못 잡은 이유다).
  it.each([
    ["정산 진행 중", "모든 정산 항목 선택"],
    ["정산 완료", "모든 정산 완료 항목 선택"],
  ])("%s 표: 다른 표의 선택은 이 표의 전체선택을 켜지 않는다", (_label, headerLabel) => {
    const isCompleted = headerLabel.includes("완료");
    const rows = [makeCampaign({ id: "mine1" }), makeCampaign({ id: "mine2" })];
    const otherSectionIds = ["other1", "other2"]; // 개수는 같지만 이 표의 행이 아니다

    render(
      isCompleted ? (
        <SettlementCompletedTable
          campaigns={rows}
          reportCampaigns={[]}
          onSelectCampaign={vi.fn()}
          loading={false}
          selectedIds={otherSectionIds}
          onToggleRow={vi.fn()}
          onToggleAll={vi.fn()}
        />
      ) : (
        <SettlementTable
          campaigns={rows}
          onSelectCampaign={vi.fn()}
          loading={false}
          selectedIds={otherSectionIds}
          onToggleRow={vi.fn()}
          onToggleAll={vi.fn()}
        />
      ),
    );

    expect(screen.getByLabelText(headerLabel)).not.toBeChecked();
  });

  it("선택된 행은 두 표 모두 체크 상태로 그려진다", () => {
    const { unmount } = render(
      <SettlementTable
        campaigns={[makeCampaign()]}
        onSelectCampaign={vi.fn()}
        loading={false}
        selectedIds={["c1"]}
        onToggleRow={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("테스트딜 - 테스트셀러 선택")).toBeChecked();
    unmount();

    render(
      <SettlementCompletedTable
        campaigns={[makeCampaign({ id: "done1" })]}
        reportCampaigns={[]}
        onSelectCampaign={vi.fn()}
        loading={false}
        selectedIds={["done1"]}
        onToggleRow={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("테스트딜 - 테스트셀러 선택")).toBeChecked();
  });
});

// 오너 요청 2026-08-28: 선택 요약에 「거래처에 지급하거나 입금받아야 하는 금액」을 함께
// 보여주고, 그 금액의 출처(어느 캠페인에서 얼마)를 롤오버로 볼 수 있게 한다.
// 금액 자체의 계약은 lib 테스트(`settlement-partner-breakdown`)가 고정하므로 여기서는
// **화면에 도달하는가**와 **방향 표기**만 본다.
describe("거래처 지급·입금 금액", () => {
  const emptySummary = {
    actualSales: 0,
    settlementSales: 0,
    sellerExpense: 0,
    operatingProfit: 0,
  };

  it("보낼 돈과 받을 돈을 방향 라벨과 함께 표시한다", () => {
    render(
      <SettlementSelectionBar
        selectedCampaigns={[
          // 우리몰 = 물품대금을 지급하는 쪽. 1,000,000 − 200,000 = 800,000 지급.
          makeCampaign({ id: "c1", partnerId: "p1", partnerName: "가거래처" }),
          // 브랜드몰 = 영업수익을 받는 쪽. 350,000 입금.
          makeCampaign({
            id: "c2",
            partnerId: "p2",
            partnerName: "나거래처",
            salesChannel: "BRAND_MALL",
            settlementSales: 350_000,
          }),
        ]}
        summary={emptySummary}
      />,
    );

    const cell = within(screen.getByTestId("settlement-partner-amounts"));
    expect(cell.getByText("지급")).toBeInTheDocument();
    expect(cell.getByText("800,000")).toBeInTheDocument();
    expect(cell.getByText("입금")).toBeInTheDocument();
    expect(cell.getByText("350,000")).toBeInTheDocument();
  });

  // ss-ux-designer 판정 2026-08-28(P1): `aria-label` 은 접근성 이름 계산에서 자식 텍스트를
  // 덮어쓴다 — 화면에는 금액이 보이는데 스크린리더는 「거래처별 금액 출처」만 듣는 상태였다.
  it("스크린리더도 금액을 듣는다 — 접근성 이름에 실제 숫자가 들어간다", () => {
    render(
      <SettlementSelectionBar
        selectedCampaigns={[makeCampaign({ partnerId: "p1", partnerName: "가거래처" })]}
        summary={emptySummary}
      />,
    );

    const trigger = screen.getByTestId("settlement-partner-amounts");
    expect(trigger).toHaveAccessibleName(expect.stringContaining("거래처별 금액 출처"));
    expect(trigger).toHaveAccessibleName(expect.stringContaining("800,000"));
  });

  it("한쪽 방향만 있으면 그 칸만 뜬다", () => {
    render(
      <SettlementSelectionBar
        selectedCampaigns={[makeCampaign({ partnerId: "p1", partnerName: "가거래처" })]}
        summary={emptySummary}
      />,
    );

    const cell = within(screen.getByTestId("settlement-partner-amounts"));
    expect(cell.getByText("지급")).toBeInTheDocument();
    expect(cell.queryByText("입금")).not.toBeInTheDocument();
  });

  it("내역은 거래처별로 묶고 그 아래 캠페인별 금액을 보여준다", () => {
    const breakdown = buildPartnerSettlementBreakdown([
      {
        id: "c1",
        campaignName: "딜1 - 셀러A",
        partnerId: "p1",
        partnerName: "가거래처",
        salesChannel: "OWN_MALL",
        actualSales: 1_000_000,
        settlementSales: 300_000,
        settlementGoodsCost: 400_000,
      },
      {
        id: "c2",
        campaignName: "딜2 - 셀러B",
        partnerId: "p1",
        partnerName: "가거래처",
        salesChannel: "OWN_MALL",
        actualSales: 1_000_000,
        settlementSales: 300_000,
        settlementGoodsCost: 100_000,
      },
    ]);

    render(<SettlementPartnerBreakdownList breakdown={breakdown} />);
    const list = within(screen.getByTestId("settlement-partner-breakdown"));

    // 거래처 줄은 상계한 순액과 방향을 말한다.
    expect(list.getByText("가거래처")).toBeInTheDocument();
    expect(list.getByText("지급 500,000")).toBeInTheDocument();
    // 캠페인 줄은 부호로 방향을 말한다 — 어느 캠페인에서 얼마인지가 이 팝오버의 목적이다.
    expect(list.getByText("딜1 - 셀러A")).toBeInTheDocument();
    expect(list.getByText("-400,000")).toBeInTheDocument();
    expect(list.getByText("딜2 - 셀러B")).toBeInTheDocument();
    expect(list.getByText("-100,000")).toBeInTheDocument();
  });

  it("합계에 추정이 섞이면 바가 그 사실을 말한다 — 팝오버에만 두지 않는다", () => {
    render(
      <SettlementSelectionBar
        // 픽스처의 물품대금이 미입력이라 총액이 공식 추정이다.
        selectedCampaigns={[makeCampaign({ partnerId: "p1", partnerName: "가거래처" })]}
        summary={emptySummary}
      />,
    );
    expect(
      within(screen.getByTestId("settlement-partner-amounts")).getByText("추정 포함"),
    ).toBeInTheDocument();
  });

  it("관측값이 들어온 건만 있으면 추정 표시가 없다", () => {
    render(
      <SettlementSelectionBar
        selectedCampaigns={[
          makeCampaign({ partnerId: "p1", partnerName: "가거래처", settlementGoodsCost: 400_000 }),
        ]}
        summary={emptySummary}
      />,
    );
    expect(
      within(screen.getByTestId("settlement-partner-amounts")).queryByText("추정 포함"),
    ).not.toBeInTheDocument();
  });

  it("상계로 순액이 0 이 된 거래처도 내역에는 남는다", () => {
    const breakdown = buildPartnerSettlementBreakdown([
      {
        id: "c1",
        campaignName: "딜1 - 셀러A",
        partnerId: "p1",
        partnerName: "가거래처",
        salesChannel: "OWN_MALL",
        actualSales: 1_000_000,
        settlementSales: 300_000,
        settlementGoodsCost: 300_000,
      },
      {
        id: "c2",
        campaignName: "딜2 - 셀러B",
        partnerId: "p1",
        partnerName: "가거래처",
        salesChannel: "BRAND_MALL",
        actualSales: 1_000_000,
        settlementSales: 300_000,
      },
    ]);

    render(<SettlementPartnerBreakdownList breakdown={breakdown} />);
    const list = within(screen.getByTestId("settlement-partner-breakdown"));
    expect(list.getByText("상계 0")).toBeInTheDocument();
    expect(list.getByText("-300,000")).toBeInTheDocument();
    expect(list.getByText("+300,000")).toBeInTheDocument();
  });
});
