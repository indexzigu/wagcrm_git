// 콘텐츠 발행 × 주문 반응 병합 SSOT — 캠페인 타임라인 GET이 쓴다.
// 일별 주문의 원천은 dailyAggregate 소비 로더(getMobileCampaignSales)뿐이다(P7) —
// 이 모듈은 이미 집계된 CampaignDailyPoint를 받아 병합만 한다(prisma 접근 없음).
import type { CampaignDailyPoint } from "@/lib/order-converter/daily-aggregate";
import { startOfKstDayMs } from "@/lib/order-converter/sale-window";
import { toDateKeyKst } from "@/lib/mobile-pulse-data";

export type ContentEventType = "story" | "image" | "video" | "reel" | "carousel" | "unknown";

export type ContentEvent = {
  id: string;
  source: "asset" | "story";
  type: ContentEventType;
  postedAt: string;
  dateKey: string;
  thumbnailUrl: string | null;
  permalink: string | null;
  likeCount: number | null;
  commentCount: number | null;
  likesHidden: boolean;
};

export type TimelineDay = {
  date: string;
  orders: number;
  /** 창 시작일부터 이 날까지의 주문 누계 — 차트의 누적 곡선 계열(설계 v2 확정 2026-07-29). */
  cumulativeOrders: number;
  revenue: number;
  events: ContentEvent[];
};

const ASSET_MEDIA_TYPES: ReadonlySet<ContentEventType> = new Set<ContentEventType>(["image", "video", "reel", "carousel"]);
/** 타임라인 최대 일수 — 초장기 창의 렌더·페이로드 폭주 방지(최근 구간 우선). */
const TIMELINE_MAX_DAYS = 90;

export function mapAssetMediaType(mediaType: string | null | undefined): ContentEventType {
  return mediaType && ASSET_MEDIA_TYPES.has(mediaType as ContentEventType)
    ? (mediaType as ContentEventType)
    : "unknown";
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildTimelineDays(args: {
  windowStartMs: number;
  windowEndMs: number;
  daily: CampaignDailyPoint[];
  events: ContentEvent[];
}): TimelineDay[] {
  const keys: string[] = [];
  // KST 날짜 열거 — DST 없는 KST라 +24h 반복이 안전하다.
  for (let ms = startOfKstDayMs(args.windowStartMs); ms <= args.windowEndMs; ms += DAY_MS) {
    keys.push(toDateKeyKst(new Date(ms)));
  }
  const capped = keys.slice(-TIMELINE_MAX_DAYS);
  const inWindow = new Set(capped);
  const ordersByDate = new Map(args.daily.map((d) => [d.date, d]));
  const eventsByDate = new Map<string, ContentEvent[]>();
  for (const ev of args.events) {
    if (!inWindow.has(ev.dateKey)) continue;
    const list = eventsByDate.get(ev.dateKey) ?? [];
    list.push(ev);
    eventsByDate.set(ev.dateKey, list);
  }
  // 누계는 표시 구간(capped) 기준이다 — 90일 캡으로 잘린 앞 구간은 daily에서도 버려지므로
  // "차트에 보이는 막대의 합 = 마지막 누계"가 항상 성립한다(둘이 갈리면 판독이 깨진다).
  let running = 0;
  return capped.map((date) => {
    const orders = ordersByDate.get(date)?.orders ?? 0;
    running += orders;
    return {
      date,
      orders,
      cumulativeOrders: running,
      revenue: ordersByDate.get(date)?.revenue ?? 0,
      events: (eventsByDate.get(date) ?? []).sort((a, b) => a.postedAt.localeCompare(b.postedAt)),
    };
  });
}
