/**
 * 최저가 방어 카드 — 알림센터 해체(2026-07-24)의 대체 표면 계약.
 *
 * 이 카드가 종전 PRICE_VIOLATION 알림이 나르던 유일 신호를 홈에서 상시
 * 노출하는 자리이므로, 세 상태의 렌더를 고정한다:
 *  ① 위반 존재 — urgent 도트 행 + "1위보다 X원 비쌈" + 캠페인 peek 링크
 *  ② 위반 0 · 모니터링 O — 숨기지 않고 "전 딜 최저가 방어 중" 안심 1줄
 *  ③ 모니터링 0 — 카드 자체를 접는다(기능 미사용 시 자리 낭비 방지)
 */
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { PriceDefenseCard } from "../price-defense-card";

const fetchMock = vi.fn();

function mockOverview(payload: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => payload });
}

describe("PriceDefenseCard", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("위반이 있으면 딜명·격차·캠페인 peek 링크를 렌더한다", async () => {
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-07-24",
      counts: { ok: 5, tie: 1, violated: 2, review: 1, noData: 0 },
      violations: [
        { dealId: "d1", campaignId: "c1", dealName: "뉴트리원 웰니스", campaignLabel: "제이홈 2차", gap: 1200, snapshotDate: "2026-07-24" },
        { dealId: "d2", campaignId: null, dealName: "코링코 앰플", campaignLabel: null, gap: null, snapshotDate: "2026-07-24" },
      ],
    });

    render(<PriceDefenseCard />);

    expect(await screen.findByText("뉴트리원 웰니스")).toBeInTheDocument();
    expect(screen.getByText("1위보다 1,200원 비쌈")).toBeInTheDocument();
    // campaignId 있으면 파이프라인 peek, 없으면 딜 상세로 폴백
    expect(screen.getByText("뉴트리원 웰니스").closest("a")).toHaveAttribute("href", "/pipeline?peek=c1");
    expect(screen.getByText("코링코 앰플").closest("a")).toHaveAttribute("href", "/deals?selected=d2");
    // gap이 null이면 금액 대신 라벨
    expect(screen.getByText("최저가 이탈")).toBeInTheDocument();
    // 헤더 범례 분포
    expect(screen.getByText("위반")).toBeInTheDocument();
    expect(screen.getByText("검토")).toBeInTheDocument();
  });

  it("위반 0 · 모니터링 대상 있으면 카드를 숨기지 않고 안심 문구를 렌더한다", async () => {
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-07-24",
      counts: { ok: 8, tie: 1, violated: 0, review: 0, noData: 0 },
      violations: [],
    });

    render(<PriceDefenseCard />);

    expect(await screen.findByText("전 딜 최저가 이상 없음")).toBeInTheDocument();
    expect(screen.getByText(/모니터링 9딜/)).toBeInTheDocument();
    // 위반 0이면 count 배지 미렌더
    expect(screen.queryByText("최저가 점검")).toBeInTheDocument(); // 제목은 유지
  });

  it("모니터링 대상이 0이면 카드 자체를 렌더하지 않는다", async () => {
    mockOverview({
      monitoredCount: 0,
      latestSnapshotDate: null,
      counts: { ok: 0, tie: 0, violated: 0, review: 0, noData: 0 },
      violations: [],
    });

    const { container } = render(<PriceDefenseCard />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("최저가 점검")).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it("API 실패 시 재시도 버튼과 함께 오류 문구를 렌더한다(무음 실패 금지)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    render(<PriceDefenseCard />);

    expect(await screen.findByText("최저가 현황을 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });
});
