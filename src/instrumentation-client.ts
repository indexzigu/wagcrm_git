import * as Sentry from "@sentry/nextjs";

import { allowSentryEvent, eventFingerprint } from "@/lib/sentry-throttle";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Capture 100% in dev, 5% in production
  // 운영자 1인 내부 도구라 트랜잭션 절대량이 적다 — Sentry ingest 429(quota/rate
  // limit) 재발을 막으려 프로덕션 샘플링을 0.1 → 0.05로 낮춘다.
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.05,

  // Session Replay 미사용 — Developer 플랜의 replay 포함량이 월 50개뿐이라
  // ingest 429(replay quota 소진, /monitoring 터널)의 직접 원인이었다. 1인 내부
  // 도구에서 세션 재현 가치는 낮고 오너가 직접 재현 가능하므로, replay integration을
  // 제거해 replay quota를 아예 건드리지 않는다. Errors·Spans 모니터링만 유지한다.

  // 프로덕션에서만 전송. NEXT_PUBLIC_SENTRY_DSN이 .env에 상주하므로 이전 조건
  // (|| !!DSN)은 로컬 dev·워크트리 실행 에러까지 Sentry로 흘려보내(이슈에
  // /Users/... · .claude/worktrees/... 경로 유입) replay/errors quota를 태웠다.
  enabled: process.env.NODE_ENV === "production",

  // Filter out noisy errors
  ignoreErrors: [
    "ResizeObserver loop",
    "Failed to fetch",
    "NetworkError",
    "Load failed",
  ],

  // 동일 에러 무한반복으로 인한 quota 소진 방지 — 서명별/전체 분당 상한 초과 시 드롭.
  beforeSend(event) {
    return allowSentryEvent(eventFingerprint(event)) ? event : null;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
