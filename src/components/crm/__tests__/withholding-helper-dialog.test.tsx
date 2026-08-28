// @vitest-environment jsdom
// 캠페인 1건 원천징수 입력 도우미 계약 (2026-08-05).
//
// 세금계산서 도우미(tax-invoice-helper-dialog.test.tsx)의 자매 테스트다. 핵심
// 불변식: ① 금액은 computeIndividualWithholding + getStatementDeals 그대로다(재계산
// 금지 — 정산 명세서와 갈리면 안 된다) ② 주민등록번호는 기본 마스킹, 행 단위 펼침만
// 허용한다 ③ 실명 미등록이어도 활동명으로 대신 채우지 않고 「입력 필요」로 표시한다
// ④ 하단에 "이 캠페인 1건 자료를 월 합계 신고서에 그대로 옮기면 틀린다"는 경고가
// 지급월을 명시하며 항상 뜬다.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WithholdingHelperDialog } from "../withholding-helper-dialog";
import type { CampaignRow } from "@/lib/crm-types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// actualSales(VAT포함) 1,100,000 → 공급가(VAT제외) 1,000,000 × sellerMarginRate 20% =
// 200,000(총지급액, preTaxPayout). 원천세(3.3%) = round(200,000×0.033) = 6,600.
// 소득세(3%) = floor(200,000×0.03) = 6,000. 지방소득세 = 6,600−6,000 = 600.
// 차인지급액 = 200,000−6,600 = 193,400.
//
// 오신고 회귀 방지용 "그럴듯한 오답" 기준값 — actualSales(VAT 포함 그대로)에 수수료율을
// 적용하면 1,100,000×20% = 220,000 이 나온다. VAT 제외를 빠뜨린 이 값이 등장하면
// 재계산 금지 원칙이 깨진 것이다.
function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    dealId: "d1",
    sellerId: "s1",
    dealName: "테스트딜",
    campaignName: "테스트딜 - 셀러1",
    sellerName: "달콤한하루",
    sellerRealName: "김철수",
    sellerResidentNumber: "900101-9234567",
    sellerTaxType: "INDIVIDUAL",
    salesChannel: "OWN_MALL",
    actualSales: 1_100_000,
    sellerMarginRate: 20,
    payoutCompletedAt: "2026-06-25",
    ...overrides,
  } as CampaignRow;
}

describe("원천징수 입력 도우미", () => {
  it("금액을 computeIndividualWithholding 기준으로 계산해 보여준다", () => {
    render(<WithholdingHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    expect(screen.getByText("2026-06-25")).toBeInTheDocument(); // 지급일
    expect(screen.getByText("200,000원")).toBeInTheDocument(); // 총 지급액(세전)
    expect(screen.getByText("6,000원")).toBeInTheDocument(); // 소득세
    expect(screen.getByText("600원")).toBeInTheDocument(); // 지방소득세
    expect(screen.getByText("193,400원")).toBeInTheDocument(); // 차인지급액
  });

  it("금액 칸 이름이 세무 처리 카드(withholding-filing-cards)와 같은 어휘다 — T-028/T-029", () => {
    // 이 다이얼로그는 「세무 처리」 원천징수 탭으로 오너를 보내는 안내를 담고 있다
    // (아래 "월 합계 경고" 테스트). 두 화면이 같은 홈택스 칸을 다른 이름으로 부르면
    // 옮겨 간 곳에서 다시 헷갈리므로, 옛 표기(총지급액·소득세 등)로의 회귀를 막는다.
    render(<WithholdingHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    expect(screen.getByText("총 지급액(세전)")).toBeInTheDocument();
    expect(screen.getByText("소득세")).toBeInTheDocument();
    expect(screen.queryByText("총지급액")).not.toBeInTheDocument();
    expect(screen.queryByText("소득세 등")).not.toBeInTheDocument();
  });

  it("오신고 회귀 방지 — VAT 미제외(그럴듯한 오답) 기준 금액이 등장하지 않는다", () => {
    render(<WithholdingHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    // actualSales 그대로(1,100,000)에 수수료율을 곱한 220,000 — VAT 제외를 빠뜨린
    // 오답. 이 값이 보이면 재계산 금지 원칙이 깨진 것이다.
    expect(screen.queryByText("220,000원")).not.toBeInTheDocument();
    // 총지급액 대신 실매출(actualSales) 그대로를 보여주는 사고도 함께 방지한다.
    expect(screen.queryByText("1,100,000원")).not.toBeInTheDocument();
  });

  it("실명 미등록이면 활동명으로 대신 채우지 않고 「입력 필요」로 표시하되, 활동명을 병기해 식별 가능하게 한다", () => {
    render(
      <WithholdingHelperDialog
        open
        campaign={makeCampaign({ sellerRealName: null })}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getAllByText(/입력 필요/).length).toBeGreaterThan(0);
    expect(screen.getByText(/달콤한하루/)).toBeInTheDocument();
    expect(screen.queryByText("김철수")).not.toBeInTheDocument();
  });

  it("주민등록번호는 기본 마스킹이고, 펼침 버튼을 눌러야 원본이 보인다", () => {
    render(<WithholdingHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    expect(screen.queryByText("900101-9234567")).not.toBeInTheDocument();
    expect(screen.getByText("900101-9******")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "주민등록번호 보기" }));
    expect(screen.getByText("900101-9234567")).toBeInTheDocument();
    expect(screen.queryByText("900101-9******")).not.toBeInTheDocument();
  });

  it("주민등록번호 미등록이면 「입력 필요」로 표시한다", () => {
    render(
      <WithholdingHelperDialog
        open
        campaign={makeCampaign({ sellerResidentNumber: null })}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getAllByText(/입력 필요/).length).toBeGreaterThan(0);
  });

  it("월 합계 경고가 항상 뜨고 지급월을 명시한다", () => {
    render(<WithholdingHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    expect(screen.getByText(/월 합계 단위입니다/)).toBeInTheDocument();
    expect(screen.getByText(/이 캠페인 1건의 숫자만 넣지 마세요/)).toBeInTheDocument();
    // 지급월(2026-06)을 명시해야 오너가 어느 달의 「세무 처리」를 열어야 하는지 안다.
    expect(screen.getByText(/2026-06 지급분/)).toBeInTheDocument();
    expect(screen.getByText(/세무 처리/)).toBeInTheDocument();
    // "원천징수"는 다이얼로그 제목("원천징수 입력 도우미")에도 등장하므로 탭 이름을
    // 특정하는 문구로 좁혀서 확인한다.
    expect(screen.getByText(/「원천징수」 탭/)).toBeInTheDocument();
  });

  it("지급월을 모르면(payoutCompletedAt 없음) 그래도 안내 문구는 뜬다 — 월 미확정 문구로 대체", () => {
    render(
      <WithholdingHelperDialog
        open
        campaign={makeCampaign({ payoutCompletedAt: null })}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/월 합계 단위입니다/)).toBeInTheDocument();
    expect(screen.getByText(/지급일 확정 후/)).toBeInTheDocument();
  });

  it("각 필드에 복사 버튼이 있다", () => {
    render(<WithholdingHelperDialog open campaign={makeCampaign()} onOpenChange={() => {}} />);
    expect(screen.getAllByRole("button", { name: "복사" }).length).toBeGreaterThan(3);
  });
});
