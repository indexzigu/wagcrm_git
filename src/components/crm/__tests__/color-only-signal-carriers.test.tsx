// @vitest-environment jsdom
/**
 * 「색만으로 전달하지 않는다」(WCAG 1.4.1) 회귀 — interfaces 점검 묶음 F(2026-09-24).
 *
 * 보고서 #11·#12 의 표면들이 상태를 **색 하나로만** 말하고 있었다. 각 표면에 텍스트·모양
 * 캐리어를 얹었고, 여기서는 그 캐리어가 **실제 DOM 에** 나오는지를 본다(소스 그렙이 아니라
 * 렌더 결과). 색 자체는 각 표면의 기존 계약 테스트가 소유한다 — 여기선 색이 사라져도
 * 신호가 남는가만 본다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { CampaignCard } from "../campaign-card";
import { SettlementCompletedTable } from "../settlement-completed-table";
import { LinkDetailSheet } from "../inflow-report-client";
import { SystemRadarCard } from "../system-radar-card";
import { CalendarView, type CalendarCampaign } from "../calendar-view";
import { SellerGrowthChart } from "../seller-growth-chart";
import { campaignStatusLabels, type CampaignRow } from "@/lib/crm-types";
import type { InflowLinkRow } from "@/lib/inflow-report";
import { KNOWN_JOBS } from "@/lib/cron-jobs";

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    dealName: "딜",
    partnerName: "거래처",
    sellerName: "셀러",
    snsType: "INSTAGRAM",
    snsHandle: "@x",
    startDate: "2026-09-20",
    endDate: "2026-09-26",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 1,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "ACTIVE",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-09-25T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    checklistSummary: {
      status: "ACTIVE",
      checkedCount: 0,
      totalCount: 0,
      requiredCheckedCount: 0,
      requiredTotalCount: 0,
      nextItemLabel: null,
      isComplete: false,
    },
    ...overrides,
  } as CampaignRow;
}

const noop = () => {};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CampaignCard — 긴급도·할 일 배지가 색 말고 문구로도 말한다", () => {
  // ACTIVE 의 할 일 기한 = endDate(offset 0) = 09-26. 날짜만 가짜로 돌린다(findBy* 보존).
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

  function renderAt(iso: string) {
    vi.setSystemTime(new Date(iso));
    return render(
      <CampaignCard campaign={makeCampaign()} onOpen={noop} onDelete={noop} onDuplicate={noop} />,
    );
  }

  it("기한이 지나면 배지에 「지연」, 날짜 줄에 sr-only 「종료일 지남」", () => {
    renderAt("2026-09-27T03:00:00Z");
    expect(screen.getByText(/캠페인 마감일\s*09\.26\s*지연/)).toBeTruthy();
    expect(screen.getByText(/종료일 지남/).className).toContain("sr-only");
  });

  it("기한이 오늘이면 날짜 대신 「오늘」, 날짜 줄에 sr-only 「종료 임박」", () => {
    renderAt("2026-09-26T03:00:00Z");
    expect(screen.getByText(/캠페인 마감일\s*오늘/)).toBeTruthy();
    expect(screen.queryByText(/지연$/)).toBeNull();
    expect(screen.getByText(/종료 임박/).className).toContain("sr-only");
  });

  it("여유가 있으면 추가 문구가 없다(볼 것 없음 등급 — P8 §2)", () => {
    renderAt("2026-09-10T03:00:00Z");
    expect(screen.getByText(/캠페인 마감일\s*09\.26/).textContent).not.toMatch(/지연|오늘/);
    expect(screen.queryByText(/종료일 지남|종료 임박/)).toBeNull();
  });
});

describe("SettlementCompletedTable — 개인 셀러는 행 틴트가 아니라 「개인」 라벨", () => {
  const props = {
    reportCampaigns: [],
    onSelectCampaign: noop,
    selectedIds: [],
    onToggleRow: noop,
    onToggleAll: noop,
  };

  it("개인 셀러 행에만 라벨이 붙고, 어떤 행에도 amber 틴트가 없다", () => {
    const { container } = render(
      <SettlementCompletedTable
        {...props}
        campaigns={[
          makeCampaign({ id: "ind", sellerName: "개인셀러", sellerTaxType: "INDIVIDUAL", status: "COMPLETED" } as Partial<CampaignRow>),
          makeCampaign({ id: "biz", sellerName: "사업자셀러", sellerTaxType: "BUSINESS", status: "COMPLETED" } as Partial<CampaignRow>),
        ]}
      />,
    );
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(2);
    const [ind, biz] = rows as HTMLElement[];
    expect(within(ind).getByText("개인")).toBeTruthy();
    expect(within(biz).queryByText("개인")).toBeNull();
    for (const row of rows) expect(row.className).not.toMatch(/amber/);
  });
});

describe("LinkDetailSheet 시간대별 — 0 과 소량을 모양으로 가르고, 값을 텍스트 대안에 싣는다", () => {
  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    clicks: hour === 20 ? 12 : hour === 9 ? 1 : 0,
  }));

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              stats: {
                totalClicks: 13,
                visitDays: 1,
                botClicks: 0,
                byChannel: [],
                byDevice: [],
                bySub: [],
                byHour,
                byDay: [],
              },
            }),
            { status: 200 },
          ),
      ),
    );
  });

  it("aria-label 이 최다 시간대와 클릭 있는 시간대를 말하고, 0 칸은 채운 막대가 없다", async () => {
    render(
      <LinkDetailSheet
        link={{ code: "abc", shortUrl: "https://go.example/abc" } as InflowLinkRow}
        onOpenChange={noop}
      />,
    );
    const chart = await screen.findByRole("img", { name: /시간대별 클릭 분포/ });
    const label = chart.getAttribute("aria-label") ?? "";
    expect(label).toContain("가장 많은 시간대 20시 12회");
    expect(label).toContain("클릭이 있었던 시간대 2곳");
    expect(label).toContain("9시 1회");

    const columns = Array.from(chart.children) as HTMLElement[];
    expect(columns).toHaveLength(24);
    // 0 칸 = 1px 기준선 틱(인라인 높이 없음) · 1회 이상 = 최소 10% 높이 막대.
    const zero = columns[0].firstElementChild as HTMLElement;
    expect(zero.className).toContain("h-px");
    expect(zero.style.height).toBe("");
    const small = columns[9].firstElementChild as HTMLElement;
    expect(small.className).not.toContain("h-px");
    expect(parseFloat(small.style.height)).toBeGreaterThanOrEqual(10);
  });
});

describe("SystemRadarCard 작동 로그 — 실패는 글자로, 성공은 화면낭독기로", () => {
  const job = KNOWN_JOBS[0];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/api/system/task-log")
          ? {
              success: true,
              data: [
                { id: "l1", status: "SUCCESS", message: "완료 메시지", createdAt: new Date().toISOString() },
                { id: "l2", status: "ERROR", message: "타임아웃", createdAt: new Date().toISOString() },
                { id: "l3", status: "ERROR", message: "", createdAt: new Date().toISOString() },
              ],
            }
          : url.includes("/api/system/radar")
            ? { success: true, data: [], collectHealth: null }
            : {};
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  it("실패 행엔 보이는 「실패」, 성공 행엔 sr-only 「성공」", async () => {
    render(<SystemRadarCard />);
    fireEvent.click(await screen.findByText(job.name));
    const list = await screen.findByLabelText("작동 로그 목록");

    const failures = within(list).getAllByText("실패");
    expect(failures).toHaveLength(2);
    for (const f of failures) expect(f.className).not.toContain("sr-only");
    expect(within(list).getByText(/·\s*타임아웃/)).toBeTruthy();
    // 메시지 없는 실패는 「실패」 한 단어 — 종전 대체 문구 「오류 발생」과 겹쳐 말하지 않는다.
    expect(within(list).queryByText(/오류 발생/)).toBeNull();

    expect(within(list).getByText(/성공:/).className).toContain("sr-only");
    expect(within(list).getByText(/완료 메시지/)).toBeTruthy();
  });
});

describe("CalendarView 바 — 채움색 말고 상태명도 싣는다", () => {
  it("sr-only 상태명과 title 에 상태가 들어간다", () => {
    const { container } = render(
      <CalendarView
        month="2026-07"
        campaigns={[
          {
            id: "c1",
            dealName: "딜-c1",
            sellerName: "셀러",
            sellerId: "s1",
            startDate: "2026-07-01T00:00:00.000Z",
            endDate: "2026-07-05T00:00:00.000Z",
            status: "SETTLEMENT_IN_PROGRESS",
          } as CalendarCampaign,
        ]}
      />,
    );
    const label = campaignStatusLabels.SETTLEMENT_IN_PROGRESS;
    const bar = container.querySelector(`[title$=" (${label})"]`);
    expect(bar, "바 title 에 상태명이 없다").not.toBeNull();
    const sr = within(bar as HTMLElement).getByText(new RegExp(`^${label}:`));
    expect(sr.className).toContain("sr-only");
  });
});

describe("SellerGrowthChart 범례 — 실선=팔로워 · 점선=게시물", () => {
  const days = ["2026-09-01", "2026-09-08", "2026-09-15"];

  it("게시물 이력이 있으면 두 항목, 게시물 선 표식은 점선이다", () => {
    render(
      <SellerGrowthChart
        data={days.map((date, i) => ({ date, followers: 100 + i * 10, posts: 10 + i }))}
      />,
    );
    const legend = screen.getByRole("list", { name: "차트 범례" });
    const items = within(legend).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["팔로워", "게시물"]);
    expect(items[0].querySelector("line")?.getAttribute("stroke-dasharray")).toBeNull();
    expect(items[1].querySelector("line")?.getAttribute("stroke-dasharray")).toBe("4 3");
  });

  it("게시물 이력이 없으면 없는 선을 가리키지 않는다", () => {
    render(<SellerGrowthChart data={days.map((date, i) => ({ date, followers: 100 + i * 10 }))} />);
    const legend = screen.getByRole("list", { name: "차트 범례" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["팔로워"]);
  });
});

// 손익 「수익 구성」 막대는 렌더에 리포트 전체 픽스처가 필요해 소스 계약으로 고정한다.
// ⚠️ 주석을 걷어낸 뒤 판정한다 — 교체 근거 주석이 옛 토큰 이름을 인용하고 있어, 그대로 세면
// 자기 설명을 위반으로 잡는다(레포 실사고 유형).
describe("손익 리포트 수익 구성 막대 — 범주는 심각도·골드를 받지 않는다(가드레일 3 · P8 §4)", () => {
  const source = readFileSync(join(process.cwd(), "src/components/crm/pnl-report-client.tsx"), "utf8");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const start = stripped.indexOf("<CategoryBar");
  const end = stripped.indexOf("/>", stripped.indexOf("segments={[", start));

  it("앵커가 살아 있다(공허 통과 방지)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("세그먼트에 --status-* · --accent-gold 가 없고, 순이익은 PROFIT_TONE_FILL 을 탄다", () => {
    const bar = stripped.slice(start, end);
    expect(bar).not.toMatch(/--status-|--accent-gold/);
    expect(bar).toMatch(/label: "순이익\(세후\)"[^}]*color: afterTaxProfitFill/);
    expect(stripped).toMatch(/afterTaxProfitFill\s*=\s*PROFIT_TONE_FILL\[/);
    // 같은 초점 값을 그리는 순이익률 링도 같은 판정을 쓴다(기본값 골드로 떨어지지 않게).
    expect(stripped).toMatch(/<ProgressCircle\s+color=\{afterTaxProfitFill\}/);
  });
});
