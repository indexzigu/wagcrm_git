import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * API 라우트 인증 커버리지 계약.
 *
 * ## 이 레포의 인증은 두 겹인데, 겹의 성격이 다르다
 *
 * 1. **`src/proxy.ts`(Next 16 미들웨어) 세션 게이트** — 이것이 **1차이자 실질적 방어**다.
 *    matcher 가 `/api` 를 포함하므로, 세션 없는 요청은 라우트 핸들러에 **도달하기 전에**
 *    `/login` 으로 307 된다(2026-08-04 실측: `/api/deals/<id>/sellers` · `/api/recampaign-alerts`
 *    둘 다 본문 없는 307). ⚠️ Next 16 은 `middleware.ts` 를 **`proxy.ts` 로 개명**했다 —
 *    "middleware.ts 가 없으니 게이트가 없다"는 오독이 이 계약 테스트가 태어난 계기다.
 * 2. **라우트 핸들러의 `requireAuth`** — 2차 방어(defense-in-depth)이며 전수가 아니다.
 *
 * ## 그래서 이 테스트가 지키는 불변식은 "전 라우트 requireAuth" 가 아니다
 *
 * 진짜 위험은 **1차 방어에서 면제된 경로**다. 면제 목록은
 * `src/lib/supabase/middleware.ts` 의 `if (!user && …)` 게이트에 있고, 거기 걸린 경로에서는
 * **핸들러의 자체 가드가 유일한 인증**이 된다. 그 가드가 빠지거나 느슨하면 즉시 공개 API 다.
 *
 * 실제로 그렇게 갈라져 있었다(2026-08-04 감사 — 상세는 `src/lib/cron-auth.ts` 헤더):
 * 크론 인증이 18개 라우트에 손으로 복사돼 있었고 그중 2건이 **CRON_SECRET 미설정 시 열리는**
 * fail-open 이었다. 이 레포의 반복 교훈 그대로다 — 같은 계약을 손으로 다시 쓰는 호출부는
 * 반드시 갈라진다(`deal-claim-context.contract` · `product-order-range-type.contract` 선례).
 *
 * ## 세 층으로 고정한다
 *
 * - **C1** 면제 판정식이 미들웨어 소스와 동기인가(앵커 대조 — 새 면제가 몰래 늘지 않는다)
 * - **C2** 면제된 **모든** 라우트가 승인된 자체 가드를 갖는가(전수 스캔)
 * - **C3** 크론 인증을 라우트가 다시 손으로 정의하지 않는가(사본 재발 차단)
 *
 * 🪤 앵커 함정: 경로가 틀리거나 스캔이 0건이면 "위반 없음"이 공허 통과한다 —
 * 각 단계에 음성 대조군(하한 개수·앵커 존재)을 먼저 둔다.
 */

const root = process.cwd();
const API_DIR = join(root, "src", "app", "api");
const LIB_DIR = join(root, "src", "lib");
const MIDDLEWARE_FILE = join(root, "src", "lib", "supabase", "middleware.ts");
const PROXY_FILE = join(root, "src", "proxy.ts");
const CRON_AUTH_SSOT = join("src", "lib", "cron-auth.ts");

const read = (p: string) => readFileSync(p, "utf-8");

function walkRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkRouteFiles(full, acc);
    else if (entry === "route.ts" || entry === "route.tsx") acc.push(full);
  }
  return acc;
}

/**
 * `route.ts` 뿐 아니라 **모든** ts/tsx — C3 의 사본 스캔용.
 *
 * 🪤 왜 넓혔나(2026-08-05): 초판 C3 는 `route.ts` 만 봤는데, 인증 로직을 자체 재구현한
 * **테스트 파일**(`src/app/api/cron/__tests__/cron-auth.property.test.ts`)이 그 사각에
 * 그대로 살아 있었다. 프로덕션을 import 하지 않으니 라우트가 어떻게 바뀌든 초록불이었고,
 * fail-open 2건이 있는 동안에도 "크론 인증 테스트 통과"라는 **거짓 신호**를 냈다.
 * 계약 테스트에서 "어디를 안 보는가"가 곧 구멍이다.
 */
function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** `src/app/api/deals/[id]/sellers/route.ts` → `/api/deals/[id]/sellers` (라우트 그룹 `(x)` 제거). */
function toPathname(absFile: string): string {
  const rel = relative(join(root, "src", "app"), absFile);
  const segments = rel
    .split(sep)
    .slice(0, -1) // route.ts 제거
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  return "/" + segments.join("/");
}

/**
 * 미들웨어 세션 게이트의 면제 판정 — `src/lib/supabase/middleware.ts` 의 사본이다.
 * 사본인 것이 의도다: C1 이 원본과의 동기를 앵커로 강제하므로, 원본이 바뀌면 여기도
 * 바꾸도록 **실패로** 유도된다(조용한 드리프트 금지).
 */
const EXEMPT_PREFIXES = ["/api/auth", "/api/cron"] as const;
const EXEMPT_EXACT = [
  "/api/work-records/ingest",
  "/api/chat-room-mappings",
  "/api/chat-room-mappings/unmapped",
  "/api/chat-room-mappings/reconcile",
] as const;

function isSessionExempt(pathname: string): boolean {
  return (
    EXEMPT_PREFIXES.some((p) => pathname.startsWith(p)) ||
    EXEMPT_EXACT.includes(pathname as (typeof EXEMPT_EXACT)[number])
  );
}

/**
 * 면제 라우트별 승인된 자체 가드. 새 면제 라우트를 추가하면 여기에 **의도적으로** 등록해야
 * 하고, 등록 없이는 C2 가 실패한다 — "면제인데 가드가 없다"가 조용히 통과할 길을 없앤다.
 */
type GuardRule = { pattern: RegExp; reason: string };

const GUARD_RULES: GuardRule[] = [
  {
    // 크론·웹훅: 공유 시크릿. SSOT 를 import 해서 **호출**까지 해야 인정한다.
    pattern: /verifyCron(Auth|QuerySecret)\s*\(/,
    reason: "@/lib/cron-auth 의 공유 시크릿 검증",
  },
  {
    pattern: /verifyIngestAuth\s*\(/,
    reason: "@/lib/kakao/ingest-auth 의 INGEST_TOKEN 검증",
  },
  {
    pattern: /requireAuth\s*\(|requireRole\s*\(/,
    reason: "세션 인증",
  },
  {
    pattern: /process\.env\.NODE_ENV\s*!==\s*["']development["']/,
    reason: "개발 환경 전용 게이트",
  },
];

/**
 * 가드가 없어도 되는 면제 라우트의 **명시 예외**. 이유 없이 늘리지 말 것 —
 * 각 항목은 "비인증 호출자에게 아무 일도 일어나지 않음"이 코드로 확인된 것만 등재한다.
 */
const NO_GUARD_ALLOWLIST: Record<string, string> = {
  "/api/auth/signout":
    "세션이 없으면 signOut 을 건너뛰고 로컬 개발 쿠키만 지운 뒤 /login 으로 리다이렉트한다 — " +
    "비인증 호출자에게는 읽기·쓰기가 전혀 일어나지 않는 무연산이다.",
};

const ROUTE_FILES = walkRouteFiles(API_DIR);
const EXEMPT_ROUTES = ROUTE_FILES.filter((f) => isSessionExempt(toPathname(f)));

describe("C0 — 스캔 자체가 살아 있다(음성 대조군)", () => {
  it("API 라우트를 충분히 수집한다", () => {
    // 하한만 고정한다 — 라우트가 늘어도 깨지지 않고, 스캔이 죽으면(0건·경로 오타) 걸린다.
    expect(ROUTE_FILES.length).toBeGreaterThan(100);
  });

  it("면제 라우트가 1건 이상 잡힌다", () => {
    expect(EXEMPT_ROUTES.length).toBeGreaterThan(0);
  });

  it("게이트 대상 라우트가 면제 라우트보다 훨씬 많다(면제가 비정상 확대되지 않았다)", () => {
    const gated = ROUTE_FILES.length - EXEMPT_ROUTES.length;
    expect(gated).toBeGreaterThan(EXEMPT_ROUTES.length * 2);
  });
});

describe("C1 — 면제 판정식이 미들웨어 소스와 동기다", () => {
  const middlewareSrc = read(MIDDLEWARE_FILE);
  const proxySrc = read(PROXY_FILE);

  it("proxy(미들웨어)가 updateSession 을 거친다", () => {
    expect(proxySrc).toContain("updateSession");
  });

  it("proxy matcher 가 /api 를 제외하지 않는다", () => {
    // matcher 는 정적 자산만 제외한다. `api` 가 제외 목록에 들어가면 전 API 가 무방비가 된다.
    const matcher = proxySrc.slice(proxySrc.indexOf("matcher"));
    expect(matcher).not.toMatch(/[?!(|]api[)|/]/);
  });

  it("미들웨어에 세션 게이트 앵커가 존재한다", () => {
    expect(middlewareSrc).toContain("url.pathname = \"/login\"");
    expect(middlewareSrc).toMatch(/if\s*\(\s*\n?\s*!user/);
  });

  for (const prefix of EXEMPT_PREFIXES) {
    it(`prefix 면제 앵커: ${prefix}`, () => {
      expect(middlewareSrc).toContain(`startsWith("${prefix}")`);
    });
  }

  for (const exact of EXEMPT_EXACT) {
    it(`exact 면제 앵커: ${exact}`, () => {
      expect(middlewareSrc).toContain(`!== "${exact}"`);
    });
  }

  it("미들웨어의 /api 면제가 이 파일이 아는 것보다 많지 않다", () => {
    // 게이트 블록 안에서 언급된 모든 `/api…` 리터럴을 뽑아 이 파일의 목록과 대조한다.
    // 새 면제가 추가되면 여기서 먼저 실패해, 그 라우트의 가드를 검토하도록 강제한다.
    const gateStart = middlewareSrc.indexOf("!user &&");
    const gateEnd = middlewareSrc.indexOf("url.pathname = \"/login\"", gateStart);
    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const gateBlock = middlewareSrc.slice(gateStart, gateEnd);
    const mentioned = [...gateBlock.matchAll(/"(\/api[^"]*)"/g)].map((m) => m[1]);
    const known = new Set<string>([...EXEMPT_PREFIXES, ...EXEMPT_EXACT]);
    const unknown = mentioned.filter((p) => !known.has(p));
    expect(unknown, `미들웨어에 새 /api 면제가 생겼다: ${unknown.join(", ")}`).toEqual([]);
  });
});

describe("C2 — 세션 면제 라우트는 전부 자체 가드를 갖는다", () => {
  for (const file of EXEMPT_ROUTES) {
    const pathname = toPathname(file);
    it(`${pathname}`, () => {
      const src = read(file);
      const allowlisted = NO_GUARD_ALLOWLIST[pathname];
      const matched = GUARD_RULES.filter((r) => r.pattern.test(src));

      if (allowlisted) {
        // 예외 등재분은 "가드가 없어도 된다"를 확인만 하고 통과시킨다.
        expect(allowlisted.length).toBeGreaterThan(0);
        return;
      }

      expect(
        matched.length,
        `${pathname} 은 미들웨어 세션 게이트에서 면제되는데 자체 인증 가드가 없다. ` +
          `크론이면 @/lib/cron-auth 의 verifyCronAuth 를, 인제스트면 verifyIngestAuth 를 부르고, ` +
          `의도적으로 공개라면 NO_GUARD_ALLOWLIST 에 사유와 함께 등재할 것.`,
      ).toBeGreaterThan(0);
    });
  }
});

describe("C3 — 크론 인증은 SSOT 하나뿐이다(사본 재발 차단)", () => {
  /** `src/app/api` + `src/lib` 의 모든 ts/tsx (SSOT 자기 자신은 제외). */
  const SHADOW_SCAN_FILES = [...walkTsFiles(API_DIR), ...walkTsFiles(LIB_DIR)].filter(
    (f) => relative(root, f) !== CRON_AUTH_SSOT,
  );

  it("스캔이 살아 있다(음성 대조군)", () => {
    expect(SHADOW_SCAN_FILES.length).toBeGreaterThan(200);
    // SSOT 는 반드시 제외돼야 한다 — 안 그러면 자기 자신을 위반으로 잡아 늘 빨강이 된다.
    expect(SHADOW_SCAN_FILES.some((f) => relative(root, f) === CRON_AUTH_SSOT)).toBe(false);
  });

  it("어떤 파일도 크론 인증 함수를 자체 정의하지 않는다(테스트 파일 포함)", () => {
    const offenders = SHADOW_SCAN_FILES.filter((f) =>
      /(?:function|const)\s+verifyCron(?:Auth|QuerySecret)\b/.test(read(f)),
    ).map((f) => relative(root, f));
    expect(
      offenders,
      `크론 인증을 다시 정의했다(사본은 반드시 갈라진다 — fail-open 2건의 원인). ` +
        `@/lib/cron-auth 를 import 할 것: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("시크릿을 헤더와 대조하는 파일은 전부 SSOT 를 경유한다", () => {
    // "CRON_SECRET 을 알면서 authorization 헤더를 **읽는다**" = 검증자 형태.
    // 헤더를 **보내기만** 하는 호출자(system/cron-run·OAuth 콜백)와, env 를 세팅만 하는
    // 테스트 셋업은 이 모양이 아니라서 걸리지 않는다.
    const offenders = SHADOW_SCAN_FILES.filter((f) => {
      const src = read(f);
      // 주석의 단순 언급이 아니라 **실제 env 읽기**여야 한다 — `kakao/ingest-auth.ts` 는
      // "CRON_SECRET 이 아닌 INGEST_TOKEN 을 쓴다"는 설명에서만 이름을 언급한다.
      const knowsSecret = /process\.env\.CRON_SECRET/.test(src);
      const readsAuthHeader = /headers\s*\.\s*get\(\s*["']authorization["']\s*\)/i.test(src);
      const usesSsot = src.includes("@/lib/cron-auth");
      return knowsSecret && readsAuthHeader && !usesSsot;
    }).map((f) => relative(root, f));
    expect(
      offenders,
      `크론 시크릿 검증을 손으로 재구현한 파일이 있다. 프로덕션 코드를 import 하지 않는 검증은 ` +
        `프로덕션이 바뀌어도 계속 통과해 거짓 신호를 낸다(2026-08-05 실사고): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("어떤 라우트도 CRON_SECRET 을 직접 읽어 비교하지 않는다", () => {
    // 예외: /api/system/cron-run 은 시크릿을 **행사**하는(호출자) 특권 라우트라 읽기가 정당하다.
    const PRIVILEGED = join("src", "app", "api", "system", "cron-run", "route.ts");
    const offenders = ROUTE_FILES.filter((f) => {
      if (relative(root, f) === PRIVILEGED) return false;
      return /process\.env\.CRON_SECRET/.test(read(f));
    }).map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });

  it("모든 크론 라우트가 SSOT 를 import 한다", () => {
    const cronRoutes = ROUTE_FILES.filter((f) =>
      toPathname(f).startsWith("/api/cron"),
    );
    expect(cronRoutes.length).toBeGreaterThan(10); // 음성 대조군
    const missing = cronRoutes
      .filter((f) => !read(f).includes("@/lib/cron-auth"))
      .map((f) => relative(root, f));
    expect(missing).toEqual([]);
  });
});
