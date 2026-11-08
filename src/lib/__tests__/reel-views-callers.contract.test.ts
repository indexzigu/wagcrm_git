// [셀러분석] 릴스 조회수 유료 보강의 호출부 계약 — 오너 확정(2026-11-08): 「분석」 버튼을 눌렀을 때만.
// 크론·자동 트리거가 이 경로를 켜면 월 상한 안에서라도 오너가 고르지 않은 지출이 생긴다.
// 소스 스캔으로 고정한다(선례: instagram-scrape-callers.contract.test.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(process.cwd(), "src");
const ROUTE = "src/app/api/sellers/[id]/analyze/route.ts";

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

const files = listSourceFiles(SRC_DIR).map((f) => ({ rel: relative(process.cwd(), f), src: readFileSync(f, "utf8") }));

describe("릴스 조회수 보강 호출부", () => {
  it("apifyReelViews 를 import 하는 곳은 scraper 뿐이다", () => {
    const importers = files
      .filter((f) => /from\s+["'][^"']*apifyReelViews["']/.test(f.src))
      .map((f) => f.rel);
    expect(importers).toEqual(["src/lib/seller-analysis/scraper.ts"]);
  });

  it("scraper 는 옵션이 정확히 true 일 때만 보강한다(기본 꺼짐)", () => {
    const src = files.find((f) => f.rel === "src/lib/seller-analysis/scraper.ts")!.src;
    expect(src).toMatch(/if \(options\.enrichReelViews === true\) await enrichTier0ReelViews\(data\)/);
    expect(src).toMatch(/options: WaterfallOptions = \{\}/);
  });

  it("scrapeSellerDataWaterfall 를 enrichReelViews 와 함께 부르는 곳은 분석 라우트뿐이고, 쿼리 opt-in 으로만 켠다", () => {
    const callers = files
      .filter((f) => /scrapeSellerDataWaterfall\(/.test(f.src) && f.rel !== "src/lib/seller-analysis/scraper.ts")
      .map((f) => f.rel);
    expect(callers).toEqual([ROUTE]);
    const route = files.find((f) => f.rel === ROUTE)!.src;
    expect(route).toMatch(/enrichReelViews: wantsReelViews\(request\)/);
    expect(route).toMatch(/searchParams\.get\(REEL_VIEWS_QUERY_PARAM\) === "1"/);
  });

  it("크론 라우트·수집기는 스크래퍼도 분석 라우트도 부르지 않는다", () => {
    const cronish = files.filter((f) => f.rel.startsWith("src/app/api/cron/") || f.rel.startsWith("src/lib/collectors/"));
    expect(cronish.length).toBeGreaterThan(0);
    for (const f of cronish) {
      expect(/seller-analysis\/scraper|apifyReelViews/.test(f.src), f.rel).toBe(false);
      expect(/\/api\/sellers\/[^"'`]*\/analyze/.test(f.src), f.rel).toBe(false);
    }
  });

  it("reelViews=1 을 붙이는 클라이언트는 분석 버튼 2곳뿐이다(신규 등록 자동 분석은 붙이지 않는다)", () => {
    const optIn = files.filter((f) => /\/analyze\?reelViews=1/.test(f.src)).map((f) => f.rel).sort();
    expect(optIn).toEqual([
      "src/components/crm/seller-analysis/SellerAiAnalysis.tsx",
      "src/components/crm/sellers-management.tsx",
    ]);
    const creation = files.find((f) => f.rel === "src/components/crm/seller-creation-form.tsx")!.src;
    expect(creation).toMatch(/\/api\/sellers\/\$\{created\.id\}\/analyze`/);
  });
});
