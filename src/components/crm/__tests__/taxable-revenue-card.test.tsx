// @vitest-environment jsdom
// 과세기준매출 카드 렌더 — 합성 트래커(합성 수치만)로 네 상태를 본다: 여유 충분 · 근접 · 초과 · 미지정 경고.
// 본문에는 판단에 쓰는 숫자만 있고, 근거·가정 설명은 호버 패널에 있다(오너 지시 2026-10-06).
// 패널은 포커스로도 열린다 — 키보드 사용자가 근거에 닿는 경로이므로 테스트도 포커스로 연다.
// 트래커는 손으로 만들지 않고 순수 SSOT(`buildTaxableRevenueTracker`)로 만든다 — 손 픽스처는
// 계산과 표시가 어긋나도 초록이 된다.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

/** 호버 패널을 포커스로 연다(Radix HoverCard 는 trigger focus 에서 openDelay 뒤 연다). */
function openDetail(testId: string) {
  act(() => {
    screen.getByTestId(testId).focus();
  });
}

function renderCard(campaigns: TaxableRevenueCampaignInput[], now: Date = NOW) {
  render(<TaxableRevenueCard tracker={buildTaxableRevenueTracker(campaigns, now)} />);
  return screen.getByTestId("taxable-revenue-card");
}

describe("TaxableRevenueCard", () => {
  it("여유 충분 — 본문은 숫자만, 근거 문장은 호버 패널에 있다", async () => {
    const card = renderCard([campaign({ actualSales: 110_000_000 })]); // 공급 1억
    expect(within(card).getByText("3억까지 남은 공급가액")).toBeInTheDocument();
    const value = within(card).getByText("200,000,000");
    expect(value.parentElement?.className).toContain("text-foreground");
    // 스크린리더는 근거 버튼에서 실제 금액을 듣는다(aria-label 로 덮어쓰지 않는다)
    expect(within(card).getByTestId("taxable-revenue-primary")).toHaveAccessibleName(expect.stringContaining("200,000,000"));
    expect(card).toHaveTextContent("다음 갱신 2027.02.14");
    // 현재 등급은 CRM 추정이다 — 네이버 실제 등급처럼 읽히지 않게 「(추정)」을 남긴다
    expect(card).toHaveTextContent("현재(추정) 영세 1.947%");
    expect(card).not.toHaveTextContent("(가정)");
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
    expect(card).toHaveTextContent("누적 100,000,000원 / 3억");
    // 현재와 같은 등급이면 「예상」은 반복이라 싣지 않는다
    expect(card).not.toHaveTextContent("예상");
    // 네이버 자사몰 1.1억 × (2.563% − 1.947%) = 677,600원
    expect(within(card).getByText("넘으면 반년 추가 수수료")).toBeInTheDocument();
    expect(within(card).getByText("약 677,600원")).toBeInTheDocument();
    expect(within(card).getByText("영세 → 중소1")).toBeInTheDocument();
    expect(within(card).queryByRole("list", { name: "확인 필요" })).not.toBeInTheDocument();

    // 설명 문장은 본문에 없다 — 결론을 바꾸지 않는 VAT 가설·추정 고지·PG 주석
    for (const prose of [/VAT 포함/, /CRM 캠페인 기준 추정치/, /네이버페이 결제분만/, /직전 갱신/, /기준기간/]) {
      expect(within(card).queryByText(prose)).not.toBeInTheDocument();
    }

    openDetail("taxable-revenue-primary");
    expect(await screen.findByText("여유 190,000,000원")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();

    openDetail("taxable-revenue-basis");
    expect(await screen.findByText("CRM 캠페인 기준 추정치")).toBeInTheDocument();
    expect(screen.getByText("2026년 1기+2기")).toBeInTheDocument();
    expect(screen.getByText(/직전 갱신\(2026\.08\.14\) 기준기간의 CRM 누적으로 추정/)).toBeInTheDocument();

    openDetail("taxable-revenue-cost");
    expect(await screen.findByText("영세 1.947% → 중소1 2.563%")).toBeInTheDocument();
    expect(screen.getByText("110,000,000원")).toBeInTheDocument();
    expect(screen.getByText(/네이버페이 결제분만 반영/)).toBeInTheDocument();
  });

  it("근접 — 라벨에 「근접」을 싣고 주 숫자·막대가 주의색이 되며, VAT 포함 가설로는 이미 초과면 본문에 올린다", () => {
    const card = renderCard([campaign({ actualSales: 308_000_000 })]); // 공급 2.8억, 여유 2천만
    // 색만으로 전하지 않는다 — 라벨에 「근접」이 있다
    expect(within(card).getByText("3억 근접 · 남은 공급가액")).toBeInTheDocument();
    const value = within(card).getByText("20,000,000");
    expect(value.parentElement?.className).toContain("text-status-caution-text");
    expect(within(card).getByRole("progressbar").firstElementChild?.className).toContain("bg-status-caution");
    // 결론을 뒤집는 가설은 호버에 숨기지 않는다
    const warning = within(card).getByRole("list", { name: "판정 가설 주의" });
    expect(within(warning).getByText("VAT 포함 기준이면 8,000,000원 초과")).toBeInTheDocument();
  });

  it("공급가액 기준은 여유여도 VAT 포함 기준이 근접이면 본문에 올린다", () => {
    const card = renderCard([campaign({ actualSales: 286_000_000 })]); // 공급 2.6억, VAT 포함 여유 1,400만
    expect(within(card).getByText("3억까지 남은 공급가액")).toBeInTheDocument();
    const warning = within(card).getByRole("list", { name: "판정 가설 주의" });
    expect(within(warning).getByText("VAT 포함 기준이면 14,000,000원 남음 (근접)")).toBeInTheDocument();
  });

  it("터치 — 탭(touch pointerdown)으로도 근거 패널이 열린다", async () => {
    renderCard([campaign({ actualSales: 110_000_000 })]);
    // Radix HoverCard 는 터치 hover 를 무시하고 click 도 막는다 — 이 경로가 없으면 터치스크린 PC 에서 근거에 못 닿는다
    fireEvent.pointerDown(screen.getByTestId("taxable-revenue-cost"), { pointerType: "touch" });
    expect(await screen.findByText(/네이버페이 결제분만 반영/)).toBeInTheDocument();
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

  it("초과 — 「N 초과한 공급가액」으로 전환하고 예상 등급·다음 기준선·이미 넘은 비용을 보인다", () => {
    const card = renderCard([campaign({ actualSales: 352_000_000 })]); // 공급 3.2억
    expect(within(card).getByText("3억 초과한 공급가액")).toBeInTheDocument();
    // 초과 상태에서 스크린리더가 「남은 금액」이라고 읽지 않는다
    expect(within(card).getByTestId("taxable-revenue-primary")).toHaveAccessibleName(expect.stringContaining("초과 금액 근거"));
    const value = within(card).getByText("20,000,000");
    expect(value.parentElement?.className).toContain("text-status-urgent");
    expect(card).toHaveTextContent("예상 중소1");
    expect(card).toHaveTextContent("다음 기준선 5억까지 180,000,000원");
    expect(within(card).getByText("추정대로 갱신되면 반년 추가 수수료")).toBeInTheDocument();
    expect(within(card).getByText("영세 → 중소1")).toBeInTheDocument();
    // 이미 초과면 VAT 가설 경고는 새 정보가 아니다
    expect(within(card).queryByRole("list", { name: "판정 가설 주의" })).not.toBeInTheDocument();
    const bar = within(card).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "누적 320,000,000원, 기준선 3억 초과");
  });

  it("미지정·미입력 경고 — 분류 필요 건수, 미지정 범위(하한~상한), 미입력 건수를 보인다", async () => {
    const card = renderCard([
      campaign({ actualSales: 11_000_000 }),
      campaign({ salesChannel: "UNSPECIFIED", actualSales: 5_500_000, settlementSales: 1_100_000 }),
      campaign({ salesChannel: "SELLER_MALL", actualSales: 2_200_000, sellerExpense: null }),
    ]);
    const warnings = within(card).getByRole("list", { name: "확인 필요" });
    // 상태는 붙여 쓴 한 낱말 — 지시(「분류 필요」)는 낱말의 설명창으로 내려갔다.
    const unspecified = within(warnings).getByText("채널미지정 1건");
    expect(unspecified.closest("button")).not.toBeNull();
    expect(within(warnings).queryByText(/분류 필요/)).toBeNull();
    expect(within(warnings).getByText("금액 미입력 1건")).toBeInTheDocument();
    expect(within(card).getByText("1,000,000원 ~ 5,000,000원")).toBeInTheDocument();
    // 범위인 이유와 주 숫자가 상한으로 계산됐다는 사실은 범위의 근거 패널에 있다
    openDetail("taxable-revenue-unspecified");
    expect(await screen.findByText(/남은 금액은 상한\(보수적\)으로 계산합니다/)).toBeInTheDocument();
    expect(screen.getByText("상한 반영 시 누적")).toBeInTheDocument();
    // 보수적 여유 = 3억 − (1,100만 + 550만)/1.1
    expect(within(card).getByText("285,000,000")).toBeInTheDocument();
    // 「합계에서 빠졌다」는 설명은 근거 패널에 있다
    openDetail("taxable-revenue-basis");
    expect(await screen.findByText(/금액 미입력 건은 합계에서 빠져 있습니다/)).toBeInTheDocument();
  });

  it("진행·예정 캠페인의 빈 금액은 「금액 미입력」이 아니라 별도 무채색 줄로 보인다", () => {
    const card = renderCard([
      campaign({ actualSales: 11_000_000 }),
      campaign({ status: "ACTIVE", endDate: new Date("2026-10-20T12:00:00+09:00"), actualSales: null }),
    ]);
    const pending = within(card).getByRole("list", { name: "반영 대기" });
    expect(within(pending).getByText("진행·예정 1건 매출 미반영")).toBeInTheDocument();
    expect(within(card).queryByText(/금액 미입력/)).not.toBeInTheDocument();
    expect(within(card).queryByRole("list", { name: "확인 필요" })).not.toBeInTheDocument();
  });

  it("8월 갱신 창에서는 기준기간이 원문 미확인 가정임을 표시한다", async () => {
    const card = renderCard([], new Date("2027-03-01T12:00:00+09:00"));
    // 본문에는 짧은 표지, 무엇이 가정인지는 근거 패널에
    expect(card).toHaveTextContent("(가정)");
    openDetail("taxable-revenue-basis");
    expect(await screen.findByText(/8월 갱신 기준기간은 원문 미확인 가정입니다/)).toBeInTheDocument();
    expect(screen.getByText("2026년 2기 + 2027년 1기")).toBeInTheDocument();
  });
});
