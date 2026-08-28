// 데모 모드 SSOT — 외부 시연용 배포(목업 데이터 · 비로그인 열람)의 판별과 상수.
//
// 데모 모드는 "별도 Vercel 프로젝트 + DEMO_MODE=1 + sqlite 목업 DB" 조합으로만
// 운영한다. 실 프로덕션(crm.ygrd.kr)에는 DEMO_MODE를 절대 설정하지 않는다 —
// 만약 실수로 설정되더라도 prisma-client가 postgres 연결을 거부(throw)하므로
// "인증 우회 + 실DB" 조합은 코드 레벨에서 성립하지 않는다.
//
// 이 파일은 edge(middleware)와 node 양쪽에서 import되므로 env 판독 외의
// node 전용 API(fs 등)를 두지 않는다.

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1";
}

/**
 * 클라이언트 컴포넌트용 데모 판별 — NEXT_PUBLIC_ 접두사 env는 빌드 시점에 번들로
 * 인라인된다. 데모 배포는 DEMO_MODE=1과 NEXT_PUBLIC_DEMO_MODE=1을 항상 함께 설정한다
 * (dev:demo·build:demo 스크립트가 두 값을 같이 주입).
 */
export function isClientDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "1";
}

/** 미들웨어가 신뢰 헤더로 심는 데모 열람용 가상 사용자. 쓰기는 미들웨어에서 차단된다. */
export const DEMO_USER = {
  id: "demo-user",
  email: "demo@wagcrm.demo",
  role: "admin",
} as const;

/** 데모 배포에서 쓰기 요청을 거절할 때의 사용자 안내 메시지(토스트에 그대로 노출될 수 있다). */
export const DEMO_READONLY_MESSAGE =
  "데모 모드는 읽기 전용입니다. 변경사항은 저장되지 않습니다.";
