import { getPrisma } from "@/lib/prisma";
import { naverOrderSnapshotRepository } from "@/repositories/naverOrderSnapshotRepository";

/**
 * 주문관리 화면 진입 시 자동 동기화(네이버 변경분 조회)의 최소 간격.
 *
 * `fetchAndSyncCampaigns` 는 스냅샷이 낡았으면 응답 뒤 백그라운드로 변경피드 동기화
 * (`runSync('CHANGED')`)를 건다. 당일 스냅샷의 낡음 기준이 1분이라 사실상 매 호출이 네이버
 * 호출이었고, 네이버 호출은 IP 허용목록 때문에 요청 수로 과금되는 프록시를 거친다. 그래서 이
 * 동기화는 **마지막으로 성공한 변경피드 동기화가 이 간격보다 오래됐을 때만** 돈다.
 *
 * 간격을 타는 호출자(전부 `fetchAndSyncCampaigns` 경유): 주문관리 GET · 셀러 포털 리포트·성과 카드 ·
 * 캠페인 생성·저장·활성 토글 직후 · 매출 반영(push-sales). 이들은 이미 있는 스냅샷으로 집계하고,
 * 간격 사이의 신규 변경분은 주문관리 새로고침 버튼(`POST /order-converter/api/naver/sync`)이 가져온다.
 *
 * 간격을 타지 않는 것: 새로고침 버튼 · 발송처리·마감 재개 직후의 직접 `runSync` · 아침 크론 ·
 * 모바일 당겨서 새로고침 · 스냅샷 전무 시 FULL 부트스트랩 · 배송중 전이 보정 sweep(자체 3시간 쿨다운).
 *
 * ⚠️ 감수한 것: 발송처리 직후 정밀 갱신이 실패해 dirty 로 찍힌 날짜는 종전엔 다음 진입이 재조회했지만
 * 이제는 간격이 지나거나 버튼을 눌러야 재조회된다. dirty 를 간격 우회 조건으로 쓰지 않는 이유는
 * dirty 를 지우는 주체가 그 날짜의 upsert 뿐이라 조용한 날짜의 dirty 가 남아 매 진입이 우회되기 때문이다.
 *
 * 설정 화면: /settings/operations · API: /api/settings/order-sync
 */
export const ORDER_AUTO_SYNC_INTERVAL_OPTIONS = [1, 3, 6] as const;
export type OrderAutoSyncIntervalHours = (typeof ORDER_AUTO_SYNC_INTERVAL_OPTIONS)[number];

/** 스키마 기본값(`SystemSettings.orderAutoSyncIntervalHours @default(6)`)과 같은 값이어야 한다 — 테스트가 대조한다. */
export const DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS: OrderAutoSyncIntervalHours = 6;

export function isOrderAutoSyncInterval(value: unknown): value is OrderAutoSyncIntervalHours {
  return ORDER_AUTO_SYNC_INTERVAL_OPTIONS.some((option) => option === value);
}

/** 허용값(1·3·6) 밖의 값(행 없음·손으로 고친 DB 값)은 기본값으로 읽는다. */
export function normalizeOrderAutoSyncInterval(value: unknown): OrderAutoSyncIntervalHours {
  return isOrderAutoSyncInterval(value) ? value : DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS;
}

/**
 * 진입 동기화를 걸어도 되는가. 마지막 변경피드 동기화 시각을 모르면(조회 실패·기록 없음) 종전처럼 건다 —
 * 모르는 상태에서 막으면 화면이 무기한 낡은 채로 남는다.
 */
export function isOrderAutoSyncDue(lastChangeSyncMs: number | null, intervalHours: number, nowMs: number): boolean {
  if (lastChangeSyncMs == null || !Number.isFinite(lastChangeSyncMs)) return true;
  return nowMs - lastChangeSyncMs >= intervalHours * 60 * 60 * 1000;
}

export async function getOrderAutoSyncIntervalHours(): Promise<OrderAutoSyncIntervalHours> {
  const row = await getPrisma().systemSettings.findUnique({
    where: { id: "global" },
    select: { orderAutoSyncIntervalHours: true },
  });
  return normalizeOrderAutoSyncInterval(row?.orderAutoSyncIntervalHours);
}

/** 진입 경로용: 설정을 못 읽으면 기본값으로 판정한다(GET 을 깨뜨리지 않는다). */
export async function getOrderAutoSyncIntervalHoursOrDefault(): Promise<OrderAutoSyncIntervalHours> {
  try {
    return await getOrderAutoSyncIntervalHours();
  } catch (err) {
    console.warn("[order-auto-sync] Failed to read interval, using default:", err);
    return DEFAULT_ORDER_AUTO_SYNC_INTERVAL_HOURS;
  }
}

/** 마지막으로 성공한 변경피드 동기화 시각(ms). 모르면 null — isOrderAutoSyncDue 가 「건다」로 읽는다. */
export async function getLastChangeSyncMs(): Promise<number | null> {
  try {
    const row = await naverOrderSnapshotRepository.latestChangeCursor();
    const ms = row?.lastChangeStatusCursor ? Date.parse(row.lastChangeStatusCursor) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch (err) {
    console.warn("[order-auto-sync] Failed to read change cursor:", err);
    return null;
  }
}

export async function setOrderAutoSyncIntervalHours(hours: OrderAutoSyncIntervalHours): Promise<OrderAutoSyncIntervalHours> {
  await getPrisma().systemSettings.upsert({
    where: { id: "global" },
    create: { id: "global", orderAutoSyncIntervalHours: hours },
    update: { orderAutoSyncIntervalHours: hours },
  });
  return hours;
}
