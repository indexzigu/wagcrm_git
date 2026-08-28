// sentry-tunnel — Sentry 터널 라우트 경로의 단일 SSOT(순수·의존성 0).
//
// 왜 상수로 뽑는가: 이 경로는 `next.config.ts`의 `tunnelRoute`(Sentry SDK가 라우트를 생성)와
// 인증 미들웨어의 제외 목록, **두 곳이 반드시 같은 값**이어야 한다. 한쪽만 바뀌면 증상이
// 조용하다 — 앱은 정상 동작하는데 **프로덕션 에러만 Sentry에 안 올라간다**(2026-07 실사고:
// 미들웨어가 터널 POST를 /login으로 307시켜 405가 났고, 그 때문에 앱 전역 화이트스크린을
// 관측 인프라가 전혀 못 잡았다). 값 동기화는 sentry-tunnel.contract.test.ts가 기계로 강제한다.
//
// next.config.ts에서 import하지 않는 이유: next.config는 빌드 전 Node에서 평가되므로 앱 코드
// import는 번들·해석 리스크가 있다. 대신 계약 테스트가 next.config.ts 소스의 리터럴을 읽어
// 이 상수와 대조한다(런타임 결합 0, 드리프트는 CI에서 차단).
export const SENTRY_TUNNEL_ROUTE = "/monitoring";

/**
 * 요청 경로가 Sentry 터널인지 판정한다.
 * 정확히 일치하거나 하위 경로(`/monitoring/...`)일 때만 true — `startsWith`만 쓰면
 * `/monitoring-something` 같은 무관한 신규 라우트까지 인증에서 열려버린다.
 */
export function isSentryTunnelPath(pathname: string): boolean {
  return (
    pathname === SENTRY_TUNNEL_ROUTE || pathname.startsWith(`${SENTRY_TUNNEL_ROUTE}/`)
  );
}
