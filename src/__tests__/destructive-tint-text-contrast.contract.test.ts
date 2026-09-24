import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * **빨강 틴트 배경 위에 기본 빨강 글자(`text-destructive`)를 두지 않는다** — 앱 전역 계약.
 *
 * `--destructive`(#BF5050)는 흰 바탕에서 4.69:1 로 겨우 넘지만, 자기 틴트(`bg-destructive/10`)
 * 위에서는 4.11:1 로 본문 기준(4.5:1)에 못 미친다. 틴트가 진할수록 더 떨어진다. 이 조합은
 * 오류 문구 박스에 반복해서 쓰였다 — 공용 부품(`button`·`badge`)은 묶음 B 에서
 * `text-status-urgent-text`(#8F3C3C, 같은 틴트 위 6.39:1)로 바꿨고 그 계약은
 * `primitive-a11y.contract.test.ts` 가 지킨다. 이 파일은 **소비처**에 남은 사본을 막는다
 * (interfaces 점검 #4 후속, 2026-09-24 — 카톡 업로드 오류 박스 2곳이 마지막 잔존).
 *
 * 판정 범위: 한 문자열 안에 **변형 접두사 없는** `bg-destructive/<N>` 과 `text-destructive` 가
 * 함께 있는 경우. `hover:bg-destructive/10 hover:text-destructive` 같은 상태 변형은 잠깐
 * 나타나는 강조라 이 계약의 대상이 아니다(별도 판단). 주석은 AST 노드가 아니라 잡히지 않는다.
 */

const SRC = join(__dirname, "..");

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

/** 한 클래스 문자열이 금지 조합을 담는가(변형 접두사 없는 토큰끼리만). */
function hasLowContrastPair(classes: string): boolean {
  const tokens = classes.split(/\s+/);
  const tintBg = tokens.some((token) => /^bg-destructive\/\d+$/.test(token));
  const plainText = tokens.includes("text-destructive");
  return tintBg && plainText;
}

/** 파일의 문자열·템플릿 조각 가운데 금지 조합을 담은 것. */
function offendingLiterals(fileName: string, text: string): string[] {
  // 싼 거르기 — 이스케이프(`\u`)로 쓴 클래스는 원문에 이름이 안 보이므로 그 파일도 통과시킨다.
  if (!text.includes("bg-destructive/") && !text.includes("\\u")) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      hasLowContrastPair(node.text)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("판정기 자체 — 반증 프로브", () => {
  it("변형 없는 틴트 배경 + 기본 빨강 글자를 잡는다", () => {
    expect(hasLowContrastPair("rounded-lg bg-destructive/10 px-3 text-xs text-destructive")).toBe(true);
    expect(hasLowContrastPair("bg-destructive/5 text-destructive")).toBe(true);
  });

  it("안전한 토큰·상태 변형·흰 바탕 빨강 글자는 잡지 않는다", () => {
    expect(hasLowContrastPair("bg-destructive/10 text-status-urgent-text")).toBe(false);
    expect(hasLowContrastPair("hover:bg-destructive/10 hover:text-destructive")).toBe(false);
    expect(hasLowContrastPair("text-destructive")).toBe(false);
  });

  it("AST 로 문자열만 읽는다 — 주석은 잡지 않고 이스케이프 문자열은 잡는다", () => {
    const probe = [
      '// "bg-destructive/10 text-destructive"',
      'const a = "bg-destructive/10 text-destructive";',
      "const b = `x ${y} bg-destructive/10 text-destructive`;",
      'const c = "bg-\\u0064estructive/10 text-destructive";',
    ].join("\n");
    expect(offendingLiterals("probe.tsx", probe)).toHaveLength(3);
  });

  it("싼 거르기가 이스케이프만 쓴 파일을 놓치지 않는다(AST 판정과 등가)", () => {
    expect(offendingLiterals("escaped.tsx", 'const c = "bg-\\u0064estructive/10 text-destructive";')).toHaveLength(1);
  });
});

describe("앱 전역 — 빨강 틴트 위 기본 빨강 글자 금지", () => {
  const files = sourceFiles(SRC).map((full) => ({
    rel: relative(SRC, full).split("\\").join("/"),
    text: readFileSync(full, "utf8"),
  }));

  it("스캔 대상이 실제로 앱 소스다(빈 목록으로 초록이 되지 않게)", () => {
    expect(files.filter(({ text }) => text.includes("bg-destructive/")).length).toBeGreaterThan(5);
  });

  it("금지 조합이 없다", () => {
    const offenders = files.flatMap(({ rel, text }) =>
      offendingLiterals(rel, text).map((literal) => `${rel}: ${literal.trim().slice(0, 80)}`),
    );
    expect(offenders).toEqual([]);
  });
});
