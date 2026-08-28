// 캠페인 1건 세금계산서 입력 도우미 계약 (2026-08-03, 채널·금액 기준 정정판 2026-08-04).
//
// 오너가 홈택스에 수기 입력하는 전제라, 한 덩어리 텍스트가 아니라 필드별 라벨+값+복사가
// 정답이다. 결번 필드는 빈칸으로 넘기지 않고 눈에 띄게 표시한다.
//
// ⛔ 2026-08-04 정정 — 이 다이얼로그는 "우리가 항상 셀러에게 총매출 세금계산서를
// 발행한다"는 잘못된 가정으로 만들어졌다. 실제 발행 기준(스펙 「⛔ 채널별 세금계산서
// 거래 구조」)은 `actualSales − sellerExpense`(셀러몰만)다. 아래 픽스처는 일부러
// `actualSales`와 `actualSales − sellerExpense`가 크게 벌어지도록 값을 골라, 옛
// 계산식(actualSales 기준)으로 되돌아가면 반드시 실패하게 만든다.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaxInvoiceHelperDialog } from "../tax-invoice-helper-dialog";
import type { CampaignGroupMemberRow, CampaignRow } from "@/lib/crm-types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// actualSales(VAT포함) − sellerExpense(VAT포함, 셀러 수수료) = 11,000,000
// → 공급가액 10,000,000 / 세액 1,000,000 / 합계 11,000,000 (정정된 기준)
// 옛 기준(actualSales 그대로)이면 공급가액 12,000,000 / 세액 1,200,000 / 합계
// 13,200,000(=actualSales)이 나온다 — 아래 테스트가 이 옛 값의 부재를 함께 고정한다.
function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    dealName: "딜A",
    campaignName: "딜A - 셀러1 1차",
    sellerId: "s1",
    sellerName: "셀러1",
    endDate: "2026-07-10",
    salesChannel: "SELLER_MALL",
    sellerTaxType: "BUSINESS",
    sellerCompanyName: "○○커머스",
    sellerCompanyCeoName: "대표A",
    sellerCompanyBusinessNumber: "123-45-67890",
    sellerCompanyAddress: "서울시 어딘가",
    sellerCompanyBusinessType: "도소매",
    sellerCompanyBusinessItem: "전자상거래",
    sellerCompanyEmail: "a@example.com",
    actualSales: 13_200_000,
    sellerExpense: 2_200_000,
    ...overrides,
  } as CampaignRow;
}

describe("세금계산서 입력 도우미", () => {
  it("공급받는자 필드를 라벨과 함께 보여준다", () => {
    render(<TaxInvoiceHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    expect(screen.getByText("사업자등록번호")).toBeInTheDocument();
    expect(screen.getByText("1234567890")).toBeInTheDocument(); // 하이픈 제거된 정규화 값
    expect(screen.getByText("○○커머스")).toBeInTheDocument();
  });

  it("공급가액·세액·합계를 (actualSales−sellerExpense) 기준으로 계산해 보여준다", () => {
    render(<TaxInvoiceHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    // 공급가액(10,000,000)은 품목 표의 단가 칸에도 같은 값이 나오므로 getAllByText.
    expect(screen.getAllByText("10,000,000").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1,000,000")).toBeInTheDocument(); // 세액
    expect(screen.getByText("11,000,000")).toBeInTheDocument(); // 합계
  });

  it("오신고 회귀 방지 — actualSales 전액 기준(옛 계산)의 숫자가 등장하지 않는다", () => {
    render(<TaxInvoiceHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    // 옛 mapLineItems 기준이면 공급가액 12,000,000 / 세액 1,200,000 / 합계
    // 13,200,000(actualSales 그대로)이 나왔다 — 셀러 수수료 전액만큼의 과다표시다.
    expect(screen.queryByText("12,000,000")).not.toBeInTheDocument();
    expect(screen.queryByText("1,200,000")).not.toBeInTheDocument();
    expect(screen.queryByText("13,200,000")).not.toBeInTheDocument();
  });

  it("셀러몰이 아닌 채널(우리몰)에서는 발행 의무가 없어 금액이 「입력 필요」로 뜬다", () => {
    render(
      <TaxInvoiceHelperDialog
        open
        campaign={makeCampaign({ salesChannel: "OWN_MALL" })}
        onOpenChange={() => {}}
      />,
    );
    // 우리몰은 우리가 셀러에게 발행하는 계산서가 없다(스펙 확정) — 숫자를 추정해
    // 채우지 않고 결번으로 표시해야 한다.
    expect(screen.queryByText("10,000,000")).not.toBeInTheDocument();
    expect(screen.getAllByText(/입력 필요/).length).toBeGreaterThan(0);
  });

  it("실매출(actualSales) 미확정 시 금액과 품목 모두 「입력 필요」로 표시한다", () => {
    render(
      <TaxInvoiceHelperDialog
        open
        campaign={makeCampaign({ actualSales: null })}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByText("10,000,000")).not.toBeInTheDocument();
    expect(screen.getByText(/품목을 만들 수 없습니다/)).toBeInTheDocument();
  });

  it("누락 필드를 빈칸이 아니라 경고로 표시한다", () => {
    render(
      <TaxInvoiceHelperDialog
        open
        campaign={makeCampaign({ sellerCompanyBusinessNumber: null })}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getAllByText(/입력 필요/).length).toBeGreaterThan(0);
  });

  it("각 필드에 복사 버튼이 있다", () => {
    render(<TaxInvoiceHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    expect(screen.getAllByRole("button", { name: /복사/ }).length).toBeGreaterThan(3);
  });

  // Finding 2(2026-08-04 재검토) — 정산 그룹 소속이면 이 도우미도 세무 처리 보드와
  // 같은 합산 금액을 보여줘야 한다. 이전에는 이 다이얼로그가 항상 캠페인 1건만
  // 계산해서, 3인 그룹의 보드 행(합산 14,000,000)과 이 다이얼로그(캠페인 1건 몫
  // 8,000,000)가 서로 다른 숫자를 냈다 — 오너가 어느 쪽을 홈택스에 옮겨야 할지
  // 알 수 없는 상태였다.
  describe("정산 그룹 소속 — groupMembers 를 받으면 보드와 같은 합산 금액을 낸다", () => {
    function makeMember(overrides: Partial<CampaignGroupMemberRow>): CampaignGroupMemberRow {
      return {
        campaignId: "x",
        dealName: "딜",
        campaignName: null,
        status: "SETTLEMENT_IN_PROGRESS",
        startDate: "2026-07-01",
        endDate: "2026-07-10",
        roundNumber: null,
        salesChannel: "SELLER_MALL",
        actualSales: 0,
        sellerExpense: 0,
        settlementItems: [],
        ...overrides,
      };
    }

    it("3인 그룹 전원의 (actualSales-sellerExpense) 합산 — 캠페인 1건 몫이 아니다", () => {
      const groupMembers = [
        makeMember({ campaignId: "m1", actualSales: 11_000_000, sellerExpense: 2_200_000 }),
        makeMember({ campaignId: "m2", actualSales: 5_500_000, sellerExpense: 1_100_000 }),
        makeMember({ campaignId: "m3", actualSales: 2_750_000, sellerExpense: 550_000 }),
      ];
      render(
        <TaxInvoiceHelperDialog
          open
          campaign={makeCampaign()}
          groupMembers={groupMembers}
          onOpenChange={() => {}}
        />,
      );
      // base 8,800,000+4,400,000+2,200,000=15,400,000 → 공급가 14,000,000 / 세액 1,400,000
      expect(screen.getAllByText("14,000,000").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("1,400,000")).toBeInTheDocument();
      // 캠페인 1건 몫(옛 계산, 8,000,000)이 아니라는 회귀 방지.
      expect(screen.queryByText("8,000,000")).not.toBeInTheDocument();
      // 그룹 합산임을 명시하는 안내문이 있어야 한다 — 없으면 오너가 이 숫자를
      // 캠페인 1건 금액으로 오인한다.
      expect(screen.getByText(/그룹 전체.*합산/)).toBeInTheDocument();
    });

    it("groupMembers 가 1건뿐이면(그룹이라도 형제 없음) 캠페인 단독 금액으로 동작한다", () => {
      render(
        <TaxInvoiceHelperDialog
          open
          campaign={makeCampaign()}
          groupMembers={[makeMember({ campaignId: "c1", actualSales: 13_200_000, sellerExpense: 2_200_000 })]}
          onOpenChange={() => {}}
        />,
      );
      expect(screen.getAllByText("10,000,000").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText(/그룹 전체.*합산/)).not.toBeInTheDocument();
    });

    it("groupMembers 를 아예 안 주면(무그룹 캠페인) 캠페인 단독 금액으로 동작한다 — 회귀 없음", () => {
      render(<TaxInvoiceHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
      expect(screen.queryByText(/그룹 전체.*합산/)).not.toBeInTheDocument();
    });
  });
});
