// @vitest-environment jsdom
/**
 * 진행 막대의 빈 구간(트랙)이 보이는가 — 과세기준매출 카드·홈 퍼널(#133)과 같은 처리를 나머지 막대에 맞춘 회귀.
 *
 * 트랙이 slate-100 이면 흰 표면 대비 1.10:1 로 사라져 「전체 중 얼마인가」가 안 읽힌다 → slate-300.
 * 트랙을 진하게 하면 채움이 그 위에서 3:1(WCAG 1.4.11)을 잃을 수 있어, 채움도 함께 고정한다:
 * slate-500 3.21 · 네이비(bg-primary) 7.62 · emerald-700 3.62 · amber-700 3.40 · rose-700 4.08.
 * ⚠️ 하위(펼침) 막대의 종전 채움 slate-300 은 새 트랙과 **같은 색**이라 막대가 통째로 사라진다 — 되돌리지 말 것.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { LinkDetailSheet } from "../inflow-report-client";
import { ReferralNetworkDialog } from "../referral-network-dialog";
import { DealVocSection } from "../deal-voc-section";
import { CategoryProfile } from "../seller-analysis/CategoryProfile";
import type { InflowLinkRow } from "@/lib/inflow-report";
import type { SellerSummary } from "@/lib/crm-types";

const noop = () => {};

function expectVisibleTrack(track: Element, fillClass: string) {
  // 부분 문자열이 아니라 클래스 토큰으로 본다 — `bg-primary/10` 같은 투명 변형이 `bg-primary` 로 통과하지 않게.
  expect(track.classList.contains("bg-slate-300")).toBe(true);
  expect(track.className).not.toMatch(/bg-slate-100|bg-muted\b/);
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
