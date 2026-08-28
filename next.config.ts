import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
/**
 * 홈택스 건별발급 로컬 헬퍼(오너 Mac 의 127.0.0.1:9410)로의 fetch 를 허용한다.
 * ⚠️ 이것이 없으면 `connect-src 'self' https:` 가 loopback 연결을 차단해, 헬퍼가
 * 켜져 있어도 "연결할 수 없습니다"만 뜬다(2026-08-05 실렌더 QA 에서 실측 — 콘솔에
 * CSP 위반이 찍혔다). 허용 범위는 **이 포트 하나**이고 여전히 로컬 주소뿐이라,
 * 외부 오리진으로 데이터가 나갈 수 있는 구멍이 아니다.
 * 헬퍼 포트를 바꾸면(`NEXT_PUBLIC_HOMETAX_HELPER_URL`) 여기도 함께 바꿔야 한다 —
 * CSP 는 빌드 타임 정적 문자열이라 런타임 env 를 읽지 못한다.
 */
const HOMETAX_HELPER_ORIGINS = "http://127.0.0.1:9410 http://localhost:9410";
const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : ""} https:;
  style-src 'self' 'unsafe-inline' https:;
  img-src 'self' blob: data: https:;
  font-src 'self' data: https:;
  connect-src 'self' https: ${HOMETAX_HELPER_ORIGINS};
  frame-src 'self' https:;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  upgrade-insecure-requests;
`.replace(/\s{2,}/g, " ").trim();

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: cspHeader,
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-DNS-Prefetch-Control",
    value: "on",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost:3000", "192.168.36.121", "192.168.36.121:3000"],
  // 스토리 수집(story-viewer-fetch)이 헤드리스 크로미움을 서버에서 띄운다. 이 둘은 네이티브
  // 바이너리를 포함하므로 번들 대상에서 제외하고 node_modules 에서 런타임 로드해야 Vercel
  // 서버리스에서 크로미움 실행 경로가 살아있다.
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],
  turbopack: {
    // 공유 워크트리(.claude/worktrees/*)에서는 node_modules가 메인 저장소 심링크라
    // 루트를 메인 저장소로 상향해야 빌드/dev가 동작한다(그 외 환경은 기존 cwd 유지).
    root: process.cwd().match(/^(.*)\/\.claude\/worktrees\/[^/]+$/)?.[1] ?? process.cwd(),
  },
  // /api/assistant는 knowledge/(에이전트 런타임 지식)를 fs.readFile로 읽는다.
  // turbopack 트레이싱이 현재는 자동 포함하지만(2026-07-06 nft 트레이스 검증),
  // 리터럴 경로가 계산식으로 리팩터링되면 조용히 누락될 수 있어 명시적으로 고정한다.
  outputFileTracingIncludes: {
    // 데모 배포(DEMO_MODE=1 빌드): 시드된 sqlite 목업 DB와 생성된 sqlite 클라이언트
    // (쿼리 엔진 바이너리 포함)를 모든 함수 번들에 동봉한다 — 없으면 런타임에서
    // 파일을 못 찾아 전 라우트가 죽는다. 실 프로덕션 빌드에는 아예 넣지 않는다.
    ...(process.env.DEMO_MODE === "1"
      ? {
          "/**": [
            "./prisma/demo.db",
            "./prisma/generated/prisma-sqlite/**/*",
          ],
        }
      : {}),
    "/api/assistant": ["./knowledge/**/*"],
    // 스토리 수집 라우트는 서버에서 헤드리스 크로미움을 띄운다. serverExternalPackages 로
    // 외부화하면 JS는 로드되지만 playwright-core 의 데이터 파일(browsers.json)과
    // @sparticuz/chromium 의 바이너리가 nft 트레이싱에서 누락돼 Lambda 에서
    // "Cannot find module .../playwright-core/browsers.json" 런타임 실패(2026-07-10 prod 실측).
    // 두 패키지 전체를 명시 포함해 실행 파일·데이터가 Lambda 에 함께 실리게 한다.
    "/api/cron/capture-stories": [
      "./node_modules/playwright-core/**/*",
      "./node_modules/@sparticuz/chromium/**/*",
    ],
    "/api/stories/collect": [
      "./node_modules/playwright-core/**/*",
      "./node_modules/@sparticuz/chromium/**/*",
    ],
  },
  cacheComponents: true,
  // 정적 생성(=ISR 표면의 빌드 타임 초기 렌더)이 실패하면 기본값은 재시도 0 —
  // 페이지 하나가 넘어지면 배포 전체가 죽는다. CRM_CACHE_SURFACES 9곳은 설계상
  // 빌드 때 Prisma 로 실 DB 를 읽으므로(ISR 의 정의), Supabase 풀러가 몇 초만
  // 흔들려도 무관한 커밋의 배포가 통째로 실패한다 — 2026-07-22 프로덕션 실사고:
  // 3분 간격 재배포 4건 중 가운데 2건이 P1001(Can't reach database server)로
  // 실패했고, 실패 지점이 /assets/archive 와
  // /admin/integrations/meta/review-checklist 로 **서로 달랐다**(결정론적 코드
  // 결함이면 같은 곳에서 멈춘다 = 외부 요인의 서명). 앞뒤 커밋은 성공했다.
  // 이 표면들을 동적으로 바꾸는 건 답이 아니다 — ISR 캐시를 버리는 것이라
  // egress·Fluid CPU 를 되돌리고 cache-policy.ts(SSOT)와도 충돌한다.
  // 재시도는 순간 장애를 흡수할 뿐 장기 DB 장애를 가리지 않는다(그 경우 여전히
  // 빌드가 실패한다) — 가려서는 안 되는 실패는 그대로 실패하게 둔다.
  experimental: {
    staticGenerationRetryCount: 2,
  },
  cacheLife: {
    // 값은 src/lib/cache-policy.ts CRM_CACHE_LIFE(SSOT)와 동기 유지 — 2026-07-10 이벤트 기반 전환
    crmHot: {
      stale: 30,
      revalidate: 300,
      expire: 3600,
    },
    crmWarm: {
      stale: 300,
      revalidate: 3600,
      expire: 86400,
    },
    crmReport: {
      stale: 900,
      revalidate: 3600,
      expire: 86400,
    },
    crmStatic: {
      stale: 300,
      revalidate: 2_592_000,
      expire: 31_536_000,
    },
  },
  // self-host Docker 빌드 전용 — Vercel 빌드는 BUILD_STANDALONE 미설정이라 기존 경로 유지
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

// Sentry 환경 변수가 존재하는 경우에만 Sentry 빌드 설정을 동적으로 로드 및 적용
const hasSentryConfig =
  !!process.env.SENTRY_ORG &&
  !!process.env.SENTRY_PROJECT &&
  !!process.env.SENTRY_AUTH_TOKEN;

let finalConfig = nextConfig;

if (hasSentryConfig) {
  try {
     
    const { withSentryConfig } = require("@sentry/nextjs");
    finalConfig = withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,

      // Only print logs for uploading source maps in CI
      silent: !process.env.CI,

      // Upload source maps for better stack traces
      authToken: process.env.SENTRY_AUTH_TOKEN,

      // Tunnel Sentry events to avoid ad-blockers
      tunnelRoute: "/monitoring",
    });
  } catch (err) {
    console.warn("Sentry configuration load failed:", err);
  }
}

export default finalConfig;
