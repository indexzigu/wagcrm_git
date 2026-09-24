import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * **토스트는 `@/lib/toast` 로만 띄운다** — 레포 전역 계약(interfaces 점검 #10, 2026-09-24).
 *
 * `sonner` 를 직접 import 하면 그 파일의 `toast.error` 는 sonner 기본값(4초)으로 사라진다 —
 * 오류 토스트는 복구 방법을 담고 있어 읽기 전에 사라지면 안 된다. 래퍼가 수명 정책을
 * 소유하므로, 래퍼와 `<Toaster>` 정의(`ui/sonner.tsx`) 밖에서 sonner 를 부르면 정책이 새는
 * 구멍이 된다. 또 자체 토스트 훅(종전 `hooks/useToast.ts` — 3.5초·live region 없음·색으로만
 * 종류 구분)이 다시 생기지 않게 막는다.
 *
 * 판정은 TypeScript AST 로 한다 — 주석 속 `from "sonner"`(이 계약을 설명하는 경고문 포함)는
 * 노드가 아니라 잡히지 않고, `import()`·`require()`·`export … from` 도 같은 판정을 탄다.
 */

const SRC = join(__dirname, "..", "..");

/** sonner 를 직접 부를 수 있는 파일 — 이유 없이 늘리지 말 것. */
const ALLOWED = new Set(["lib/toast.ts", "components/ui/sonner.tsx"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "generated") continue;
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * AST 를 만들기 전 싼 거르기 — 수백 파일을 전부 파싱하면 부하가 걸린 머신에서 5초를 넘긴다.
 * ⚠️ 문자열 이스케이프(`"\u0073onner"` · `"\x73onner"`)는 원문에 이름이 안 보이지만 AST 는
 * 같은 지정자로 읽는다 — 이스케이프가 있는 파일도 통과시켜야 거르기가 AST 판정과 등가다.
 */
function mayMention(text: string, name: string): boolean {
  return text.includes(name) || text.includes("\\u") || text.includes("\\x");
}

/** 파일이 불러오는 모듈 지정자 전부(정적·동적·재수출·require). */
function moduleSpecifiers(fileName: string, text: string): string[] {
  if (!mayMention(text, "sonner")) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 이름이 `useToast` 인 함수 선언·변수 선언. */
function declaresUseToast(fileName: string, text: string): boolean {
  if (!mayMention(text, "useToast")) return false;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  let hit = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === "useToast"
    ) {
      hit = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hit;
}

const FILES = sourceFiles(SRC).map((full) => ({
  rel: relative(SRC, full).split("\\").join("/"),
  text: readFileSync(full, "utf8"),
}));

describe("스캐너 자체 — 반증 프로브", () => {
  it("정적·동적·재수출·require 를 모두 잡고 주석은 잡지 않는다", () => {
    const probe = [
      'import { toast } from "sonner";',
      'export { toast } from "sonner";',
      'const lazy = () => import("sonner");',
      'const legacy = require("sonner");',
      '// import { toast } from "sonner"',
      "/* from 'sonner' */",
    ].join("\n");
    expect(moduleSpecifiers("probe.ts", probe)).toEqual(["sonner", "sonner", "sonner", "sonner"]);
  });

  it("거르기가 이스케이프로 쓴 지정자를 놓치지 않는다(AST 판정과 등가)", () => {
    expect(moduleSpecifiers("u.ts", 'import { toast } from "\\u0073onner";')).toEqual(["sonner"]);
    expect(moduleSpecifiers("x.ts", 'import { toast } from "\\x73onner";')).toEqual(["sonner"]);
    expect(declaresUseToast("e.ts", "export function \\u0075seToast() {}")).toBe(true);
  });

  it("useToast 선언을 함수·화살표 둘 다 잡는다", () => {
    expect(declaresUseToast("a.ts", "export function useToast() {}")).toBe(true);
    expect(declaresUseToast("b.ts", "export const useToast = () => {};")).toBe(true);
    expect(declaresUseToast("c.ts", "const x = useToast();")).toBe(false);
  });
});

describe("sonner import 경계", () => {
  it("허용 목록 밖의 파일은 sonner 를 직접 부르지 않는다", () => {
    const offenders = FILES.filter(
      ({ rel, text }) => !ALLOWED.has(rel) && moduleSpecifiers(rel, text).includes("sonner"),
    ).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("허용 목록은 낡지 않았다 — 두 파일 모두 실제로 sonner 를 부른다", () => {
    for (const allowed of ALLOWED) {
      const file = FILES.find(({ rel }) => rel === allowed);
      expect(file, allowed).toBeDefined();
      expect(moduleSpecifiers(allowed, file!.text)).toContain("sonner");
    }
  });

  it("스캔 대상이 실제로 앱 소스다(빈 목록으로 초록이 되지 않게)", () => {
    expect(FILES.filter(({ text }) => text.includes("@/lib/toast")).length).toBeGreaterThan(50);
  });
});

describe("두 번째 토스트 체계 금지", () => {
  it("자체 토스트 훅 파일이 없다", () => {
    expect(existsSync(join(SRC, "hooks", "useToast.ts"))).toBe(false);
  });

  it("어디에도 useToast 를 새로 선언하지 않는다", () => {
    const offenders = FILES.filter(({ rel, text }) => declaresUseToast(rel, text)).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
