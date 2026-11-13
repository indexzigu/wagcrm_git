// @vitest-environment jsdom
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

const healthySourceHealth = {
  naver: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 3, lastSuccessAt: "2026-11-13T04:00:00.000Z", latestError: null },
  coupang: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0, lastSuccessAt: "2026-11-13T04:00:00.000Z", latestError: null },
  kakao: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 2, lastSuccessAt: "2026-11-13T04:00:00.000Z", latestError: null },
};

function mockOverview(payload: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => payload });
}

describe("PriceDefenseCard", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("위반이 있으면 판매 조건 이름·격차·캠페인 peek 링크를 렌더한다", async () => {
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-07-24",
      counts: { ok: 5, tie: 1, violated: 2, review: 1, noData: 0 },
      violations: [
        { dealId: "d1", campaignId: "c1", dealName: "뉴트리원 웰니스", campaignLabel: "제이홈 2차", gap: 1200, snapshotDate: "2026-07-24" },
        { dealId: "d2", campaignId: null, dealName: "코링코 앰플", campaignLabel: null, gap: null, snapshotDate: "2026-07-24" },
      ],
      sourceHealth: healthySourceHealth,
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
      sourceHealth: healthySourceHealth,
    });

    render(<PriceDefenseCard />);

    expect(await screen.findByText("모든 판매 조건 최저가 이상 없음")).toBeInTheDocument();
    expect(screen.getByText(/모니터링 9개 판매 조건/)).toBeInTheDocument();
    // 위반 0이면 count 배지 미렌더
    expect(screen.queryByText("최저가 점검")).toBeInTheDocument(); // 제목은 유지
  });

  it("소스 수집이 불완전하면 정상 안심 문구를 숨기고 상태 경고를 렌더한다", async () => {
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-11-13",
      counts: { ok: 8, tie: 1, violated: 0, review: 0, noData: 0 },
      violations: [],
      sourceHealth: {
        naver: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0, lastSuccessAt: null, latestError: "인증값 미설정" },
        coupang: { status: "disabled", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0, lastSuccessAt: null, latestError: null },
        kakao: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 2, lastSuccessAt: "2026-11-13T04:00:00.000Z", latestError: null },
      },
    });

    render(<PriceDefenseCard />);

    expect(await screen.findByText(/수집이 불완전/)).toBeInTheDocument();
    expect(screen.queryByText("모든 판매 조건 최저가 이상 없음")).not.toBeInTheDocument();
    expect(screen.getByText(/네이버/)).toBeInTheDocument();
  });

  it("한 소스라도 마지막 성공이 36시간을 넘기면 오래됨 경고를 렌더한다", async () => {
    const staleSuccess = new Date(Date.now() - 37 * 60 * 60 * 1000).toISOString();
    const recentSuccess = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-11-13",
      counts: { ok: 8, tie: 1, violated: 0, review: 0, noData: 0 },
      violations: [],
      sourceHealth: {
        naver: { status: "ok", checkedAt: staleSuccess, itemCount: 3, lastSuccessAt: staleSuccess, latestError: null },
        coupang: { status: "empty", checkedAt: recentSuccess, itemCount: 0, lastSuccessAt: recentSuccess, latestError: null },
        kakao: { status: "ok", checkedAt: recentSuccess, itemCount: 2, lastSuccessAt: recentSuccess, latestError: null },
      },
    });

    render(<PriceDefenseCard />);

    expect(await screen.findByText(/오래되어/)).toBeInTheDocument();
    expect(screen.queryByText("모든 판매 조건 최저가 이상 없음")).not.toBeInTheDocument();
  });

  it("오래된 소스의 마지막 성공 시각을 해당 소스 이름과 함께 표시한다", async () => {
    const staleNaver = new Date(Date.now() - 37 * 60 * 60 * 1000).toISOString();
    const recentKakao = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-11-13",
      counts: { ok: 8, tie: 1, violated: 0, review: 0, noData: 0 },
      violations: [],
      sourceHealth: {
        naver: { status: "ok", checkedAt: staleNaver, itemCount: 3, lastSuccessAt: staleNaver, latestError: null },
        coupang: { status: "empty", checkedAt: recentKakao, itemCount: 0, lastSuccessAt: recentKakao, latestError: null },
        kakao: { status: "ok", checkedAt: recentKakao, itemCount: 2, lastSuccessAt: recentKakao, latestError: null },
      },
    });

    render(<PriceDefenseCard />);

    const warning = await screen.findByRole("status");
    expect(warning).toHaveTextContent(/네이버\(오래됨\)/);
    expect(warning).toHaveTextContent(/네이버 마지막 성공/);
    expect(warning).not.toHaveTextContent(/카카오 마지막 성공/);
  });

  it("실패한 네이버도 마지막 성공 시각을 자체 표시하고 36시간 초과면 오래됨으로 표시한다", async () => {
    const staleNaver = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const freshKakao = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-11-13",
      counts: { ok: 8, tie: 1, violated: 0, review: 0, noData: 0 },
      violations: [],
      sourceHealth: {
        naver: { status: "error", checkedAt: freshKakao, itemCount: 0, lastSuccessAt: staleNaver, latestError: "조회 실패" },
        coupang: { status: "disabled", checkedAt: freshKakao, itemCount: 0, lastSuccessAt: null, latestError: null },
        kakao: { status: "ok", checkedAt: freshKakao, itemCount: 2, lastSuccessAt: freshKakao, latestError: null },
      },
    });

    render(<PriceDefenseCard />);

    const warning = await screen.findByRole("status");
    expect(warning).toHaveTextContent(/네이버\(실패\)/);
    expect(warning).toHaveTextContent(/네이버 마지막 성공/);
    expect(warning).toHaveTextContent(/오래되어/);
    expect(warning).not.toHaveTextContent(/카카오 마지막 성공/);
  });

  it.each([
    { noData: 2, review: 0, expected: "비교할 가격이 없는 판매 조건 2개" },
    { noData: 0, review: 2, expected: "검토 필요 2개" },
  ])("소스가 정상이어도 noData/review($expected)를 안심 문구 대신 표시한다", async ({ noData, review, expected }) => {
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-11-13",
      counts: { ok: 7, tie: 0, violated: 0, review, noData },
      violations: [],
      sourceHealth: healthySourceHealth,
    });

    render(<PriceDefenseCard />);

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("모든 판매 조건 최저가 이상 없음")).not.toBeInTheDocument();
  });

  it("미래 또는 무효한 마지막 성공 시각은 정상으로 통과시키지 않는다", async () => {
    mockOverview({
      monitoredCount: 9,
      latestSnapshotDate: "2026-11-13",
      counts: { ok: 8, tie: 1, violated: 0, review: 0, noData: 0 },
      violations: [],
      sourceHealth: {
        naver: { status: "ok", checkedAt: "2099-01-01T00:00:00.000Z", itemCount: 3, lastSuccessAt: "2099-01-01T00:00:00.000Z", latestError: null },
        coupang: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0, lastSuccessAt: "2026-11-13T04:00:00.000Z", latestError: null },
        kakao: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 2, lastSuccessAt: "2026-11-13T04:00:00.000Z", latestError: null },
      },
    });

    render(<PriceDefenseCard />);

    const warning = await screen.findByRole("status");
    expect(warning).toHaveTextContent(/네이버\(마지막 성공 시각 확인 필요\)/);
    expect(screen.queryByText("모든 판매 조건 최저가 이상 없음")).not.toBeInTheDocument();
  });

  it("모니터링 대상이 0이면 카드 자체를 렌더하지 않는다", async () => {
    mockOverview({
      monitoredCount: 0,
      latestSnapshotDate: null,
      counts: { ok: 0, tie: 0, violated: 0, review: 0, noData: 0 },
      violations: [],
      sourceHealth: healthySourceHealth,
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
