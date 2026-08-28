// IG/외부 스크래핑 유료 경로 호출자 계약 테스트 (오너 외부 API 최소화 원칙, 2026-07-11).
// 유료·쿼터 소모 경로(Apify·RapidAPI)의 "직접" 호출자는 아래 화이트리스트 파일로 한정한다.
// 새 수집 기능이 무료 경로(Graph Tier0·embed 프록시)를 두고 유료 경로를 조용히 추가하면
// 이 테스트가 깨진다 — 추가가 정당하면 사유와 함께 화이트리스트를 갱신할 것(리뷰 지점 강제).
// 선례: mobile-breakpoint-contract(디렉터리 스캔) · RESERVED_PORTAL_SLUGS(등록 강제).
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(process.cwd(), "src");

// 유료 경로 신호 — import 경유(게이트웨이 모듈)와 직접 HTTP(호스트 리터럴) 둘 다 잡는다.
const PAID_SIGNALS: { name: string; pattern: RegExp }[] = [
  { name: "seller-analysis/scraper import(Apify·RapidAPI 워터폴)", pattern: /from\s+["'][^"']*seller-analysis\/scraper["']/ },
  { name: "seller-analysis/apify import", pattern: /from\s+["'][^"']*seller-analysis\/apify["']/ },
  { name: "apifyComments import", pattern: /from\s+["'][^"']*apifyComments["']/ },
  { name: "api.apify.com 직접 호출", pattern: /api\.apify\.com/ },
  { name: "rapidapi.com 직접 호출", pattern: /\.rapidapi\.com/ },
  // 키 풀 게이트웨이(2026-07-23) — 이걸 import 하면 유료 쿼터를 태우는 새 호출자다.
  { name: "rapidapi-keys import(키 풀·로테이션 게이트웨이)", pattern: /from\s+["'][^"']*rapidapi-keys["']/ },
];

// 허용된 직접 호출자(2026-07-11 인벤토리). 간접 호출은 이 게이트웨이들을 경유해야 한다.
const ALLOWED_CALLERS = new Set([
  // 게이트웨이/구현체 자신
  "src/lib/seller-analysis/scraper.ts",
  "src/lib/seller-analysis/apify.ts",
  "src/lib/seller-analysis/apifyComments.ts",
  "src/lib/rapidapi-keys.ts", // 키 풀·로테이션 게이트웨이 자신(호스트 리터럴은 없고 URL 에서 파생)
  "src/lib/reference-enrich-proxy.ts", // rapidApiFetch 재사용 + /userinfo(프로필 보강, 쿼터 공유)
  // 셀러 분석 워터폴(Tier0 실패 시 유료 폴백 — 스펙 §12′ 승인 경로)
  "src/app/api/sellers/[id]/analyze/route.ts",
  // 채널 정보 보강(Apify 액터 run·RapidAPI 폴백 — 기존 승인 경로)
  "src/app/api/sellers/[id]/channel-info/route.ts",
  "src/app/api/sellers/[id]/channel-info/poll/route.ts",
  // 유튜브 수집(Apify 전용 — 인스타 아님)
  "src/lib/collectors/youtube-collector.ts",
  "src/app/api/cron/apify-webhook/youtube/route.ts",
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("instagram/외부 스크래핑 유료 경로 호출자 계약", () => {
  const files = listSourceFiles(SRC_DIR);

  it("src 전체를 스캔한다(스캐너 자체 회귀 가드)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("유료 경로(Apify·RapidAPI) 직접 호출자는 화이트리스트에 등록된 파일뿐이다", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(process.cwd(), file);
      if (ALLOWED_CALLERS.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const { name, pattern } of PAID_SIGNALS) {
        if (pattern.test(source)) violations.push(`${rel} → ${name}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("화이트리스트는 실존 파일만 담는다(이동·삭제 시 목록 청소 강제)", () => {
    for (const rel of ALLOWED_CALLERS) {
      expect(() => readFileSync(join(process.cwd(), rel)), rel).not.toThrow();
    }
  });

  it("캠페인 게시물 반응 지표 수집기는 무료 경로(Graph Tier0)만 쓴다", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/collectors/campaign-engagement-collector.ts"),
      "utf8",
    );
    expect(source).toContain("scrapeTier0");
    for (const { name, pattern } of PAID_SIGNALS) {
      expect(pattern.test(source), name).toBe(false);
    }
  });
});
