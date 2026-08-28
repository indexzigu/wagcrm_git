// 감시 셀러 자동수집의 주기 규약 SSOT — "수집 대상(isMonitored)인 셀러는 마지막 갱신에서
// N일(기본 7)이 지나면 수집한다".
//
// 배경(2026-07-30): 이 규칙 자체는 예전부터 수집기 3종에 각각 복제돼 있었는데, 크론이
// 주 1회(월 03:00 UTC)만 발화해서 사실상 죽어 있었다 — 월요일 시점에 6일밖에 안 지난
// 셀러는 게이트에 걸려 스킵되고 다음 기회가 7일 뒤라 실효 주기가 14일이 됐고, 실패분과
// 데드라인 이월분(ENGAGEMENT_BUDGET_MS)도 일주일을 기다렸다. 오너 체감은 "자동수집이
// 될 때도 있고 안 될 때도 있다"였다. 크론을 매일로 바꾸면서(vercel.json) 이 cutoff가
// **유일한 판정자**가 됐으므로, 4곳에 흩어져 있던 사본을 여기로 모은다.
//
// ⚠️ 소비처(수집기 3종 + 시스템 레이더 건강도)는 반드시 같은 cutoff를 써야 한다 —
// 레이더가 "최근 7일 내 갱신됨"으로 세는 기준과 수집기가 "7일 지났나"로 거르는 기준이
// 어긋나면 건강도가 영구 미달로 보이거나(거짓 경보) 영구 만점으로 보인다(거짓 안심).

/** env 미설정·오설정 시 쓰는 기본 주기(일). */
export const DEFAULT_COLLECT_INTERVAL_DAYS = 7;

/**
 * 수집 주기(일). `FOLLOWERS_SYNC_INTERVAL_DAYS`로 조정한다.
 *
 * 양의 정수가 아니면 기본값으로 되돌리고 사유를 로그로 남긴다(P0 No Silent Failure).
 * 예전 구현(`parseInt(env || "7", 10)`)은 오설정 시 NaN을 그대로 흘려보냈고, cutoff가
 * Invalid Date가 되면 모든 `snapshotDate > cutoff` 비교가 false여서 **전 셀러를 매 회차
 * 재수집**했다 — 주 1회 시절엔 눈에 안 띄었지만 매일 발화에서는 7배의 유료 호출이 된다.
 *
 * 파싱은 **엄격**하다(`^\d+$`). `parseInt`의 선행 파싱은 `"7일"`·`"7 days"`를 조용히 7로
 * 받아들이는데, 값이 우연히 맞아도 "설정이 파싱되고 있다"는 잘못된 확신을 남긴다 —
 * 오설정은 값이 같더라도 경고로 보이는 편이 낫다.
 */
export function getCollectIntervalDays(): number {
  const raw = process.env.FOLLOWERS_SYNC_INTERVAL_DAYS?.trim();
  if (!raw) return DEFAULT_COLLECT_INTERVAL_DAYS;

  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(
      `[collect-cycle] FOLLOWERS_SYNC_INTERVAL_DAYS=${JSON.stringify(raw)} 는 양의 정수가 아닙니다 — 기본 ${DEFAULT_COLLECT_INTERVAL_DAYS}일로 진행합니다.`
    );
    return DEFAULT_COLLECT_INTERVAL_DAYS;
  }
  return parsed;
}

/**
 * 재수집 판정 기준선. `SellersHistory.snapshotDate > cutoff` 면 "아직 신선함"(스킵),
 * 아니면 "갱신일이 N일 지남"(수집 대상)이다.
 */
export function getCollectCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - getCollectIntervalDays());
  return cutoff;
}
