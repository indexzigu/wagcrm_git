import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

/** 값 import(타입 전용 아님) 의 모듈 지정자 목록 — 컴파일러 AST 로 판정. */
export function valueImportSpecifiers(source: string): string[] {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (clause?.isTypeOnly) continue;
    const named = clause?.namedBindings;
    const allTypeOnly =
      clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
    if (allTypeOnly) continue;
    out.push(st.moduleSpecifier.text);
  }
  return out;
}

/** 첫 문장이 "use client" 지시문인가. */
export function isUseClient(source: string): boolean {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const first = sf.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client";
}

/** "use client" 파일이 desktop-dashboard(절대·상대 경로 모두)를 값으로 import 하면 true. */
export function clientImportsDesktopDashboard(source: string): boolean {
  return isUseClient(source) && valueImportSpecifiers(source).some((m) => /(^|\/)desktop-dashboard$/.test(m));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const SERVER_ONLY = /prisma|^node:|^fs$|desktop-dashboard/;

describe("dashboard-scope 클라이언트 안전", () => {
  it("probe: 값 import 만 잡고 type import 는 통과시킨다", () => {
    expect(valueImportSpecifiers('import { A } from "@/lib/desktop-dashboard";')).toEqual(["@/lib/desktop-dashboard"]);
    expect(valueImportSpecifiers('import { A, type B } from "@/lib/desktop-dashboard";')).toEqual(["@/lib/desktop-dashboard"]);
    expect(valueImportSpecifiers('import type { B } from "@/lib/desktop-dashboard";')).toEqual([]);
    expect(valueImportSpecifiers('import { type B } from "@/lib/desktop-dashboard";')).toEqual([]);
  });

  it("probe: use client 파일만 잡고 서버 파일은 통과시킨다", () => {
    const imp = 'import { getDesktopDashboardData } from "@/lib/desktop-dashboard";\n';
    expect(clientImportsDesktopDashboard('"use client";\n' + imp)).toBe(true);
    expect(clientImportsDesktopDashboard('"use client";\nimport { x } from "./desktop-dashboard";\n')).toBe(true);
    expect(clientImportsDesktopDashboard(imp)).toBe(false);
    expect(clientImportsDesktopDashboard('"use client";\nimport type { T } from "@/lib/desktop-dashboard";\n')).toBe(false);
  });

  it("src 의 모든 use client 파일이 desktop-dashboard 를 값으로 import 하지 않는다", () => {
    const offenders = walk(join(ROOT, "src")).filter((f) => !/\.test\.tsx?$/.test(f) && clientImportsDesktopDashboard(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("dashboard-scope.ts 는 서버 모듈을 import 하지 않는다", () => {
    const src = readFileSync(join(ROOT, "src/lib/dashboard-scope.ts"), "utf8");
    expect(valueImportSpecifiers(src).filter((s) => SERVER_ONLY.test(s))).toEqual([]);
  });

  it.each(["src/components/crm/dashboard-home.tsx", "src/components/mobile/mobile-home-view.tsx"])(
    "%s 는 desktop-dashboard 를 값으로 import 하지 않는다",
    (file) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(valueImportSpecifiers(src).filter((s) => /desktop-dashboard/.test(s))).toEqual([]);
    },
  );
});
