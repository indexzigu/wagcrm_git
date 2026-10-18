import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// `next.config.ts` 가 `cacheComponents: true` 라 라우트 세그먼트 설정(`export const dynamic` 등)은
// 빌드에서 거부된다 — 「Route segment config "dynamic" is not compatible with nextConfig.cacheComponents」.
// 타입 검사·vitest 는 이걸 못 잡고 `next build`(preflight)에서야 터진다(PR #212 실측). 그래서 소스에서 미리 막는다.
// 판정은 주석·문자열에 걸리지 않게 AST 로 한다(최상위 `export const <이름>` 선언만).

const ROOT = join(__dirname, "..", "..");
const APP_DIR = join(ROOT, "src", "app");
const FORBIDDEN = new Set(["dynamic", "revalidate", "fetchCache", "dynamicParams"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : walk(p);
    return /^(route|page|layout)\.tsx?$/.test(name) ? [p] : [];
  });
}

export function forbiddenSegmentExports(source: string, fileName = "x.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && FORBIDDEN.has(d.name.text)) found.push(d.name.text);
    }
  }
  return found;
}

describe("cacheComponents 와 라우트 세그먼트 설정", () => {
  it("next.config 가 cacheComponents 를 켜 두었다(전제 — 꺼지면 이 계약을 재검토)", () => {
    expect(readFileSync(join(ROOT, "next.config.ts"), "utf8")).toMatch(/cacheComponents:\s*true/);
  });

  it("판정기는 최상위 export 만 잡고 주석·문자열은 무시한다(반례 프로브)", () => {
    expect(forbiddenSegmentExports('export const dynamic = "force-dynamic";')).toEqual(["dynamic"]);
    expect(forbiddenSegmentExports('// export const dynamic = "force-dynamic";\nconst s = "export const dynamic";')).toEqual([]);
    expect(forbiddenSegmentExports("const dynamic = 1;")).toEqual([]);
  });

  it("src/app 의 route·page·layout 어디에도 세그먼트 설정 export 가 없다", () => {
    const files = walk(APP_DIR);
    expect(files.length).toBeGreaterThan(10); // 음성 대조 — 스캔이 비면 실패
    const offenders = files
      .map((f) => ({ f: relative(ROOT, f), names: forbiddenSegmentExports(readFileSync(f, "utf8"), f) }))
      .filter((x) => x.names.length > 0)
      .map((x) => `${x.f}: ${x.names.join(", ")}`);
    expect(offenders).toEqual([]);
  });
});
