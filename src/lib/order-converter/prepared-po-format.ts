/**
 * 준비본 시각 표기 — **클라이언트 안전** 모듈(의존 0).
 *
 * `prepared-po.ts` 에 있던 함수를 떼어 낸 이유: 그 파일은 `naver-order-sync` → 네이버 클라이언트 →
 * bcrypt 까지 끌고 와서 **클라이언트 컴포넌트가 가져오면 번들이 깨진다**(2026-10-23 모바일 발주서 시트
 * 실렌더에서 `Module not found: fs` 로 실측). 서버 쪽은 `prepared-po.ts` 가 여기서 가져다 재수출하므로
 * 호출부는 그대로다. 사람 말 사유 문장(`describePreparedPoUnavailable`)은 서버 상수에 묶여 있어 옮기지
 * 않는다 — 화면은 서버가 응답에 실어 주는 `availability.message` 를 쓴다.
 */

/** ISO → KST `MM/DD HH:MM`. */
export function formatKstShort(iso: string): string {
  const kst = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(kst.getUTCMonth() + 1)}/${p(kst.getUTCDate())} ${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`;
}
