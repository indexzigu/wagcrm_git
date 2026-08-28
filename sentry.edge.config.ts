import * as Sentry from "@sentry/nextjs";

import { allowSentryEvent, eventFingerprint } from "@/lib/sentry-throttle";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseProject = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] || "unknown";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Performance Monitoring
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // 프로덕션에서만 전송. NEXT_PUBLIC_SENTRY_DSN이 .env에 상주하므로 이전 조건
  // (|| !!DSN)은 로컬 dev·워크트리 실행 에러까지 Sentry로 흘려보내(이슈에
  // /Users/... · .claude/worktrees/... 경로 유입) replay/errors quota를 태웠다.
  enabled: process.env.NODE_ENV === "production",

  // Attach Supabase Project ID for fault tracking across environments
  initialScope: {
    tags: {
      supabase_project: supabaseProject,
    },
  },

  // 동일 에러 무한반복으로 인한 quota 소진 방지 — 서명별/전체 분당 상한 초과 시 드롭.
  beforeSend(event) {
    return allowSentryEvent(eventFingerprint(event)) ? event : null;
  },
});
