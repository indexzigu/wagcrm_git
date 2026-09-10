import { getPrisma } from "@/lib/prisma";

/**
 * 주문관리 화면 진입 시 자동 동기화(네이버 변경분 조회)의 최소 간격.
 *
 * 화면 진입(`fetchAndSyncCampaigns` — 주문관리 GET·셀러 포털)은 스냅샷이 낡았으면 응답 뒤
 * 백그라운드로 변경분 동기화를 건다. 당일 스냅샷의 낡음 기준이 1분이라 사실상 매 진입마다
 * 네이버를 불렀고, 네이버 호출은 IP 허용목록 때문에 요청 수로 과금되는 프록시를 거친다.
 * 그래서 진입 동기화는 **마지막 동기화가 이 간격보다 오래됐을 때만** 돌고, 그 사이의 최신화는
 * 화면의 새로고침 버튼(`POST /order-converter/api/naver/sync`)이 맡는다.
 * 버튼·액션 직후 동기화(발송처리·마감 재개)·아침 크론·모바일 당겨서 새로고침은 이 간격을 타지 않는다.
 *
 * 설정 화면: /settings/operations · API: /api/settings/order-sync
 */
export const ORDER_AUTO_SYNC_INTERVAL_OPTIONS = [1, 3, 6] as const;
export type OrderAutoSyncIntervalHours = (typeof ORDER_AUTO_SYNC_INTERVAL_OPTIONS)[number];

/** 스키마 기본값(`SystemSettings.orderAutoSyncIntervalHours @default(6)`)과 같은 값이어야 한다. */
export const DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS: OrderAutoSyncIntervalHours = 6;

/** 허용값(1·3·6) 밖의 값(행 없음·손으로 고친 DB 값)은 기본값으로 읽는다. */
export function normalizeOrderAutoSyncInterval(value: unknown): OrderAutoSyncIntervalHours {
  return ORDER_AUTO_SYNC_INTERVAL_OPTIONS.find((option) => option === value) ?? DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS;
}

/**
 * 진입 동기화를 걸어도 되는가. 마지막 동기화 시각을 모르면(메타 조회 실패·기록 없음) 종전처럼 건다 —
 * 모르는 상태에서 막으면 화면이 무기한 낡은 채로 남는다.
 */
export function isOrderAutoSyncDue(lastSyncMs: number | null, intervalHours: number, nowMs: number): boolean {
  if (lastSyncMs == null || !Number.isFinite(lastSyncMs)) return true;
  return nowMs - lastSyncMs >= intervalHours * 60 * 60 * 1000;
}

export async function getOrderAutoSyncIntervalHours(): Promise<OrderAutoSyncIntervalHours> {
  const row = await getPrisma().systemSettings.findUnique({
    where: { id: "global" },
    select: { orderAutoSyncIntervalHours: true },
  });
  return normalizeOrderAutoSyncInterval(row?.orderAutoSyncIntervalHours);
}

export async function setOrderAutoSyncIntervalHours(hours: OrderAutoSyncIntervalHours): Promise<OrderAutoSyncIntervalHours> {
  await getPrisma().systemSettings.upsert({
    where: { id: "global" },
    create: { id: "global", orderAutoSyncIntervalHours: hours },
    update: { orderAutoSyncIntervalHours: hours },
  });
  return hours;
}
