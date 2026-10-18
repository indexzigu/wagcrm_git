// @vitest-environment jsdom
/**
 * 셀러 표 「거래 리듬」 휴면 배지 = 「휴면」 보기와 같은 판정(`isDormantForReview`, 2026-10-18 결정).
 * 마지막 진행이 오래돼 티어가 휴면이어도 시작예정 캠페인이 잡혀 있으면 배지도, 보기도 없다.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SellerSummary } from "@/lib/crm-types";
import { filterSellersBySegment } from "@/lib/seller-segment";
import { buildSellerColumns } from "../sellers-management";

const NOW = new Date("2026-10-18T03:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function seller(id: string, over: Partial<SellerSummary> = {}): SellerSummary {
  return {
    id,
    name: id,
    snsType: "INSTAGRAM",
    snsHandle: id,
    currentFollowers: 0,
    campaignCount: 1,
    runCount: 1,
    lastRunStartAt: daysAgo(150),
    hasActiveCampaign: false,
    lastCampaignEndAt: daysAgo(140),
    ...over,
  } as SellerSummary;
}

function renderRhythm(row: SellerSummary) {
  const col = buildSellerColumns({ onAnalyze: () => {}, analyzingId: null }).find((c) => c.key === "lastRunStartAt")!;
  return render(<>{col.render!(row)}</>);
}

describe("셀러 표 — 휴면 배지와 휴면 보기는 한 판정", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("시작예정 캠페인이 잡힌 셀러 — 배지 없음 + 휴면 보기에 없음", () => {
    const row = seller("booked", { hasUpcomingCampaign: true });
    renderRhythm(row);
    expect(screen.queryByText(/^휴면/)).not.toBeInTheDocument();
    expect(screen.getByText("—")).toHaveAttribute("title", expect.stringContaining("다음 캠페인이 잡혀 있음"));
    expect(filterSellersBySegment([row], "dormant", NOW)).toHaveLength(0);
  });

  it("다음 캠페인이 없는 휴면 셀러 — 배지 「휴면 150일」 + 휴면 보기에 있음", () => {
    const row = seller("idle", { hasUpcomingCampaign: false });
    renderRhythm(row);
    expect(screen.getByText("휴면 150일")).toBeInTheDocument();
    expect(filterSellersBySegment([row], "dormant", NOW)).toHaveLength(1);
  });
});
