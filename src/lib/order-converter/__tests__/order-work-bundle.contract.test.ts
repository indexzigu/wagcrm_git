import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * 계약: 홈 「오늘 처리할 주문」 경로(`/api/order-work`)의 import 그래프에 **네이버 호출 모듈이 없다.**
 *
 * 이 기능의 전제가 「네이버 요청 0건」이다(오너 승인 2026-10-06 — 프록시 하루 요청 수 절약). 런타임
 * 스파이 테스트(order-work-summary.test.ts)는 「지금 안 부른다」만 보므로, 누군가 편의상
 * `naver-order-sync` 에서 날짜 함수 하나를 가져오기만 해도 네이버 클라이언트가 이 라우트 번들에
 * 딸려 들어오는 것은 못 잡는다(실제로 초판의 claim-source-loader 가 그랬다 — 리뷰 C5).
 * 그래서 정적 import(타입 전용 제외)를 따라가 금지 모듈이 하나도 없는지 본다.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const FORBIDDEN = /src\/lib\/order-converter\/(naver-commerce-client|naver-commerce-api|naver-order-sync|fetch-client)\.ts$/;

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(REPO_ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // 패키지
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 진입 파일에서 닿는 파일 → 그 파일을 끌어온 파일. */
function importGraph(entryRel: string): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const stack: Array<[string, string | null]> = [[join(REPO_ROOT, entryRel), null]];
  const IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  while (stack.length > 0) {
    const [file, parent] = stack.pop()!;
    if (seen.has(file)) continue;
    seen.set(file, parent);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const next = resolveSpec(file, match[1] ?? match[2]);
      if (next) stack.push([next, file]);
    }
  }
  return seen;
}

function forbiddenHits(entryRel: string): string[] {
  return [...importGraph(entryRel)]
    .filter(([file]) => FORBIDDEN.test(file))
    .map(([file, parent]) => `${relative(REPO_ROOT, file)} ← ${parent ? relative(REPO_ROOT, parent) : "(진입)"}`);
}

describe("/api/order-work 번들에 네이버 호출 모듈이 없다", () => {
  it.each(["src/app/api/order-work/route.ts", "src/lib/order-converter/order-work-summary.ts"])(
    "%s 의 import 그래프에 naver-commerce-*·naver-order-sync·fetch-client 가 없다",
    (entry) => {
      expect(forbiddenHits(entry)).toEqual([]);
    },
  );

  it("양성 대조군 — 네이버 택배사 조회를 쓰는 클레임 라우트에서는 금지 모듈을 찾아낸다(스캐너 고장 방지)", () => {
    expect(forbiddenHits("src/app/order-converter/api/naver/claims/route.ts").length).toBeGreaterThan(0);
  });
});
