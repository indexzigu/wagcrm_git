import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ContentOrderTimeline, IntradayEventList } from "./content-order-timeline";
import { resolveIntradayBounds } from "./intraday-order-chart";
import { DAY_BUCKET_MS } from "@/lib/intraday-chart";
import type { TimelineDay } from "@/lib/content-order-correlation";

const baseEvent = {
  id: "asset-1", source: "asset" as const, type: "reel" as const,
  postedAt: "2026-07-02T10:00:00.000Z", dateKey: "2026-07-02",
  thumbnailUrl: null, permalink: "https://instagram.com/p/x/",
  likeCount: 12, commentCount: 3, likesHidden: false,
};

// 마커 클릭 상세 — 렌더러 통일 후 두 모드 공통의 유일한 상세 진입점이다(종전 일별 경로의
// EventDayList 는 막대 클릭 표적과 함께 은퇴). 콘텐츠 1건 행 렌더 계약은 그대로 유지된다.
describe("IntradayEventList", () => {
  it("이벤트의 유형·시각·반응·링크를 렌더한다", () => {
    render(<IntradayEventList events={[baseEvent]} />);
    expect(screen.getByText(/12/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /원본/ })).toHaveAttribute("href", baseEvent.permalink);
  });

  it("likesHidden이면 좋아요 숫자 대신 비공개 표기(asset-manager.tsx 관용구와 동일)", () => {
    render(<IntradayEventList events={[{ ...baseEvent, likeCount: null, likesHidden: true }]} />);
    expect(screen.getByText(/비공개/)).toBeInTheDocument();
  });

  it("좋아요가 미집계(null)면 '집계 전' 표기(스토리가 아닌 경우)", () => {
    render(
      <IntradayEventList
        events={[{ ...baseEvent, likeCount: null, commentCount: null, likesHidden: false }]}
      />,
    );
    expect(screen.getByText(/집계 전/)).toBeInTheDocument();
  });

  it("스토리는 링크 버튼 없이 렌더", () => {
    render(
      <IntradayEventList
        events={[{ ...baseEvent, id: "story-1", source: "story", type: "story", permalink: null }]}
      />,
    );
    expect(screen.queryByRole("link", { name: /원본/ })).not.toBeInTheDocument();
  });

  it("스토리는 반응 지표 줄 자체를 생략한다(구조적 null 대비 '집계 전' 오표시 금지)", () => {
    render(
      <IntradayEventList
        events={[{
          ...baseEvent, id: "story-1", source: "story", type: "story",
          permalink: null, likeCount: null, commentCount: null, likesHidden: false,
        }]}
      />,
    );
    expect(screen.queryByText(/좋아요/)).not.toBeInTheDocument();
    expect(screen.queryByText(/집계 전/)).not.toBeInTheDocument();
  });

  it("콘텐츠 유형 라벨을 sr-only 텍스트로 노출한다(아이콘만으로 유형을 전달하지 않음)", () => {
    render(<IntradayEventList events={[{ ...baseEvent, type: "reel" }]} />);
    expect(screen.getByText("릴스")).toBeInTheDocument();
  });

  it("영상과 사진 라벨도 각각 구분되어 렌더된다", () => {
    render(
      <IntradayEventList
        events={[
          { ...baseEvent, id: "asset-2", type: "video" },
          { ...baseEvent, id: "asset-3", type: "image" },
        ]}
      />,
    );
    expect(screen.getByText("영상")).toBeInTheDocument();
    expect(screen.getByText("사진")).toBeInTheDocument();
  });

  it("이벤트가 없으면 아무것도 렌더하지 않는다", () => {
    const { container } = render(<IntradayEventList events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("resolveIntradayBounds — 일별 창 전체가 화면 범위다", () => {
  const KST = "T00:00:00+09:00";

  it("버킷이 창보다 늦게 시작해도 범위는 일별 첫날부터다(마커 잘림 실사고 회귀)", () => {
    // 실사고: 창 07-12~30 인데 버킷이 07-16 부터라 콘텐츠 마커 36건 중 32건이 화면 밖.
    const bounds = resolveIntradayBounds(
      [{ startMs: Date.parse(`2026-07-16${KST}`), orders: 1, revenue: 0 }],
      ["2026-07-12", "2026-07-13", "2026-07-30"],
    );
    expect(bounds!.startMs).toBe(Date.parse(`2026-07-12${KST}`));
    // 끝은 마지막 일별 날짜의 하루 끝까지.
    expect(bounds!.endMs).toBe(Date.parse(`2026-07-31${KST}`));
  });

  it("일별 창이 없으면 버킷 점 범위로 폴백한다", () => {
    const base = Date.parse(`2026-07-16${KST}`);
    const bounds = resolveIntradayBounds([{ startMs: base, orders: 1, revenue: 0 }]);
    expect(bounds).toEqual({ startMs: base, endMs: base + 10 * 60 * 1000 });
  });

  it("둘 다 없으면 null", () => {
    expect(resolveIntradayBounds([])).toBeNull();
  });

  it("일 버킷이면 마지막 점 + 하루가 끝이다(일별 모드 폴백)", () => {
    const base = Date.parse(`2026-07-14${KST}`);
    const bounds = resolveIntradayBounds(
      [{ startMs: base, orders: 3, revenue: 0 }],
      [],
      DAY_BUCKET_MS,
    );
    expect(bounds).toEqual({ startMs: base, endMs: base + DAY_BUCKET_MS });
  });
});

describe("ContentOrderTimeline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("로딩 → 데이터 전이를 검증하고, 시각 차트와 무관한 sr-only 요약이 렌더된다", async () => {
    const days: TimelineDay[] = [
      { date: "2026-07-01", orders: 3, cumulativeOrders: 3, revenue: 30000, events: [] },
      { date: "2026-07-02", orders: 0, cumulativeOrders: 3, revenue: 0, events: [baseEvent] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          window: { start: "2026-07-01T00:00:00.000Z", end: null },
          source: "live",
          days,
        }),
      }),
    );

    render(<ContentOrderTimeline campaignId="c1" />);

    // 로딩 상태: 스켈레톤이 보이고, 데이터 요약은 아직 없다.
    expect(document.querySelector(".animate-shimmer")).not.toBeNull();

    // 데이터 전이 완료 대기.
    await waitFor(() => {
      expect(document.querySelector(".animate-shimmer")).toBeNull();
    });

    // 주문만 있고 콘텐츠가 없는 날 — 시각 마커로는 도달 불가하지만 sr-only 목록으로는 도달 가능해야 한다.
    expect(screen.getByText("7.1 · 주문 3건 · 콘텐츠 0건 · 누적 주문 3건")).toBeInTheDocument();
    expect(screen.getByText("7.2 · 주문 0건 · 콘텐츠 1건 · 누적 주문 3건")).toBeInTheDocument();
  });

  it("인트라데이가 있으면 캔버스 차트로 대체하고 시간대 보조뷰를 함께 낸다", async () => {
    const base = Date.parse("2026-07-08T10:00:00+09:00");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          window: { start: "2026-07-08T00:00:00.000Z", end: null },
          source: "live",
          days: [
            { date: "2026-07-08", orders: 3, cumulativeOrders: 3, revenue: 0, events: [] },
          ] satisfies TimelineDay[],
          intraday: {
            points: [
              { startMs: base, orders: 2, revenue: 20000 },
              { startMs: base + 10 * 60 * 1000, orders: 1, revenue: 10000 },
            ],
            daysWithoutBuckets: [],
          },
        }),
      }),
    );

    render(<ContentOrderTimeline campaignId="c1" />);

    await waitFor(() => {
      expect(document.querySelector("canvas")).not.toBeNull();
    });
    // 인트라데이 모드의 범례는 축을 가리키지 않는다(캔버스에는 축이 없다).
    expect(screen.getByText("10분 주문")).toBeInTheDocument();
    expect(screen.queryByText(/좌축/)).not.toBeInTheDocument();
    // 보조뷰(시간대) 동반
    expect(screen.getByText(/시간대별/)).toBeInTheDocument();
    // 조작 힌트(버튼 줄 대신 — 확정 설계)
    expect(screen.getByText(/휠로 확대/)).toBeInTheDocument();
  });

  it("인트라데이가 없어도 같은 캔버스를 일별 해상도로 그린다(렌더러 통일 — 오너 개정 2026-08-02)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          window: { start: "2026-07-01T00:00:00.000Z", end: null },
          source: "cached",
          days: [
            { date: "2026-07-01", orders: 3, cumulativeOrders: 3, revenue: 0, events: [] },
          ] satisfies TimelineDay[],
          intraday: null,
        }),
      }),
    );

    render(<ContentOrderTimeline campaignId="c1" />);

    await waitFor(() => {
      expect(document.querySelector(".animate-shimmer")).toBeNull();
    });
    // 종전에는 여기서 recharts 곡선으로 갈아탔다 — 캠페인마다 다른 제품처럼 보이던 원인.
    expect(document.querySelector("canvas")).not.toBeNull();
    expect(document.querySelector(".recharts-wrapper")).toBeNull();
    // 범례는 단위만 바뀐다. 캔버스에는 축 눈금이 없으므로 축 표기는 두 모드 모두 없다.
    expect(screen.getByText("일별 주문")).toBeInTheDocument();
    expect(screen.getByText("누적 주문")).toBeInTheDocument();
    expect(screen.queryByText(/좌축/)).not.toBeInTheDocument();
    // 조작은 두 모드 공통이다.
    expect(screen.getByText(/휠로 확대/)).toBeInTheDocument();
  });

  it("일별 모드에서는 시간대 보조뷰를 내지 않는다(일 버킷에는 시간 정보가 없다)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          window: { start: "2026-07-01T00:00:00.000Z", end: null },
          source: "cached",
          days: [
            { date: "2026-07-01", orders: 3, cumulativeOrders: 3, revenue: 0, events: [] },
          ] satisfies TimelineDay[],
          intraday: null,
        }),
      }),
    );

    render(<ContentOrderTimeline campaignId="c1" />);

    await waitFor(() => {
      expect(document.querySelector("canvas")).not.toBeNull();
    });
    expect(screen.queryByText(/시간대별/)).not.toBeInTheDocument();
  });

  it("버킷이 없는 과거 일자가 있으면 곡선에서 빠졌음을 고지한다(무음 누락 금지)", async () => {
    const base = Date.parse("2026-07-08T10:00:00+09:00");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          window: { start: "2026-07-08T00:00:00.000Z", end: null },
          source: "live",
          days: [
            { date: "2026-07-08", orders: 2, cumulativeOrders: 2, revenue: 0, events: [] },
          ] satisfies TimelineDay[],
          intraday: {
            points: [{ startMs: base, orders: 2, revenue: 20000 }],
            daysWithoutBuckets: ["2026-07-01", "2026-07-02"],
          },
        }),
      }),
    );

    render(<ContentOrderTimeline campaignId="c1" />);

    await waitFor(() => {
      expect(screen.getByText(/2일치는 10분 단위 기록이 없어 차트에서 비워/)).toBeInTheDocument();
    });
  });

  it("그룹 통합 응답이면 스코프 배지를 띄운다(회차 하나로 오독 방지)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          scope: { kind: "group", campaignCount: 3 },
          window: { start: "2026-07-01T00:00:00.000Z", end: null },
          source: "live",
          days: [
            { date: "2026-07-01", orders: 3, cumulativeOrders: 3, revenue: 0, events: [] },
          ] satisfies TimelineDay[],
        }),
      }),
    );

    render(<ContentOrderTimeline campaignId="c1" />);

    await waitFor(() => {
      expect(screen.getByText("그룹 통합 3건")).toBeInTheDocument();
    });
  });

  it("그룹이 아니면 스코프 배지를 띄우지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          scope: { kind: "campaign", campaignCount: 1 },
          window: { start: "2026-07-01T00:00:00.000Z", end: null },
          source: "live",
          days: [
            { date: "2026-07-01", orders: 3, cumulativeOrders: 3, revenue: 0, events: [] },
          ] satisfies TimelineDay[],
        }),
      }),
    );

    render(<ContentOrderTimeline campaignId="c1" />);

    await waitFor(() => {
      expect(document.querySelector(".animate-shimmer")).toBeNull();
    });
    expect(screen.queryByText(/그룹 통합/)).not.toBeInTheDocument();
  });

  // 빈 상태는 "없다"가 아니라 **왜 없는지**를 말해야 한다 — 미검토 후보가 타임라인에
  // 오르지 않는다는 사실이 어디에도 없어 체감 모순이 났다(오너 지적 2026-08-02).
  describe("빈 상태 — 사유를 밝힌다", () => {
    const emptyResponse = (context: Record<string, unknown>) => ({
      ok: true,
      json: async () => ({
        campaignId: "c1",
        window: { start: "2026-07-01T00:00:00.000Z", end: null },
        source: "none",
        days: [
          { date: "2026-07-01", orders: 0, cumulativeOrders: 0, revenue: 0, events: [] },
        ] satisfies TimelineDay[],
        intraday: null,
        context,
      }),
    });

    it("미검토 후보가 있으면 그 수와 다음 행동을 말한다", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          emptyResponse({
            orderLinked: true,
            unreviewedStories: 2,
            unreviewedPostCandidates: 3,
            reviewClosed: false,
          }),
        ),
      );
      render(<ContentOrderTimeline campaignId="c1" />);
      expect(await screen.findByText(/미검토 후보가 5건/)).toBeInTheDocument();
      expect(screen.getByText(/자료관리에서 홍보로 등록/)).toBeInTheDocument();
    });

    it("검토 기간이 끝났으면 후보가 더 늘지 않는 상태임을 말한다", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          emptyResponse({
            orderLinked: true,
            unreviewedStories: 0,
            unreviewedPostCandidates: 0,
            reviewClosed: true,
          }),
        ),
      );
      render(<ContentOrderTimeline campaignId="c1" />);
      expect(await screen.findByText(/검토 기간이 끝나/)).toBeInTheDocument();
    });

    it("발주 미연결이면 주문축이 비는 이유를 함께 말한다", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          emptyResponse({
            orderLinked: false,
            unreviewedStories: 0,
            unreviewedPostCandidates: 0,
            reviewClosed: false,
          }),
        ),
      );
      render(<ContentOrderTimeline campaignId="c1" />);
      expect(await screen.findByText(/발주가 연결되지 않아/)).toBeInTheDocument();
    });
  });

  it("주문은 있는데 콘텐츠만 0건이면 차트 위에 후보 안내를 낸다(빈 상태 분기를 안 타는 사각)", async () => {
    // 발주 동기화가 콘텐츠 분류보다 앞선 흔한 국면 — 종전에는 차트가 그려지므로 빈 상태
    // 문구가 통째로 사라져 "수집된 게시물이 있는데 타임라인엔 없다"는 모순이 남았다.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          window: { start: "2026-07-01T00:00:00.000Z", end: null },
          source: "cached",
          days: [
            { date: "2026-07-01", orders: 12, cumulativeOrders: 12, revenue: 0, events: [] },
          ] satisfies TimelineDay[],
          intraday: null,
          context: {
            orderLinked: true,
            unreviewedStories: 1,
            unreviewedPostCandidates: 2,
            reviewClosed: false,
          },
        }),
      }),
    );
    render(<ContentOrderTimeline campaignId="c1" />);
    expect(await screen.findByText(/미검토 후보가 3건/)).toBeInTheDocument();
    // 빈 상태가 아니라 차트가 그려지는 경로다.
    expect(document.querySelector("canvas")).not.toBeNull();
  });

  it("콘텐츠가 있으면 후보 안내를 내지 않는다(정상 상태에 잡음을 얹지 않는다)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          window: { start: "2026-07-01T00:00:00.000Z", end: null },
          source: "cached",
          days: [
            { date: "2026-07-01", orders: 12, cumulativeOrders: 12, revenue: 0, events: [baseEvent] },
          ] satisfies TimelineDay[],
          intraday: null,
          context: {
            orderLinked: true,
            unreviewedStories: 1,
            unreviewedPostCandidates: 2,
            reviewClosed: false,
          },
        }),
      }),
    );
    render(<ContentOrderTimeline campaignId="c1" />);
    await waitFor(() => {
      expect(document.querySelector("canvas")).not.toBeNull();
    });
    expect(screen.queryByText(/미검토 후보/)).not.toBeInTheDocument();
  });

  it("콘텐츠는 있는데 발주가 없으면 차트 위에 주문축이 빈 이유를 고지한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          campaignId: "c1",
          window: { start: "2026-07-01T00:00:00.000Z", end: null },
          source: "none",
          days: [
            { date: "2026-07-01", orders: 0, cumulativeOrders: 0, revenue: 0, events: [baseEvent] },
          ] satisfies TimelineDay[],
          intraday: null,
          context: {
            orderLinked: false,
            unreviewedStories: 0,
            unreviewedPostCandidates: 0,
            reviewClosed: false,
          },
        }),
      }),
    );
    render(<ContentOrderTimeline campaignId="c1" />);
    expect(await screen.findByText(/주문 데이터가 비어 있습니다/)).toBeInTheDocument();
    // 빈 상태가 아니라 차트가 그려지는 경로다(콘텐츠는 있다).
    expect(document.querySelector("canvas")).not.toBeNull();
  });

  it("fetch 실패 시 에러 문구를 렌더한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );

    render(<ContentOrderTimeline campaignId="c1" />);

    await waitFor(() => {
      expect(document.querySelector(".animate-shimmer")).toBeNull();
    });
    expect(screen.getByText("타임라인을 불러오지 못했습니다.")).toBeInTheDocument();
  });
});
