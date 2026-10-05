// 전년도 신고 수치의 **소스 재유입 차단** 계약 (P0 Public Repo Data Guard, 2026-10-05).
//
// 배경: `pnl-report.ts` 가 소득세·부가세 **실제 신고 수치**를 상수로 들고 있었다. 이 레포는
// 공개라 push 순간 밖으로 나가고, 지운 뒤에도 이력에 남는다. 오너 규칙은 「DB 에 속하는
// 데이터는 레포에 두지 않는다」 — 그 값은 이제 DB 에서 읽는다(`prior-year-tax-reference.ts`).
//
// 이 계약은 같은 필드에 **숫자 리터럴이 다시 대입되는 것**을 막는다. 값이 무엇인지는 알 수
// 없으므로(알면 그 자체가 유출이다) 「이 이름의 필드에 숫자를 직접 적었는가」로 판정한다.
//
// **왜 AST 인가:** 이 레포의 소스 스캔 계약은 정규식으로 반복해 뚫렸다 — 주석 속 인용이
// 자기 자신을 위반으로 잡고, `1_000` 같은 구분자·여러 줄 수식·문자열 키를 놓친다.
// `NumericLiteral` 노드는 주석을 갖지 않고 구분자를 해석한 값을 준다.
//
// ⛔ 위반이 나면 **이 목록에 예외를 추가하지 말고 값을 DB 로 옮길 것.** 테스트 픽스처는
// 스캔 대상이 아니니(아래 `isTestFile`) 가짜 수는 테스트에 적으면 된다.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 스캔 대상 트리. `scripts`·`e2e` 도 본다 — 시드·백필 스크립트가 "한 번만 넣자"로 같은
 * 수치를 다시 적는 것이 가장 그럴듯한 재유입 경로다.
 */
const SCAN_ROOTS = ["src", "scripts", "e2e"] as const;

/**
 * 원자료(신고 금액) 필드 — **0 이 아닌 숫자 리터럴이 하나라도** 있으면 위반.
 * 0 은 초기값·손실 처리로 정당하게 쓰인다(`taxableIncome: 0`).
 */
const AMOUNT_FIELDS = new Set([
  "totalIncome",
  "deductions",
  "taxableIncome",
  "calculatedTax",
  "finalDeterminedTax",
  "taxableSales",
  "payableVat",
  "vatAnnualTaxableSales",
]);

/**
 * 파생(비율·평균) 필드 — 계산식의 작은 상수(`* 100`, `/ 6`)는 정당하므로
 * **`LARGE_LITERAL` 이상인 리터럴만** 위반으로 본다. 종전 상수는 이 필드들에
 * `실수치 / 실수치 * 100` 을 적어 원자료를 한 번 더 노출했다.
 */
const DERIVED_FIELDS = new Set([
  "effectiveTaxRate",
  "firstHalfSalesRatio",
  "secondHalfSalesRatio",
  "firstHalfMonthlyAverage",
  "secondHalfMonthlyAverage",
]);

const LARGE_LITERAL = 1_000;

const ALL_FIELDS = [...AMOUNT_FIELDS, ...DERIVED_FIELDS];

/** 전수 AST 스캔 항목의 시간 예산(선례: `resident-number-exposure.contract.test.ts`). */
const REPO_SCAN_TIMEOUT_MS = 30_000;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx|js|mjs)$/.test(rel)) out.push(rel);
  }
  return out;
}

/** 테스트·픽스처의 수는 판정이 아니라 데이터다(가짜 수를 적는 자리). */
function isTestFile(rel: string): boolean {
  return (
    rel.includes("/__tests__/") ||
    rel.startsWith("e2e/fixtures/") ||
    /\.(test|spec)\.(ts|tsx)$/.test(rel)
  );
}

/**
 * 파싱할 가치가 있는 파일인가 — 필드 이름이 한 번도 안 나오면 건너뛴다.
 * 🪤 유니코드 이스케이프(`totalIncome`)는 문자열 검색을 빠져나가므로, `\u` 가
 * 있으면 이름이 없어 보여도 파싱한다(식별자 `.text` 는 이스케이프를 해석한 값이다).
 */
function mayMention(text: string): boolean {
  return text.includes("\\u") || ALL_FIELDS.some((name) => text.includes(name));
}

function nameOf(node: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) {
    return node.expression.text;
  }
  return null;
}

/** 이 식 안에 문턱 이상의 숫자 리터럴이 있는가. */
function hasNumericLiteral(expr: ts.Node, atLeast: number): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isNumericLiteral(node)) {
      const value = Math.abs(Number(node.text));
      if (value !== 0 && value >= atLeast) found = true;
      return;
    }
    // BigInt(`123n`)로 적어 빠져나가는 형태도 같은 유출이다.
    if (ts.isBigIntLiteral(node)) {
      const value = Number(node.text.replace(/n$/, ""));
      if (value !== 0 && value >= atLeast) found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * 이 소스에서 「신고 수치 필드에 숫자 리터럴을 직접 적은 자리」를 찾는다.
 *
 * 🪤 **파일 읽기와 분리해 `ts.SourceFile` 을 받는다** — 아래 프로브가 **진짜 이 함수**를
 * 타야 하기 때문이다(인라인 재구현 프로브는 스캐너가 죽어도 초록이다).
 *
 * 보고는 **줄 번호와 필드 이름만** 한다 — 값을 실으면 실패 로그가 유출 경로가 된다.
 */
function findFiledFigureLiterals(source: ts.SourceFile): string[] {
  const hits: string[] = [];

  const check = (name: string | null, initializer: ts.Expression | undefined, at: ts.Node) => {
    if (!name || !initializer) return;
    const threshold = AMOUNT_FIELDS.has(name)
      ? 0
      : DERIVED_FIELDS.has(name)
        ? LARGE_LITERAL
        : null;
    if (threshold === null) return;
    if (!hasNumericLiteral(initializer, threshold)) return;
    const { line } = source.getLineAndCharacterOfPosition(at.getStart(source));
    hits.push(`${line + 1}:${name}`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      check(nameOf(node.name), node.initializer, node);
    } else if (ts.isVariableDeclaration(node)) {
      // `const totalIncome = …; return { totalIncome }` 로 돌아가는 형태.
      check(nameOf(node.name), node.initializer, node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      // `reference.totalIncome = …`
      check(node.left.name.text, node.right, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function parse(rel: string, text: string): ts.SourceFile {
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

const probe = (text: string) => findFiledFigureLiterals(parse("probe.ts", text));

describe("전년도 신고 수치는 소스에 없다", () => {
  const files = SCAN_ROOTS.flatMap((root) => sourceFiles(root)).filter(
    (rel) => !isTestFile(rel),
  );

  it("제품 코드 전체를 스캔한다(스캐너 자체 회귀 가드)", () => {
    expect(files.length).toBeGreaterThan(200);
    // 원래 수치가 있던 파일과 지금 읽기 경로가 스캔 범위에 들어 있어야 한다.
    expect(files).toContain("src/lib/pnl-report.ts");
    expect(files).toContain("src/lib/prior-year-tax-reference.ts");
  });

  it(
    "신고 수치 필드에 숫자 리터럴을 적은 제품 코드가 없다",
    () => {
      const violations: string[] = [];
      for (const rel of files) {
        const text = readFileSync(join(process.cwd(), rel), "utf8");
        if (!mayMention(text)) continue;
        for (const hit of findFiledFigureLiterals(parse(rel, text))) {
          violations.push(`${rel}:${hit}`);
        }
      }
      expect(
        violations,
        `신고 수치는 DB 에 둔다(prior-year-tax-reference.ts) — 소스에 적지 말 것:\n${violations.join("\n")}`,
      ).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  describe("스캐너 프로브 — 진짜 스캐너를 탄다", () => {
    it("종전 상수의 형태를 잡는다(가짜 수)", () => {
      const hits = probe(`
        const REFERENCE = {
          incomeYear: 2000,
          totalIncome: 1_000,
          taxableIncome: 900,
          finalDeterminedTax: 90,
          effectiveTaxRate: 9_000 / 90_000 * 100,
          vatHalfYears: [{ periodLabel: "상반기", taxableSales: 600, payableVat: 60 }],
          firstHalfMonthlyAverage: 6_000 / 6,
        };
      `);
      expect(hits.map((hit) => hit.split(":")[1])).toEqual([
        "totalIncome",
        "taxableIncome",
        "finalDeterminedTax",
        "effectiveTaxRate",
        "taxableSales",
        "payableVat",
        "firstHalfMonthlyAverage",
      ]);
    });

    it("형태를 바꿔도 잡는다 — 문자열 키·음수·변수·대입·BigInt·이스케이프", () => {
      expect(probe(`const a = { "totalIncome": 1_000 };`)).toHaveLength(1);
      expect(probe(`const a = { ["deductions"]: 100 };`)).toHaveLength(1);
      expect(probe(`const a = { calculatedTax: -(50) };`)).toHaveLength(1);
      expect(probe(`const payableVat = 60; export const a = { payableVat };`)).toHaveLength(1);
      expect(probe(`reference.vatAnnualTaxableSales = 2_400;`)).toHaveLength(1);
      expect(probe(`const a = { taxableSales: 600n };`)).toHaveLength(1);
      expect(probe(`const a = { \\u0074otalIncome: 1_000 };`)).toHaveLength(1);
    });

    it("정당한 코드는 통과시킨다", () => {
      // 다른 값에서 계산 · 0 초기값 · 파생식의 작은 상수 · 주석 속 숫자 · 무관한 필드.
      expect(
        probe(`
          // totalIncome: 1_000 — 주석은 노드가 아니다
          const a = {
            totalIncome: stored.totalIncome,
            taxableIncome: 0,
            effectiveTaxRate: whole > 0 ? (part / whole) * 100 : 0,
            firstHalfMonthlyAverage: firstHalf.taxableSales / 6,
            quickDeduction: 1_260_000,
            incomeYear: 2025,
          };
        `),
      ).toEqual([]);
    });

    it("프리필터가 스캐너보다 좁지 않다 — 이스케이프로 적은 이름도 파싱 대상이다", () => {
      expect(mayMention(`const a = { \\u0074otalIncome: 1 };`)).toBe(true);
      expect(mayMention(`const a = { payableVat: 1 };`)).toBe(true);
      expect(mayMention(`const a = { unrelated: 1 };`)).toBe(false);
    });
  });
});
