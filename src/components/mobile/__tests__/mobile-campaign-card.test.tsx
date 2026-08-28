// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MobileCampaignCard } from "../mobile-campaign-card";
import type { CampaignRow } from "@/lib/crm-types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    dealName: "글로우 앰플 4차",
    partnerName: "코링코",
    sellerName: "미나",
    snsType: "INSTAGRAM",
    snsHandle: "@mina_beauty",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: null,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "ACTIVE",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-01-01T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    ...overrides,
  } as CampaignRow;
}

const noop = () => {};

describe("MobileCampaignCard — 최저가 위반 배지 (UX1-C)", () => {
  it("hasPriceViolation=true면 위반 배지를 렌더링한다", () => {
    render(
      <MobileCampaignCard
        campaign={makeCampaign({ hasPriceViolation: true, violatedDealCount: 2 })}
        onOpen={noop}
      />,
    );
    expect(screen.getByText("최저가 위반")).toBeInTheDocument();
  });

  it("위반 딜 개수를 hover 안내(title)로 노출한다", () => {
    render(
      <MobileCampaignCard
        campaign={makeCampaign({ hasPriceViolation: true, violatedDealCount: 4 })}
        onOpen={noop}
      />,
    );
    const badge = screen.getByText("최저가 위반");
    expect(badge.closest("[title]")).toHaveAttribute("title", expect.stringContaining("4"));
  });

  it("hasPriceViolation=false면 위반 배지를 렌더링하지 않는다", () => {
    render(
      <MobileCampaignCard
        campaign={makeCampaign({ hasPriceViolation: false, violatedDealCount: 0 })}
        onOpen={noop}
      />,
    );
    expect(screen.queryByText("최저가 위반")).not.toBeInTheDocument();
  });

  it("hasPriceViolation 필드 자체가 없는(스냅샷 無) 기존 캠페인은 배지가 없다 (기본 상태와 동일)", () => {
    render(<MobileCampaignCard campaign={makeCampaign()} onOpen={noop} />);
    expect(screen.queryByText("최저가 위반")).not.toBeInTheDocument();
  });

  it("groupMemberCount가 2 이상이면 N개 딜 배지를 렌더하고 마진(개별 멤버 값)은 숨긴다", () => {
    render(
      <MobileCampaignCard campaign={makeCampaign()} groupMemberCount={3} onOpen={noop} />,
    );
    expect(screen.getByText("3개 딜")).toBeInTheDocument();
    expect(screen.queryByText(/마진/)).not.toBeInTheDocument();
  });

  it("groupMemberCount가 없으면(개별 카드) 배지가 없고 마진은 그대로 보인다", () => {
    render(<MobileCampaignCard campaign={makeCampaign()} onOpen={noop} />);
    expect(screen.queryByText(/개 딜/)).not.toBeInTheDocument();
    // 적자만 색을 얹기 위해 값이 별도 span 으로 분리됐다(라벨은 색 없음) — testing-library 의
    // 기본 매처는 직속 텍스트 노드만 이어붙이므로 "마진 20%" 한 덩어리로는 안 잡힌다.
    // 표시 여부라는 원래 의도는 라벨+값을 각각 확인해 그대로 지킨다.
    expect(screen.getByText(/마진/)).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
  });

  it("링크 복사·외부 열기 버튼은 링크 유무와 무관하게 렌더되지 않는다(2026-07-08 소유자 제거 확정)", () => {
    render(
      <MobileCampaignCard
        campaign={makeCampaign({ generatedTrackingLink: "https://track.wag.kr/abc" })}
        onOpen={noop}
      />,
    );
    expect(screen.queryByText("링크 복사")).not.toBeInTheDocument();
    expect(screen.queryByText("외부 열기")).not.toBeInTheDocument();
    expect(screen.queryByText(/트래킹 링크 미확정/)).not.toBeInTheDocument();
  });
});

/**
 * 적자 표시 — 색 배치 시안 착수 2 (오너 승인 2026-07-15).
 * 마진이 판단 지점인데 음수여도 회색이었다. 카드가 목록으로 수십 장 쌓이고 마진 글씨가
 * 11px 이라 숫자 색 하나로는 실외에서 안 읽힌다(P3) — 배지와 숫자 색 2중 캐리어로 간다.
 */
describe("MobileCampaignCard — 적자 표시", () => {
  it("마진이 음수면 적자 배지 + 숫자에 status-urgent 색(배지와 같은 hex)", () => {
    render(<MobileCampaignCard campaign={makeCampaign({ netMarginRate: -12.4 })} onOpen={noop} />);
    expect(screen.getByText("적자")).toBeInTheDocument();
    expect(screen.getByText("-12.4%")).toHaveClass("text-status-urgent-text");
  });

  it("흑자는 배지도 색도 없다 — 다 칠하면 적자가 안 튄다", () => {
    render(<MobileCampaignCard campaign={makeCampaign({ netMarginRate: 20 })} onOpen={noop} />);
    expect(screen.queryByText("적자")).not.toBeInTheDocument();
    expect(screen.getByText("20%")).not.toHaveClass("text-status-urgent-text");
  });

  it("마진 0%는 적자가 아니다(경계)", () => {
    render(<MobileCampaignCard campaign={makeCampaign({ netMarginRate: 0 })} onOpen={noop} />);
    expect(screen.queryByText("적자")).not.toBeInTheDocument();
  });

  it("그룹 카드는 마진을 숨기므로 적자 배지도 숨긴다 — 첫 멤버 값이라 근거가 없다", () => {
    render(
      <MobileCampaignCard
        campaign={makeCampaign({ netMarginRate: -12.4 })}
        groupMemberCount={3}
        onOpen={noop}
      />,
    );
    expect(screen.queryByText(/마진/)).not.toBeInTheDocument();
    expect(screen.queryByText("적자")).not.toBeInTheDocument();
  });

  it("정산 변형도 마진을 숨기므로 적자 배지를 숨긴다", () => {
    render(
      <MobileCampaignCard
        campaign={makeCampaign({ netMarginRate: -12.4 })}
        variant="settlement"
        onOpen={noop}
      />,
    );
    expect(screen.queryByText("적자")).not.toBeInTheDocument();
  });

  it("실매출은 손대지 않는다 — 모든 카드가 가지므로 색을 줘도 변별력이 0", () => {
    render(
      <MobileCampaignCard
        campaign={makeCampaign({ actualSales: 4820000, netMarginRate: -12.4 })}
        onOpen={noop}
      />,
    );
    expect(screen.getByText("₩4,820,000")).toHaveClass("text-slate-700");
  });

  it("실매출 null 은 ₩ 프리픽스 없이 '금액 미정'으로 렌더한다 — '₩-' 방지", () => {
    render(<MobileCampaignCard campaign={makeCampaign({ actualSales: null })} onOpen={noop} />);
    expect(screen.getByText("금액 미정")).toBeInTheDocument();
    expect(screen.queryByText("₩-")).not.toBeInTheDocument();
  });
});

describe("MobileCampaignCard — 위험색 단일화", () => {
  it("최저가 위반 배지는 리터럴 red 가 아니라 status-urgent 토큰을 쓴다", () => {
    // 같은 카드의 지연 배지(toneVariant→status-urgent)와 같은 "위험" 의미인데
    // 리터럴 red-600 을 써서 빨강 두 개가 공존했다.
    render(
      <MobileCampaignCard
        campaign={makeCampaign({ hasPriceViolation: true, violatedDealCount: 2 })}
        onOpen={noop}
      />,
    );
    const badge = screen.getByText("최저가 위반");
    expect(badge).toHaveClass("text-status-urgent-text");
    expect(badge.className).not.toMatch(/text-red-|bg-red-/);
  });
});
