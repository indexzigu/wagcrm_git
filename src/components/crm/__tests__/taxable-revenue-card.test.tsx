// @vitest-environment jsdom
// 과세기준매출 카드 렌더 — 합성 트래커(합성 수치만)로 네 상태를 본다: 여유 충분 · 근접 · 초과 · 미지정 경고.
// 트래커는 손으로 만들지 않고 순수 SSOT(`buildTaxableRevenueTracker`)로 만든다 — 손 픽스처는
// 계산과 표시가 어긋나도 초록이 된다.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaxableRevenueCard } from "../taxable-revenue-card";
import {
  buildTaxableRevenueTracker,
  type TaxableRevenueCampaignInput,
} from "@/lib/taxable-revenue-tracker";

const NOW = new Date("2026-09-29T12:00:00+09:00"); // 기준 2026년 1기+2기, 다음 갱신 2027-02-14

function campaign(overrides: Partial<TaxableRevenueCampaignInput> = {}): TaxableRevenueCampaignInput {
  const endDate = overrides.endDate ?? new Date("2026-08-10T12:00:00+09:00");
  return {
    salesChannel: "OWN_MALL_NAVER",
    status: "CLOSED",
    actualSales: 1_100_000,
    sellerExpense: null,
    settlementSales: null,
    settlementItems: [],
    ...overrides,
    endDate,
    startDate: overrides.startDate ?? endDate,
  };
}

function renderCard(campaigns: TaxableRevenueCampaignInput[], now: Date = NOW) {
  render(<TaxableRevenueCard tracker={buildTaxableRevenueTracker(campaigns, now)} />);
  return screen.getByTestId("taxable-revenue-card");
}

describe("TaxableRevenueCard", () => {
  it("여유 충분 — 기준선까지 남은 공급가액이 주 숫자이고 갱신일·기준기간·주의 문구가 보인다", () => {
    const card = renderCard([campaign({ actualSales: 110_000_000 })]); // 공급 1억
    expect(within(card).getByText("기준선 3억까지 남은 금액 (공급가액)")).toBeInTheDocument();
    const value = within(card).getByText("200,000,000원");
    expect(value.className).toContain("text-foreground");
    expect(within(card).getByText(/다음 갱신 2027\.02\.14 · 기준기간 2026년 1기\+2기/)).toBeInTheDocument();
    expect(within(card).queryByText(/원문 미확인/)).not.toBeInTheDocument();
    const bar = within(card).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "33");
    // 스크린리더에 「33」만이 아니라 금액·기준선을 함께 읽힌다
    expect(bar).toHaveAttribute("aria-valuetext", "누적 100,000,000원, 기준선 3억의 33%");
    // 빈 구간(= 남은 금액)이 보이는 트랙 — slate-100(흰 카드 대비 1.09:1)으로 되돌리면 다시 사라진다.
    // shadow-inner 를 얹으면 홈 윗줄에서 urgent 채움 대비가 2.83 으로 3:1 아래가 된다.
    expect(bar.className).toContain("bg-slate-300");
    expect(bar.className).not.toContain("bg-slate-100");
    expect(bar.className).not.toContain("bg-slate-200");
    expect(bar.className).not.toContain("shadow-inner");
    // 잘리는 부제는 title 로 전문을 남긴다
    expect(within(card).getByTitle("다음 갱신 2027.02.14 · 기준기간 2026년 1기+2기")).toBeInTheDocument();
    expect(within(card).getByText("기준선을 VAT 포함 매출로 판정할 경우: 여유 190,000,000원")).toBeInTheDocument();
    expect(within(card).getByText(/현재 등급\(CRM 추정\) 영세 1\.947%/)).toBeInTheDocument();
    expect(within(card).getByText(/직전 갱신\(2026\.08\.14\) 기준기간 2025년 2기 \+ 2026년 1기의 CRM 누적으로 추정/)).toBeInTheDocument();
    expect(within(card).getByText(/CRM 캠페인 기준 추정치/)).toBeInTheDocument();
    // 네이버 자사몰 1.1억 × (2.563% − 1.947%) = 677,600원
    expect(within(card).getByText("넘으면")).toBeInTheDocument();
    expect(within(card).getByText("반년 약 677,600원 추가 수수료")).toBeInTheDocument();
    expect(within(card).getByText(/네이버페이 결제분만 반영/)).toBeInTheDocument();
    expect(within(card).queryByRole("list", { name: "확인 필요" })).not.toBeInTheDocument();
  });

  it("근접 — 라벨에 「근접」을 싣고 주 숫자·막대가 주의색이 되며 VAT 포함 가설로는 초과임을 드러낸다", () => {
    const card = renderCard([campaign({ actualSales: 308_000_000 })]); // 공급 2.8억, 여유 2천만
    // 색만으로 전하지 않는다 — 라벨에 「근접」이 있다
    expect(within(card).getByText("기준선 3억 근접 · 남은 금액 (공급가액)")).toBeInTheDocument();
    const value = within(card).getByText("20,000,000원");
    expect(value.className).toContain("text-status-caution-text");
    expect(within(card).getByRole("progressbar").firstElementChild?.className).toContain("bg-status-caution");
    expect(within(card).getByText("기준선을 VAT 포함 매출로 판정할 경우: 8,000,000원 초과")).toBeInTheDocument();
  });

  it("근접 끝자락 — 넘기 전에는 진행률을 내림해 99.5% 를 「100%」로 읽지 않는다", () => {
    const card = renderCard([campaign({ actualSales: 328_350_000 })]); // 공급 2.985억 = 99.5%
    const bar = within(card).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "99");
    expect(bar).toHaveAttribute("aria-valuetext", "누적 298,500,000원, 기준선 3억의 99%");
  });

  it("내림이 부동소수점 오차로 1%p 를 깎지 않는다 — 정확히 29% 는 29 로 읽힌다", () => {
    const card = renderCard([campaign({ actualSales: 95_700_000 })]); // 공급 8,700만 / 3억 = 정확히 29%
    expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "29");
  });

  it("초과 — 「기준선 N원 초과」로 전환하고 예상 등급·다음 기준선·이미 넘은 비용을 보인다", () => {
    const card = renderCard([campaign({ actualSales: 352_000_000 })]); // 공급 3.2억
    expect(within(card).getByText("기준선 3억 초과 (공급가액)")).toBeInTheDocument();
    const value = within(card).getByText("20,000,000원");
    expect(value.className).toContain("text-status-urgent");
    expect(within(card).getByText(/예상 등급 중소1/)).toBeInTheDocument();
    expect(within(card).getByText("다음 기준선 5억까지 180,000,000원")).toBeInTheDocument();
    expect(within(card).getByText("추정대로 갱신되면")).toBeInTheDocument();
    expect(within(card).getByText(/영세 1\.947% → 중소1 2\.563%/)).toBeInTheDocument();
    const bar = within(card).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "누적 320,000,000원, 기준선 3억 초과");
  });

  it("미지정·미입력 경고 — 분류 필요 건수, 미지정 범위(하한~상한), 합계 제외 건수를 보인다", () => {
    const card = renderCard([
      campaign({ actualSales: 11_000_000 }),
      campaign({ salesChannel: "UNSPECIFIED", actualSales: 5_500_000, settlementSales: 1_100_000 }),
      campaign({ salesChannel: "SELLER_MALL", actualSales: 2_200_000, sellerExpense: null }),
    ]);
    const warnings = within(card).getByRole("list", { name: "확인 필요" });
    expect(within(warnings).getByText("채널 미지정 1건 분류 필요")).toBeInTheDocument();
    expect(within(warnings).getByText("금액 미입력 1건 (합계 제외)")).toBeInTheDocument();
    expect(within(card).getByText("1,000,000원 ~ 5,000,000원")).toBeInTheDocument();
    // 보수적 여유 = 3억 − (1,100만 + 550만)/1.1
    expect(within(card).getByText("285,000,000원")).toBeInTheDocument();
  });

  it("진행·예정 캠페인의 빈 금액은 「금액 미입력」이 아니라 별도 무채색 줄로 보인다", () => {
    const card = renderCard([
      campaign({ actualSales: 11_000_000 }),
      campaign({ status: "ACTIVE", endDate: new Date("2026-10-20T12:00:00+09:00"), actualSales: null }),
    ]);
    expect(within(card).getByText("진행·예정 1건 매출 미반영 (여유가 더 줄어들 수 있음)")).toBeInTheDocument();
    expect(within(card).queryByText(/금액 미입력/)).not.toBeInTheDocument();
    expect(within(card).queryByRole("list", { name: "확인 필요" })).not.toBeInTheDocument();
  });

  it("8월 갱신 창에서는 기준기간이 원문 미확인 가정임을 표시한다", () => {
    const card = renderCard([], new Date("2027-03-01T12:00:00+09:00"));
    const subtitle = within(card).getByText(/기준기간 2026년 2기 \+ 2027년 1기 \(8월 갱신 기준기간은 원문 미확인\)/);
    // 가정 경고는 문장 끝이라 truncate 에 가장 먼저 잘린다 — title 에 반드시 남는다
    expect(subtitle.getAttribute("title")).toContain("(8월 갱신 기준기간은 원문 미확인)");
  });
});
