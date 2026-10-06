// @vitest-environment jsdom
/**
 * 진행 막대의 빈 구간(트랙)이 보이는가 — 과세기준매출 카드·홈 퍼널(#133)과 같은 처리를 나머지 막대에 맞춘 회귀.
 *
 * 트랙이 slate-100 이면 흰 표면 대비 1.10:1 로 사라져 「전체 중 얼마인가」가 안 읽힌다 → slate-300.
 * 트랙을 진하게 하면 채움이 그 위에서 3:1(WCAG 1.4.11)을 잃을 수 있어, 채움도 함께 고정한다:
 * slate-500 3.21 · 네이비(bg-primary) 7.62 · emerald-700 3.62 · amber-700 3.40 · rose-700 4.08.
 * ⚠️ 하위(펼침) 막대의 종전 채움 slate-300 은 새 트랙과 **같은 색**이라 막대가 통째로 사라진다 — 되돌리지 말 것.
 * 3차: 범주 비중 막대(포털 구성별 판매·매출 보고 판매 비중·인사이트 유입 경로)와 스토리지 게이지는 중립 네이비
 * (bg-primary 7.62 — 오너 결정 2026-10-06, 종전 blue/indigo 는 P8 §4 위반·hue 부채). 발주 메일 진행은 blue-600(3.54),
 * 완료(100%)는 트랙이 안 보여 흰 배경 대비로 보고 「완료」 라벨과 같은 bg-status-success(흰 배경 5.48)로 맞춘다.
 * 의도적 유지: CommentIntent 구성 막대(합이 100% 인 구성비라 남은 구간이 아니다) · 모바일 상태 분포(#133).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { LinkDetailSheet } from "../inflow-report-client";
import { ReferralNetworkDialog } from "../referral-network-dialog";
import { DealVocSection } from "../deal-voc-section";
import { CategoryProfile } from "../seller-analysis/CategoryProfile";
import { ScoreCard } from "../seller-analysis/ScoreCard";
import { CampaignCard } from "../campaign-card";
import { IntegrationsDiagnostic } from "../integrations-diagnostic";
import SalesReportModal from "../shipping/modals/SalesReportModal";
import CampaignInsightsModal from "../shipping/modals/CampaignInsightsModal";
import EmailSendModal from "../shipping/modals/EmailSendModal";
import type { InflowLinkRow } from "@/lib/inflow-report";
import type { CampaignRow, SellerSummary } from "@/lib/crm-types";
import type { SellerScores } from "@/lib/seller-analysis/scores";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const noop = () => {};

function expectVisibleTrack(track: Element, fillClass: string) {
  // 부분 문자열이 아니라 클래스 토큰으로 본다 — `bg-primary/10` 같은 투명 변형이 `bg-primary` 로 통과하지 않게.
  expect(track.classList.contains("bg-slate-300")).toBe(true);
  expect(track.className).not.toMatch(/bg-slate-100|bg-slate-200|bg-muted\b/);
  const fill = track.firstElementChild as HTMLElement;
  expect(fill.classList.contains(fillClass)).toBe(true);
}

function stubFetch(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LinkDetailSheet — 유입 경로·기기 막대와 펼친 하위 막대", () => {
  beforeEach(() => {
    stubFetch({
      stats: {
        totalClicks: 10,
        visitDays: 1,
        botClicks: 0,
        byChannel: [{ key: "instagram", clicks: 10, byDay: [{ date: "2026-09-01", clicks: 10 }] }],
        byDevice: [{ key: "mobile", clicks: 10 }],
        bySub: [],
        byHour: [],
        byDay: [{ date: "2026-09-01", clicks: 10, uniqueVisitors: 8, byHour: [{ hour: 21, clicks: 10 }] }],
      },
    });
  });

  it("상위 막대 = slate-300 트랙 + slate-500 채움, 펼친 일자·시간대 막대도 같다", async () => {
    render(<LinkDetailSheet link={{ code: "abc", shortUrl: "https://go.example/abc" } as InflowLinkRow} onOpenChange={noop} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("유입 경로");

    const topTracks = [...dialog.querySelectorAll("span.h-2.rounded-full")];
    expect(topTracks).toHaveLength(2); // 유입 경로 1행 + 기기 1행
    for (const track of topTracks) expectVisibleTrack(track, "bg-slate-500");

    fireEvent.click(within(dialog).getByRole("button", { name: /인스타그램/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /2026-09-01/ }));
    const subTracks = [...dialog.querySelectorAll("span.h-1\\.5.rounded-full")];
    expect(subTracks).toHaveLength(2); // 경로의 일자 1행 + 일자의 시간대 1행
    for (const track of subTracks) {
      expectVisibleTrack(track, "bg-slate-500");
      expect((track.firstElementChild as HTMLElement).className).not.toContain("bg-slate-300");
    }
  });
});

describe("ReferralNetworkDialog — 유입 경로 분포", () => {
  // 유입 경로는 범주라 상태 hue 를 받지 않는다(P8 §4) — 소개만 브랜드 네이비(bg-primary, 트랙 대비 7.62)로 띄운다.
  // 종전 emerald 는 「들어온 돈」 색과 겹쳐 오너 결정으로 바꿨다(2026-10-06).
  it("소개는 네이비(bg-primary), 그 외는 slate-500 채움을 slate-300 트랙 위에 그린다", () => {
    const sellers = [
      { id: "a", name: "가", acquisitionChannel: "REFERRAL", campaigns: [] },
      { id: "b", name: "나", acquisitionChannel: "COLD", campaigns: [] },
    ] as unknown as SellerSummary[];
    render(<ReferralNetworkDialog open onOpenChange={noop} sellers={sellers} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelectorAll("div.h-1\\.5.rounded-full")).toHaveLength(2);
    // 행 라벨로 막대를 찾아 「소개 = 네이비」를 순서와 무관하게 고정한다.
    const trackOf = (label: string) =>
      within(dialog).getByText(label).parentElement!.nextElementSibling as HTMLElement;
    expectVisibleTrack(trackOf("소개"), "bg-primary");
    expectVisibleTrack(trackOf("콜드"), "bg-slate-500");
    const referralFill = (trackOf("소개").firstElementChild as HTMLElement).className;
    expect(referralFill).not.toMatch(/emerald|bg-slate-500/);
  });
});

describe("DealVocSection — 리뷰 평점 분포", () => {
  it("5점~1점 막대가 slate-300 트랙 + slate-500 채움이다", async () => {
    stubFetch({
      qnas: [],
      unansweredQnaCount: 0,
      reviewSummaries: [{ channel: "NAVER", reviewCount: 3, avgRating: 4.7, photoCount: 0, ratingCounts: { "5": 2, "4": 1 } }],
      reviewSource: { needsLink: false },
      insight: { payload: null, generatedAt: null, lastError: null, totalVoc: 3, minInitial: 5 },
    });
    render(<DealVocSection dealId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: /원문 전체 보기/ }));
    const star5 = await screen.findByText("5점");
    const rows = star5.closest("div.space-y-1") as HTMLElement;
    const tracks = [...rows.querySelectorAll("div.h-1\\.5.rounded-full")];
    expect(tracks).toHaveLength(5);
    for (const track of tracks) expectVisibleTrack(track, "bg-slate-500");
  });
});

describe("CategoryProfile — 카테고리 적합도", () => {
  it("점수 구간 채움(700 단계)이 slate-300 트랙 위에 그려진다", () => {
    render(
      <CategoryProfile
        affinities={[
          { category: "뷰티", score: 80, isPrimary: true, matchedTerms: [] },
          { category: "리빙", score: 50, isPrimary: false, matchedTerms: [] },
          { category: "식품", score: 10, isPrimary: false, matchedTerms: [] },
        ]}
      />,
    );
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(3);
    const expected = ["bg-emerald-700", "bg-amber-700", "bg-rose-700"];
    bars.forEach((bar, i) => expectVisibleTrack(bar, expected[i]));
  });
});

describe("ScoreCard — 서브점수 막대(3차)", () => {
  it("점수 구간 채움(700 단계)이 slate-300 트랙 위에 그려지고, 점수 0 도 트랙이 보인다", () => {
    const sub = (score: number | null) => ({ score, statusLabel: score === null ? "데이터 없음" : null, reasons: [] });
    const scores: SellerScores = {
      activity: sub(80),
      engagementQuality: sub(50),
      audienceQuality: sub(10),
      gonguConsistency: sub(null),
      consistency: sub(0),
      composite: 50,
      confidence: "medium",
      confidenceReasons: [],
    };
    const { container } = render(<ScoreCard scores={scores} />);
    const tracks = [...container.querySelectorAll("div.h-1\\.5.rounded-full")];
    expect(tracks).toHaveLength(4); // null 서브점수는 막대 대신 문구
    const expected = ["bg-emerald-700", "bg-amber-700", "bg-rose-700", "bg-rose-700"];
    tracks.forEach((t, i) => expectVisibleTrack(t, expected[i]));
  });
});

describe("CampaignCard — 필수 체크 진행 막대(3차)", () => {
  it("slate-50 박스 위 트랙이 slate-200 이 아니라 slate-300 이고 채움은 slate-900", () => {
    const campaign = {
      id: "c1",
      dealName: "딜",
      sellerName: "셀러",
      snsType: "INSTAGRAM",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      salesChannel: "OWN_MALL",
      actualSales: 1,
      status: "ACTIVE",
      assignedTo: null,
      updatedAt: "2026-01-01T00:00:00Z",
      checklistSummary: {
        status: "ACTIVE",
        checkedCount: 1,
        totalCount: 2,
        requiredCheckedCount: 1,
        requiredTotalCount: 2,
        nextItemLabel: null,
        isComplete: false,
      },
    } as unknown as CampaignRow;
    const { container } = render(<CampaignCard campaign={campaign} onOpen={noop} onDelete={noop} onDuplicate={noop} />);
    const tracks = [...container.querySelectorAll("div.h-1.rounded-full.overflow-hidden")];
    expect(tracks).toHaveLength(1);
    expectVisibleTrack(tracks[0], "bg-slate-900");
  });
});

describe("IntegrationsDiagnostic — 스토리지 한도 게이지(3차)", () => {
  it("트랙 slate-300 + 채움 네이비(bg-primary), 트랙보다 연한 테두리는 없다", () => {
    const status = { connected: true, status: "CONNECTED" as const, accountEmail: null, lastError: null };
    const { container } = render(
      <IntegrationsDiagnostic
        initialDriveStatus={status}
        initialCalendarStatus={status}
        supabaseStats={{ supabaseEstimatedBytes: 300, supabaseLimitBytes: 1000 }}
      />,
    );
    const fill = container.querySelector("div.bg-primary.origin-left") as HTMLElement;
    const track = fill.parentElement as HTMLElement;
    expectVisibleTrack(track, "bg-primary");
    expect(fill.className).not.toMatch(/indigo/);
    expect(track.className).not.toMatch(/\bborder\b/);
  });
});

describe("주문 관리 모달 — 비중 막대(3차)", () => {
  it("매출 보고: 전체 누적·일자별 표의 판매 비중 막대가 slate-300 트랙 + 네이비 채움", async () => {
    const campaign = {
      id: "c1",
      name: "캠페인",
      template: "",
      sellerName: "셀러",
      tasks: [],
      dailyStats: [
        {
          date: "2026-10-01",
          orders: 2,
          quantity: 2,
          revenue: 2000,
          options: [
            { name: "A", price: 1000, orders: 1, quantity: 1, revenue: 1000, ratio: 50 },
            { name: "B", price: 1000, orders: 1, quantity: 1, revenue: 1000, ratio: 50 },
          ],
        },
      ],
    } as never;
    render(<SalesReportModal campaign={campaign} onClose={noop} onToast={noop} />);
    const dialog = await screen.findByRole("dialog");
    const tracks = [...dialog.querySelectorAll("div.w-16.h-1\\.5.rounded-full")];
    expect(tracks).toHaveLength(4); // 전체 누적 2행 + 일자별 2행
    for (const t of tracks) {
      expectVisibleTrack(t, "bg-primary");
      expect((t.firstElementChild as HTMLElement).className).not.toMatch(/blue/);
    }
  });

  it("캠페인 인사이트: 유입 경로 비중 막대가 slate-300 트랙 + 네이비 채움", async () => {
    const campaign = {
      id: "c1",
      name: "캠페인",
      template: "",
      sellerName: "셀러",
      tasks: [],
      distinctOrderCount: 1, // 0 이면 표 대신 「유효 주문 없음」이 그려진다
      insights: {
        inflow: [{ path: "경로", orders: 1, quantity: 1, revenue: 1000, orderRatio: 100 }],
        hourly: [{ hour: 0, orders: 1, revenue: 1000 }],
        device: { mobile: 1, pc: 0, unknown: 0 },
        paymentMeans: [],
        membership: { orders: 0, ratio: 0 },
        buyers: { unique: 1, repeat: 0, repeatRatio: 0 },
        claims: { canceled: 0, returned: 0, exchanged: 0, total: 0, ratio: 0 },
      },
    } as never;
    render(<CampaignInsightsModal campaign={campaign} onClose={noop} />);
    const dialog = await screen.findByRole("dialog");
    const tracks = [...dialog.querySelectorAll("div.w-20.h-1\\.5.rounded-full")];
    expect(tracks).toHaveLength(1);
    expectVisibleTrack(tracks[0], "bg-primary");
    expect((tracks[0].firstElementChild as HTMLElement).className).not.toMatch(/indigo/);
  });

  it("발주 메일: 대기(0%) 상태에서 트랙 slate-300 이 보이고 진행 채움은 blue-600", async () => {
    render(<EmailSendModal campaignId="c1" onClose={noop} onSuccess={noop} addToast={noop} />);
    const dialog = await screen.findByRole("dialog");
    const fill = dialog.querySelector("div.origin-left.absolute") as HTMLElement;
    expectVisibleTrack(fill.parentElement as HTMLElement, "bg-blue-600");
  });
});

// 합성 props 로 도달하기 어려운 상태(발주 메일 완료·지연 안내 진행 중)와 async 서버 컴포넌트(셀러 포털)는
// 소스의 클래스 문자열로 고정한다. 주석은 걷어내고 본다 — 설명 주석의 옛 클래스명이 위반으로 잡히지 않게.
function sourceOf(rel: string): string {
  const raw = readFileSync(join(__dirname, "..", "..", rel), "utf8");
  return raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("도달 어려운 막대 — 소스 고정(3차)", () => {
  it("발주 메일 완료 채움은 「완료」 라벨과 같은 bg-status-success(흰 배경 5.48), 진행은 blue-600", () => {
    const src = sourceOf("crm/shipping/modals/EmailSendModal.tsx");
    expect(src).toContain("step === 'SUCCESS' ? 'bg-status-success' : 'bg-blue-600'");
    expect(src).toContain("step === 'SUCCESS' ? 'text-status-success' : ''");
    expect(src).toContain('className="relative h-2 w-full bg-slate-300 rounded-full overflow-hidden"');
    expect(src).not.toMatch(/bg-green-\d|bg-blue-500/);
  });

  it("지연 안내 진행 막대 트랙은 slate-300", () => {
    const src = sourceOf("crm/shipping/modals/DelayDispatchModal.tsx");
    expect(src).toContain('className="relative h-2 w-full bg-slate-300 rounded-full overflow-hidden"');
    expect(src).not.toContain("h-2 w-full bg-slate-100 rounded-full");
  });

  it("셀러 포털 구성별 판매 막대는 slate-300 트랙 + 네이비 채움(색만, 데이터 무변경)", () => {
    const src = sourceOf("portal/seller-portal-report.tsx");
    expect(src).toContain('<div className="mt-1 h-1.5 bg-slate-300 rounded-full overflow-hidden">');
    expect(src).toContain('<div className="h-full bg-primary rounded-full" style={{ width: `${o.ratio}%` }}></div>');
    expect(src).not.toContain("h-1.5 bg-slate-100 rounded-full");
  });
});

// P8 §6: 새로 쓰는 색 유틸이 @theme 에 노출돼 있어야 클래스가 조용히 죽지 않는다(렌더 도달은 실캡처로 확인).
describe("@theme 노출 — 3차에서 새로 쓰는 채움 토큰", () => {
  it("--color-status-success · --color-primary 가 @theme inline 에 있다", () => {
    const css = readFileSync(join(__dirname, "..", "..", "..", "app", "globals.css"), "utf8");
    // 블록 끝은 0열의 닫는 중괄호로 자른다 — 블록 안에 중괄호가 생겨도 조기 절단되지 않게.
    const start = css.indexOf("@theme inline");
    const theme = css.slice(start, css.indexOf("\n}", start));
    expect(theme).toMatch(/--color-status-success:\s*var\(--status-success\)/);
    expect(theme).toMatch(/--color-primary:\s*var\(--primary\)/);
    // 4차: 시간대 차트의 bg-chart-1/NN 알파 유틸
    expect(theme).toMatch(/--color-chart-1:\s*var\(--chart-1\)/);
  });
});

// 4차: 같은 화면의 단일 계열 차트(시간대별 주문)가 네이비 범주 막대를 앞지르지 않게 — 차트 네이비 60% 단색
// (흰 표면 3.59, 종전 blue-400 2.64 미달). 0건 시간대는 2px slate-100 기준선 그대로.
describe("시간대 차트·인사이트 패널 틀(4차)", () => {
  it("캠페인 인사이트: 시간대 막대 chart-1/60(hover 100%), 0건은 slate-100, 유입 경로 틀은 무채색", async () => {
    const campaign = {
      id: "c1",
      name: "캠페인",
      template: "",
      sellerName: "셀러",
      tasks: [],
      distinctOrderCount: 1,
      insights: {
        inflow: [{ path: "경로", orders: 1, quantity: 1, revenue: 1000, orderRatio: 100 }],
        hourly: [
          { hour: 0, orders: 0, revenue: 0 },
          { hour: 1, orders: 1, revenue: 1000 },
        ],
        device: { mobile: 1, pc: 0, unknown: 0 },
        paymentMeans: [],
        membership: { orders: 0, ratio: 0 },
        buyers: { unique: 1, repeat: 0, repeatRatio: 0 },
        claims: { canceled: 0, returned: 0, exchanged: 0, total: 0, ratio: 0 },
      },
    } as never;
    render(<CampaignInsightsModal campaign={campaign} onClose={noop} />);
    const dialog = await screen.findByRole("dialog");
    const bars = [...dialog.querySelectorAll("div.w-full.rounded-t")];
    expect(bars).toHaveLength(2);
    expect(bars[0].classList.contains("bg-slate-100")).toBe(true);
    expect(bars[1].classList.contains("bg-chart-1/60")).toBe(true);
    expect(bars[1].classList.contains("group-hover:bg-chart-1")).toBe(true);
    // 범주(유입 경로) 막대는 100% 네이비 — 시간대 막대보다 진하다.
    const inflowFill = dialog.querySelector("div.w-20.h-1\\.5.rounded-full")!.firstElementChild as HTMLElement;
    expect(inflowFill.classList.contains("bg-primary")).toBe(true);

    const title = within(dialog).getByText("유입 경로별 주문");
    expect(title.className).toContain("text-slate-700");
    const header = title.parentElement as HTMLElement;
    expect(header.className).toContain("bg-slate-50");
    const panel = header.parentElement as HTMLElement;
    expect(panel.className).toContain("border-slate-200");
    expect(dialog.innerHTML).not.toMatch(/indigo|blue-/);
  });

  it("셀러 포털: 시간대 막대 chart-1/60 + 0건 slate-100, 일자별 매출 배경 바 chart-1/10(색만)", () => {
    const src = sourceOf("portal/seller-portal-report.tsx");
    expect(src).toContain('className={`w-full rounded-t ${h.orders > 0 ? "bg-chart-1/60" : "bg-slate-100"}`}');
    expect(src).toContain('className="absolute inset-y-0.5 right-0 bg-chart-1/10 rounded-l-sm"');
    expect(src).not.toMatch(/bg-blue-400|bg-blue-500\/10/);
  });
});

// 5차: 상태 의미가 없는 파랑·보라 잔존을 5개 의미축 밖 무채색(또는 §4 네이비 태그 캐리어)으로.
describe("남은 파랑·보라(5차)", () => {
  it("셀러 포털: 오늘 매출은 무채색, 오픈 카운트다운은 네이비 틴트, 단골 수는 slate-900 — 마감 배지 amber 는 유지", () => {
    const src = sourceOf("portal/seller-portal-report.tsx");
    expect(src).toContain('<div className="text-[11px] font-bold text-slate-500 uppercase">오늘 매출</div>');
    expect(src).toContain('<div className="text-xl font-bold text-slate-900">{fmtWon(todayStat?.revenue || 0)}</div>');
    expect(src).toContain('className: "bg-primary/10 text-primary border-primary/20", icon: "clock", mode: "open"');
    expect(src).toContain('<div className="text-xl font-bold text-slate-900">{crossCampaignBuyers.toLocaleString()}명</div>');
    // 마감 임박은 심각도 축(caution) — 그대로 amber.
    expect(src).toContain('className: "bg-amber-50 text-amber-700 border-amber-200", icon: "clock", mode: "close"');
    // 「성과 카드 →」 링크의 text-blue-600 은 상호작용 색이라 범위 밖 — 여기서 잡지 않는다.
    expect(src).not.toMatch(/text-indigo-|bg-blue-50 text-blue-600|text-xl font-bold text-blue-600|text-\[11px\] font-bold text-blue-600/);
  });

  it("매출 보고 제목 아이콘은 형제 모달과 같은 slate-500", async () => {
    const campaign = { id: "c1", name: "캠페인", template: "", sellerName: "셀러", tasks: [], dailyStats: [] } as never;
    render(<SalesReportModal campaign={campaign} onClose={noop} onToast={noop} />);
    const dialog = await screen.findByRole("dialog");
    const icon = dialog.querySelector("svg") as SVGElement;
    expect(icon.getAttribute("class")).toContain("text-slate-500");
    expect(icon.getAttribute("class")).not.toMatch(/blue|indigo/);
  });

  it("캠페인 생성 창의 카테고리·판매기간 이름표 칩은 같은 회색 칩", () => {
    const src = sourceOf("crm/shipping/modals/CampaignCreateModal.tsx");
    const chip = '<span className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-600 font-bold">';
    expect(src).toContain(`${chip}카테고리</span>`);
    expect(src).toContain(`${chip}판매기간</span>`);
    expect(src).not.toMatch(/bg-indigo-100|text-indigo-600/);
  });
});
