// 송장 회신 도착 표시의 순수 판정 — 서버(campaigns-handler)와 화면(주문 관리 카드)이 공유한다.
//
// 크론 `scan-invoice-replies` 가 회신 메일을 **감지만** 해서 `InvoiceReplyDetection` 에 남기고,
// 이 모듈이 그 기록을 지금의 이행 상태(배송대기 = 발주요청 후 아직 송장 미등록)와 대조해
// 「아직 처리 안 된 회신이 있는가」를 파생한다.
//
// ⛔ 「소비됨」을 테이블에 쓰지 말 것 — 송장이 등록되는 경로는 여럿이고(송장회신 → 발송처리 ·
//    송장등록 파일 · 네이버 판매자센터 직접 입력) 그 전부에 훅을 다는 대신, **결과**(그 주문이
//    배송대기를 벗어났는가)에서 읽는다. 행을 지우지도 않는다 — 감지 이력이 남아야 「왜 떴었나」를
//    나중에 확인할 수 있다.
//
// 이 파일은 client-safe 다(의존성 = date-utils 뿐). 메일·DB 를 끌고 오지 말 것.

import { formatLastSyncLabel, toKstYmd } from '@/lib/date-utils';

/** 화면이 받는 최소 형태(campaigns 응답의 `invoiceReply`). */
export interface InvoiceReplyStatus {
  /** 회신 엑셀에 송장이 실린 주문 중 **아직 배송대기에 남은** 주문 수. 파싱을 못 한 회신만 있으면 0. */
  count: number;
  /** 아직 처리 안 된 회신 중 가장 최근 수신 시각(ISO). */
  receivedAt: string;
}

/** 판정에 필요한 감지 기록 형태 — Prisma 행이 그대로 들어맞는다. */
export interface InvoiceReplyDetectionLite {
  receivedAt: Date | string;
  /** 회신 엑셀의 주문번호 키 목록(상품주문번호 또는 주문번호 — 브랜드 회신 규칙이 정한다). */
  trackingOrderKeys: unknown;
}

/** 캠페인의 지금 배송대기 상태. */
export interface PendingFulfillment {
  /** 배송대기 버킷 주문의 키 — 상품주문번호와 주문번호를 **둘 다** 담는다(회신 엑셀이 어느 쪽을 쓸지 모른다). */
  keys: ReadonlySet<string>;
  /** 배송대기 주문 중 가장 오래된 발주요청 시각(ms). 없으면 null. */
  oldestPoRequestedAtMs: number | null;
}

function toKeyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => String(value ?? '').trim()).filter(Boolean);
}

function toMs(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 아직 처리 안 된 회신이 있으면 그 요약을, 없으면 null 을 돌려준다.
 *
 * - 배송대기 주문이 0건이면 **전부 처리된 것**이다 — 회신이 있어도 띄우지 않는다.
 * - 주문번호를 읽은 회신은 **그 주문 중 하나라도 아직 배송대기면** 미처리다(정확 판정).
 * - 주문번호를 못 읽은 회신(첨부 파싱 실패·0건)은 「가장 오래된 배송대기의 발주요청 **이후**에
 *   도착했는가」로 본다 — 그보다 이른 회신은 이미 처리된 앞 차수의 회신이다.
 */
export function resolveInvoiceReplyStatus(
  detections: readonly InvoiceReplyDetectionLite[],
  pending: PendingFulfillment,
): InvoiceReplyStatus | null {
  if (pending.keys.size === 0) return null;

  const covered = new Set<string>();
  let latestMs = 0;
  let unconsumed = false;

  for (const detection of detections) {
    const receivedMs = toMs(detection.receivedAt);
    if (!Number.isFinite(receivedMs)) continue;
    const keys = toKeyList(detection.trackingOrderKeys);

    if (keys.length > 0) {
      const stillPending = keys.filter((key) => pending.keys.has(key));
      if (stillPending.length === 0) continue;
      for (const key of stillPending) covered.add(key);
    } else {
      if (pending.oldestPoRequestedAtMs === null || receivedMs < pending.oldestPoRequestedAtMs) continue;
    }

    unconsumed = true;
    if (receivedMs > latestMs) latestMs = receivedMs;
  }

  return unconsumed ? { count: covered.size, receivedAt: new Date(latestMs).toISOString() } : null;
}

/**
 * 카드 한 줄 문구 — 「송장 회신 도착 · 주문 N건 · HH:MM」. 오늘(KST)이 아니면 시각 앞에 MM.DD 를
 * 붙인다(어제 온 회신이 오늘 온 것으로 읽히지 않게 — `formatLastSyncLabel` 과 같은 꼴).
 * N 은 **회신 엑셀에 송장이 실린 주문 중 아직 배송대기인 주문 수**다(`count`) — 무엇을 세는지 문구에
 * 「주문」으로 밝힌다(ss-ux 검토 2026-10-06). 건수를 못 읽은 회신이면 건수 칸을 뺀다(0건이라고 쓰면
 * 「회신에 송장이 없다」로 읽힌다).
 */
export function formatInvoiceReplyLine(status: InvoiceReplyStatus, now: Date = new Date()): string {
  const when = formatLastSyncLabel(status.receivedAt, now);
  const parts = ['송장 회신 도착'];
  if (status.count > 0) parts.push(`주문 ${status.count.toLocaleString('ko-KR')}건`);
  if (when) parts.push(when);
  return parts.join(' · ');
}

/**
 * 송장회신 조회가 제목 매칭에 쓰는 「발주 요청일」 목록(YYMMDD).
 *
 * 수동 버튼(주문 관리 카드)과 크론이 **같은 규칙**으로 만들어야 매칭이 갈리지 않는다 — 그래서
 * 화면 코드에 있던 것을 여기로 옮겼다. 최근 작업(DailyOrderTask) 중 EMAILED·PENDING 의 날짜,
 * 없으면 오늘(KST).
 */
export function deriveReplySentDates(
  tasks: ReadonlyArray<{ date: string; status: string }> | null | undefined,
  now: Date = new Date(),
): string[] {
  const active = (tasks ?? []).filter((task) => task.status === 'EMAILED' || task.status === 'PENDING');
  const toYymmdd = (ymd: string) => ymd.slice(2).replace(/-/g, '');
  if (active.length > 0) {
    return active.map((task) => {
      // 작업 날짜는 'YYYY-MM-DD' 문자열이다(스키마 주석). 다른 꼴이면 KST 달력으로 읽는다.
      if (/^\d{4}-\d{2}-\d{2}$/.test(task.date)) return toYymmdd(task.date);
      const parsed = new Date(task.date);
      return Number.isNaN(parsed.getTime()) ? toYymmdd(toKstYmd(now)) : toYymmdd(toKstYmd(parsed));
    });
  }
  return [toYymmdd(toKstYmd(now))];
}
