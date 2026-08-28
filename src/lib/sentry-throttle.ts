// Sentry ingest 폭주 방지용 in-process 스로틀 (client/server/edge 공유).
//
// 목적: "동일 에러가 무한/지속 반복돼 quota를 태우는 사고"를 코드 레벨에서 막는다.
// 무료 플랜은 DSN Client Key rate limit이 Business 전용이라 대시보드 하드캡을 못
// 쓴다 — 따라서 이 코드 스로틀이 사실상 1차 방어선이다(2차: Inbound Filters로
// localhost·크롤러 차단 + enabled 프로덕션 게이트).
//
// 두 축으로 캡한다:
//  1) 누적(totalCount): 같은 에러 서명은 프로세스 수명 동안 MAX_PER_FINGERPRINT_TOTAL
//     건까지만 보내고 그 뒤엔 완전 침묵 → "잔잔한 지속 드립"까지 근본 차단.
//     (21번째 동일 이벤트는 정보가 0이므로 손실 없음)
//  2) 분당(windowCount): 버스트(짧은 시간 폭발)를 서명별/전역으로 억제.
//
// 브라우저 탭·서버리스 warm 인스턴스가 사는 동안 모듈 스코프가 유지되므로
// hot-path 반복을 캡한다. cold start·새 탭마다 리셋되는 한계는, 에러가 cold
// start를 유발하지 않고 warm 인스턴스가 반복 처리를 이어가므로 실무상 크지 않다.

const WINDOW_MS = 60_000;
const MAX_PER_FINGERPRINT_PER_WINDOW = 3; // 같은 서명: 분당 3건까지(버스트 억제)
const MAX_PER_FINGERPRINT_TOTAL = 10; // 같은 서명: 프로세스 수명 누적 10건 후 완전 침묵
const MAX_TOTAL_PER_WINDOW = 30; // 서명 불문 전체: 분당 30건까지(다종 동시폭주 억제)
const MAX_TRACKED_KEYS = 500; // Map 무한 증식 방지 상한

type Bucket = { windowStart: number; windowCount: number; totalCount: number };

const perFingerprint = new Map<string, Bucket>();
const totalBucket: Bucket = { windowStart: 0, windowCount: 0, totalCount: 0 };

/**
 * 이 이벤트를 Sentry로 보내도 되는지 판정.
 * - 서명별 누적 상한 초과 → 드롭(지속 반복 근본 차단)
 * - 서명별/전역 분당 상한 초과 → 드롭(버스트 억제)
 */
export function allowSentryEvent(fingerprint: string, now: number = Date.now()): boolean {
  let bucket = perFingerprint.get(fingerprint);
  if (!bucket) {
    bucket = { windowStart: now, windowCount: 0, totalCount: 0 };
    perFingerprint.set(fingerprint, bucket);
  }

  // 1) 누적 상한 — 충분한 샘플 확보 후 그 서명은 침묵
  if (bucket.totalCount >= MAX_PER_FINGERPRINT_TOTAL) return false;

  // 2) 서명별 분당 상한
  if (now - bucket.windowStart > WINDOW_MS) {
    bucket.windowStart = now;
    bucket.windowCount = 0;
  }
  if (bucket.windowCount >= MAX_PER_FINGERPRINT_PER_WINDOW) return false;

  // 3) 전역 분당 상한
  if (now - totalBucket.windowStart > WINDOW_MS) {
    totalBucket.windowStart = now;
    totalBucket.windowCount = 0;
  }
  if (totalBucket.windowCount >= MAX_TOTAL_PER_WINDOW) return false;

  // 통과 → 카운트 반영
  bucket.windowCount += 1;
  bucket.totalCount += 1;
  totalBucket.windowCount += 1;

  // 메모리 상한 — 아직 누적 상한에 안 걸렸고 윈도 지난 오래된 키만 정리
  // (침묵 중인 서명은 억제를 유지해야 하므로 남긴다)
  if (perFingerprint.size > MAX_TRACKED_KEYS) {
    for (const [key, b] of perFingerprint) {
      if (b.totalCount < MAX_PER_FINGERPRINT_TOTAL && now - b.windowStart > WINDOW_MS) {
        perFingerprint.delete(key);
      }
    }
  }

  return true;
}

type MinimalEvent = {
  fingerprint?: string[];
  exception?: { values?: Array<{ type?: string; value?: string }> };
  message?: string;
  transaction?: string;
};

/** 이벤트에서 안정적인 스로틀 키를 뽑는다(명시 fingerprint > 예외 타입:메시지 > 메시지 > 트랜잭션). */
export function eventFingerprint(event: MinimalEvent): string {
  if (event.fingerprint?.length) return event.fingerprint.join("|");
  const ex = event.exception?.values?.[0];
  if (ex) return `${ex.type ?? "Error"}:${(ex.value ?? "").slice(0, 140)}`;
  return event.message ?? event.transaction ?? "unknown";
}
