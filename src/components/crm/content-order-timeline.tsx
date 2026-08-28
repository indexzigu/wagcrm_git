"use client";
// 콘텐츠 발행 × 주문 반응 타임라인 — 캠페인 상세 섹션.
// 데이터는 /api/campaigns/[id]/content-order-timeline 1회 fetch(읽기 전용).
// 콘텐츠 유형(스토리/릴스/피드 등)은 범주이므로 색을 쓰지 않는다 — 아이콘 모양으로만 구분(P8).
//
// **렌더러는 하나다(오너 개정 2026-08-02).** 종전에는 인트라데이가 있으면 캔버스, 없으면
// 구형 recharts 곡선이라 "캠페인마다 그래프 스타일과 컴포넌트가 다르다"는 오너 지적을 받았다.
// 이제 같은 캔버스가 해상도(10분 ↔ 일별)만 바꿔 그린다 — recharts 경로는 은퇴했다.
import { useEffect, useMemo, useState } from "react";
import { Link2 } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import type { ContentEvent, TimelineDay } from "@/lib/content-order-correlation";
import { EVENT_ICON, EVENT_TYPE_LABEL } from "./content-event-icon";
import {
  IntradayOrderChart,
  resolveIntradayBounds,
  type IntradayPointInput,
} from "./intraday-order-chart";
import { IntradayHourHeatmap } from "./intraday-hour-heatmap";
import { BUCKET_MS, DAY_BUCKET_MS, kstDayRange, type Viewport } from "@/lib/intraday-chart";

// Task 3 응답 껍데기 — GET /api/campaigns/[id]/content-order-timeline 계약과 동일(로컬 선언).
type TimelineScope = { kind: "campaign" | "group"; campaignCount: number };

/** 10분 인트라데이(있을 때만) — 계약은 daily-aggregate.ts 의 ComposedIntraday 와 동형. */
type TimelineIntraday = {
  points: Array<{ startMs: number; orders: number; revenue: number }>;
  daysWithoutBuckets: string[];
};

/**
 * 이 화면이 **왜 비었는지**를 서버가 말해준다. 미검토 후보는 타임라인에 오르지 않는데
 * 그 사실이 화면 어디에도 없어 "수집된 게시물이 있는데 타임라인은 없다고 한다"는 모순으로
 * 보였다(오너 지적 2026-08-02).
 */
type TimelineContext = {
  /** 발주(주문 연동)가 붙어 있는가 — false 면 주문축이 구조적으로 빈다. */
  orderLinked: boolean;
  /** 창 안의 미검토 스토리 수(이벤트가 있으면 0 — 세지 않는다). */
  unreviewedStories: number;
  /** 자료관리와 같은 SSOT 로 센 미등록 게시물 후보 수. */
  unreviewedPostCandidates: number;
  /** 검토 기간(마감 +7일) 종료 — 후보가 더 늘지 않는 상태. */
  reviewClosed: boolean;
};

type TimelineResponse = {
  campaignId: string;
  scope?: TimelineScope;
  window: { start: string; end: string | null };
  source: "live" | "cached" | "none";
  days: TimelineDay[];
  intraday?: TimelineIntraday | null;
  context?: TimelineContext | null;
};

/**
 * **콘텐츠가 한 건도 없는 이유** — 후보가 있으면 그 수를 인용하고(자료관리와 같은 SSOT),
 * 없으면 검토 기간 종료 여부로 갈린다. 말할 것이 없으면 null.
 *
 * ⚠️ 이 문구는 완전 빈 상태 **전용이 아니다.** 주문은 있는데 콘텐츠 마커만 0건인 중간 상태
 * (발주 동기화가 콘텐츠 분류보다 앞선 흔한 국면)에서도 같은 체감 모순이 난다 — 그때는 차트가
 * 그려지므로 빈 상태 분기를 타지 않아 안내가 통째로 사라졌었다(UX 리뷰 P1).
 */
export function resolveContentGapNotice(context: TimelineContext | null): string | null {
  const candidates =
    (context?.unreviewedStories ?? 0) + (context?.unreviewedPostCandidates ?? 0);
  if (candidates > 0) {
    return `수집된 미검토 후보가 ${candidates}건 있습니다. 자료관리에서 홍보로 등록하면 발행 시점이 여기 표시됩니다.`;
  }
  if (context?.reviewClosed) return "콘텐츠 검토 기간이 끝나 새 후보가 제시되지 않습니다.";
  return null;
}

/**
 * 빈 상태 문구 — "없다"가 아니라 **왜 없는지와 무엇을 하면 되는지**를 말한다.
 * 발주 미연결은 주문축이 비는 별개 사유라 뒤에 덧붙인다(둘은 동시에 성립할 수 있다).
 */
export function resolveEmptyStateMessage(context: TimelineContext | null): string {
  const parts: string[] = [
    resolveContentGapNotice(context) ??
      "아직 등록된 콘텐츠가 없습니다. 자료관리에서 게시물을 분류하면 발행 시점과 주문 반응이 여기 표시됩니다.",
  ];
  if (context && !context.orderLinked) {
    parts.push("발주가 연결되지 않아 주문 데이터도 표시할 수 없습니다.");
  }
  return parts.join(" ");
}

// 2계열 색은 설계 확정본(2026-07-29)이 지정한 승인 팔레트 조합이다 — 누적 네이비 · 활동 앰버.
// 두 계열은 서로 다른 지표(누적량 vs 활동량)라 색 구분이 정당하다(P8 §4가 막는 것은 "좋고
// 나쁨이 없는 범주"의 무지개다). 신규 hue 도입 0.
const SERIES_COLOR = {
  cumulativeOrders: "var(--chart-1)",
  orders: "var(--chart-4)",
} as const;

/** dateKey(YYYY-MM-DD) → "M.D" — dashboard-home의 `slice(5)` 관용구와 동일 계열. */
function formatMonthDay(dateKey: string): string {
  const parts = dateKey.split("-");
  if (parts.length !== 3) return dateKey;
  return `${parseInt(parts[1], 10)}.${parseInt(parts[2], 10)}`;
}

/** ISO 시각 → KST HH:mm. */
function formatKstTime(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** 일별 요약 — "주문 N건 · 콘텐츠 M건"(툴팁·EventDayList 헤더·sr-only 목록 3곳이 각자 조립하던 문구를 통일). */
function formatDaySummary(day: { orders: number; events: ContentEvent[] }): string {
  return `주문 ${day.orders}건 · 콘텐츠 ${day.events.length}건`;
}

/**
 * 계열 범례 문구 — **캔버스에는 축 눈금이 없다**(수치는 툴팁·시간대 히트맵이 답한다).
 * 그래서 종전 recharts 시절의 "(좌축)/(우축)" 표기는 있지도 않은 축을 가리키는 거짓 라벨이라
 * 두 모드 모두에서 제거했다. 남는 차이는 활동량 계열의 **단위**뿐이다.
 */
export function resolveSeriesLabel(
  key: "cumulativeOrders" | "orders",
  mode: "daily" | "intraday",
): string {
  if (key === "cumulativeOrders") return "누적 주문";
  return mode === "intraday" ? "10분 주문" : "일별 주문";
}

function SeriesLegend({ mode }: { mode: "daily" | "intraday" }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      {(["cumulativeOrders", "orders"] as const).map((key) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={{ backgroundColor: SERIES_COLOR[key] }}
          />
          {resolveSeriesLabel(key, mode)}
        </span>
      ))}
    </div>
  );
}

/**
 * 마커(또는 클러스터) 선택 결과 — 날짜 헤더 대신 **시각 범위**를 쓴다.
 * 여기에 "주문 N건"을 붙이지 말 것: 클러스터는 임의 시간 폭이라 그 구간의 주문 건수를 말할
 * 근거가 없다(있는 척하면 숫자가 거짓이 된다).
 *
 * ℹ️ 종전 일별(recharts) 경로에는 막대 클릭으로 그 날 전체를 펴는 `EventDayList` 가 따로
 * 있었으나, 렌더러 통일로 두 모드 모두 **마커 클릭**이 진입점이 되어 소비처가 사라졌다
 * (콘텐츠가 없는 날은 애초에 펼 내용이 없다). 콘텐츠 1건 행 렌더는 `EventRow` 가 계속 공유한다.
 */
export function IntradayEventList({ events }: { events: ContentEvent[] }) {
  if (events.length === 0) return null;
  const times = events.map((e) => Date.parse(e.postedAt)).filter((t) => Number.isFinite(t));
  const label =
    times.length > 0
      ? `${formatKstTime(new Date(Math.min(...times)).toISOString())}` +
        (times.length > 1 && Math.min(...times) !== Math.max(...times)
          ? ` ~ ${formatKstTime(new Date(Math.max(...times)).toISOString())}`
          : "")
      : "";
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">콘텐츠 {events.length}건</p>
      </div>
      <ul className="space-y-2">
        {events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </ul>
    </div>
  );
}

/** 콘텐츠 1건 행 — 일별 목록과 인트라데이 목록이 공유한다(문구가 갈라지지 않게). */
function EventRow({ event }: { event: ContentEvent }) {
  const Icon = EVENT_ICON[event.type];
  return (
    <li className="flex items-center gap-3">
      <div className="relative size-10 shrink-0 overflow-hidden rounded-md bg-muted">
        {event.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={event.thumbnailUrl} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Icon aria-hidden className="size-4 text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="sr-only">{EVENT_TYPE_LABEL[event.type]}</span>
          <span className="tabular-nums">{formatKstTime(event.postedAt)}</span>
        </div>
        {/* 스토리는 좋아요·댓글 지표가 구조적으로 없다(route.ts가 항상 likeCount/commentCount를
            null로 채움) — "집계 전"을 띄우면 "곧 집계된다"는 거짓 신호가 되므로 반응 줄
            자체를 생략한다(리뷰 Finding 4). */}
        {event.source !== "story" && (
          <p className="text-xs text-muted-foreground">
            {/* 좋아요 숨김(likesHidden)은 임의 숫자 금지 — "비공개"로 표기(오너 결정
                2026-07-11, asset-manager.tsx:1145-1150 관용구와 동일) */}
            좋아요{" "}
            {event.likesHidden
              ? "비공개"
              : event.likeCount !== null
                ? event.likeCount.toLocaleString()
                : "집계 전"}
            {event.commentCount !== null ? ` · 댓글 ${event.commentCount.toLocaleString()}` : ""}
          </p>
        )}
      </div>
      {event.permalink && (
        <a
          href={event.permalink}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Link2 aria-hidden className="size-3" />
          원본
        </a>
      )}
    </li>
  );
}

export function ContentOrderTimeline({ campaignId }: { campaignId: string }) {
  const [days, setDays] = useState<TimelineDay[] | null>(null);
  const [intraday, setIntraday] = useState<TimelineIntraday | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<ContentEvent[] | null>(null);
  const [scope, setScope] = useState<TimelineScope | null>(null);
  const [context, setContext] = useState<TimelineContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setScope(null);
    setContext(null);
    setIntraday(null);
    setViewport(null);
    setSelectedEvents(null);
    fetch(`/api/campaigns/${campaignId}/content-order-timeline`)
      .then(async (res) => {
        if (!res.ok) throw new Error("타임라인을 불러오지 못했습니다.");
        return (await res.json()) as TimelineResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setDays(json.days);
        setScope(json.scope ?? null);
        setContext(json.context ?? null);
        setIntraday(json.intraday ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "타임라인을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  // useMemo 로 감싸는 이유는 참조 안정성이다 — `?? []` 는 매 렌더 새 배열을 만들어
  // 아래 useMemo 들의 의존성을 매번 바꾼다(캔버스가 매 렌더 다시 그려진다).
  const intradayPoints = useMemo(() => intraday?.points ?? [], [intraday]);

  /**
   * 일별 점 — 인트라데이가 없을 때 **같은 캔버스**에 넣는 해상도 낮은 입력이다.
   * 렌더러를 갈아타지 않으므로 캠페인마다 차트가 달라 보이지 않는다(오너 개정 2026-08-02).
   */
  const dailyPoints = useMemo<IntradayPointInput[]>(
    () =>
      (days ?? [])
        .map((d) => {
          const range = kstDayRange(d.date);
          return range
            ? { startMs: range.startMs, orders: d.orders, revenue: d.revenue }
            : null;
        })
        .filter((p): p is IntradayPointInput => p !== null),
    [days],
  );

  const mode: "intraday" | "daily" = intradayPoints.length > 0 ? "intraday" : "daily";
  const points = mode === "intraday" ? intradayPoints : dailyPoints;
  const bucketMs = mode === "intraday" ? BUCKET_MS : DAY_BUCKET_MS;

  /** 누적선의 일 경계 정본 — 서버 값이다(버킷 자체 누계는 「기록 없음」 구간을 흘린다). */
  const cumulativeByDate = useMemo(
    () => new Map((days ?? []).map((d) => [d.date, d.cumulativeOrders])),
    [days],
  );

  // 창 전체를 bounds 로 — 버킷 첫 점 기준이면 버킷이 늦게 시작하는 캠페인에서
  // 콘텐츠 마커·주문 피크가 통째로 잘린다(오너 발견 2026-08-02).
  const bounds = useMemo(
    () => resolveIntradayBounds(points, (days ?? []).map((d) => d.date), bucketMs),
    [points, days, bucketMs],
  );
  // 뷰포트 미설정(첫 렌더·데이터 교체 직후)이면 전체 구간이 기본값이다.
  const effectiveViewport = viewport ?? bounds;
  const canRenderChart = points.length > 0 && bounds !== null && effectiveViewport !== null;

  /** 창 안의 모든 콘텐츠 — 마커는 날짜가 아니라 정확한 발행 시각에 찍힌다(두 모드 공통). */
  const allEvents = useMemo(() => (days ?? []).flatMap((d) => d.events), [days]);

  const heading = (
    <h3 className="text-sm font-semibold text-foreground">콘텐츠 × 주문 타임라인</h3>
  );

  if (loading) {
    return (
      <div className="space-y-2">
        {heading}
        <Skeleton className="h-[220px] w-full rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        {heading}
        {/* 로딩 스켈레톤(h-[220px])과 높이를 맞춰 전환 시 아래 섹션이 딸려 올라가지 않게 한다
            (리뷰 Finding 5). */}
        <div className="flex min-h-[220px] w-full items-center justify-center rounded-lg border border-border/40 bg-slate-50/40">
          <p className="text-xs text-slate-500">{error}</p>
        </div>
      </div>
    );
  }

  const totalEvents = (days ?? []).reduce((sum, d) => sum + d.events.length, 0);
  const totalOrders = (days ?? []).reduce((sum, d) => sum + d.orders, 0);

  if (totalEvents === 0 && totalOrders === 0) {
    return (
      <div className="space-y-2">
        {heading}
        <div className="flex min-h-[220px] w-full items-center justify-center rounded-lg border border-border/40 bg-slate-50/40 px-6 text-center">
          <p className="text-xs text-slate-500">{resolveEmptyStateMessage(context)}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {heading}
          {/* 그룹은 여러 회차를 합산한 값이다 — 회차 하나로 오독하면 과대집계로 보인다.
              브랜드 네이비 틴트는 상태 hue가 아닌 중립 태그 캐리어다(P8 §4). */}
          {scope?.kind === "group" && (
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              그룹 통합 {scope.campaignCount}건
            </span>
          )}
        </div>
        <SeriesLegend mode={mode} />
      </div>
      {/* 주문은 그려지는데 콘텐츠 마커만 0건인 상태 — 빈 상태 분기를 타지 않아 안내가
          사라졌던 자리다(UX 리뷰 P1). 서버가 이미 계산해 내려준 사유를 그대로 쓴다. */}
      {totalEvents === 0 && resolveContentGapNotice(context) && (
        <p className="text-[11px] text-slate-500">{resolveContentGapNotice(context)}</p>
      )}
      {/* 콘텐츠는 있는데 주문이 0인 캠페인 — 원인이 "안 팔렸다"가 아니라 "연동이 없다"임을
          밝힌다. 판정·심각도가 아니라 사실 고지라 색을 쓰지 않는다(P8 §4). */}
      {context && !context.orderLinked && totalOrders === 0 && (
        <p className="text-[11px] text-slate-500">
          발주(주문 연동)가 연결되지 않아 주문 데이터가 비어 있습니다.
        </p>
      )}
      {canRenderChart ? (
        <>
          {/* 시각 차트에 도달하지 못하는 경로를 위한 전체 데이터(P0 접근성) — 캔버스는
              스크린리더에 아무것도 주지 않으므로 일별 요약이 대체 경로다. 주문만 있고 콘텐츠가
              없는 날은 마커가 없어 포인터로도 도달할 수 없으므로 두 모드 모두 이 목록을 낸다. */}
          <ul className="sr-only" aria-label="일별 콘텐츠·주문 요약">
            {(days ?? []).map((day) => (
              <li key={day.date}>
                {formatMonthDay(day.date)} · {formatDaySummary(day)} · 누적 주문{" "}
                {day.cumulativeOrders}건
              </li>
            ))}
          </ul>
          {/* 렌더러는 하나다 — 해상도(bucketMs)만 10분 ↔ 일별로 갈린다. */}
          <IntradayOrderChart
            points={points}
            events={allEvents}
            viewport={effectiveViewport!}
            bounds={bounds!}
            bucketMs={bucketMs}
            cumulativeByDate={cumulativeByDate}
            daysWithoutBuckets={mode === "intraday" ? intraday?.daysWithoutBuckets : undefined}
            onViewportChange={setViewport}
            onSelectEvents={setSelectedEvents}
          />
          {mode === "intraday" && intraday && intraday.daysWithoutBuckets.length > 0 && (
            // 신뢰도 고지는 **차트 바로 아래**다 — 판단 전에 전제를 먼저 알려야 한다.
            // 문구도 사실대로: 그 구간은 0 으로 그리지 않고 **끊어서 비워 둔다**.
            // 누적선은 서버 일별 누계에 앵커되므로 그 구간의 주문도 누계에는 반영돼 있다.
            <p className="text-[11px] text-slate-500">
              {intraday.daysWithoutBuckets.length}일치는 10분 단위 기록이 없어 차트에서 비워
              뒀습니다(회색 구간). 그 구간의 주문도 누적선과 일별 합계에는 들어 있습니다.
            </p>
          )}
          {/* 시간대 보조뷰(C-1)는 인트라데이 전용이다 — 일 버킷에는 시간 정보가 없다. */}
          {mode === "intraday" && (
            <IntradayHourHeatmap points={intradayPoints} viewport={effectiveViewport!} />
          )}
          {selectedEvents && <IntradayEventList events={selectedEvents} />}
        </>
      ) : (
        // 창은 있는데 그릴 점이 하나도 없는 경우(일별 집계조차 비어 있음).
        <div className="flex min-h-[220px] w-full items-center justify-center rounded-lg border border-border/40 bg-slate-50/40 px-6 text-center">
          <p className="text-xs text-slate-500">표시할 주문 데이터가 아직 없습니다.</p>
        </div>
      )}
    </div>
  );
}
