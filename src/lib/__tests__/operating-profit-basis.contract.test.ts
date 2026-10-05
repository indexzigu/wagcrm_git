/**
 * `operatingProfit` 산식의 단일 출처 계약 (오너 확정 2026-10-05).
 *
 * 저장 `SalesCampaign.operatingProfit` 은 **영업수익 기준**이다 —
 *   settlementSales − sellerExpense − taxExpense − operatingExpense − miscExpense
 * 그리고 그 뺄셈은 `computeOperatingProfit`(`campaign-financials.ts`) **한 곳**에만 있다.
 *
 * 이 계약이 생긴 사고: 같은 컬럼을 쓰는 writer 가 둘이었고(편집 PATCH · 주문 동기화) 각자
 * 뺄셈을 손으로 적어, 주문 동기화 쪽만 피감수가 총매출(`actualSales`)이었다. 주문이 들어올
 * 때마다 손익이 (총매출 − 영업수익)만큼 부풀려 저장됐고, 화면에서 한 번 편집하면 다시
 * 줄어드는 식으로 값이 오갔다. 단위 테스트는 **경로마다 따로** 있어 서로 다른 값을 각자
 * 초록으로 고정하고 있었다 — 그래서 소스 전수 스캔으로 막는다.
 *
 * 스캔은 TypeScript 컴파일러 AST 로 한다. 🪤 정규식으로 세면 이 주제의 주석(금지 형태를
 * 설명하려고 `actualSales - …` 를 인용한다)이 자기 자신을 위반으로 잡는다. AST 에는 주석이
 * 없다. 그리고 「위반 0건」 단언은 스캐너가 죽어도 초록이므로, **같은 스캐너**를 합성 소스에
 * 태우는 양성·음성 프로브를 함께 둔다.
 *
 * ⚠️ 범위: 각 항(`settlementSales`·`sellerExpense`·`taxExpense`)을 **어떻게 구하는가**는 이
 * 계약이 보지 않는다(writer 마다 다르며 별도 미결 사안). 여기서 고정하는 것은 마지막
 * 뺄셈의 피감수와 「그 뺄셈이 한 곳에만 있다」는 사실뿐이다.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

import { computeOperatingProfit } from "../campaign-financials";

const SRC_ROOT = join(process.cwd(), "src");
const SSOT_FILE = "src/lib/campaign-financials.ts";
const SSOT_FN = "computeOperatingProfit";

/** 손익을 담는 이름 — `operatingProfit`·`draftOperatingProfit`·`preTaxOperatingProfit` … */
const TARGET_NAME = /operatingprofit$/i;
/**
 * 다른 지표라 대상에서 빼는 이름. 세후 손익(`afterTaxOperatingProfit`)은 「세전 손익 − 소득세
 * 추정」이라는 **별개의 뺄셈**이고(손익 리포트), 저장 컬럼의 산식을 다시 적은 것이 아니다.
 */
const NON_TARGET_NAME = /aftertax/i;
const isTargetName = (name: string) => TARGET_NAME.test(name) && !NON_TARGET_NAME.test(name);
/** 총매출을 가리키는 이름 — 피감수에 등장하면 「총매출 기준」으로 본다. */
const GROSS_NAME = /actualsales|grosssales/i;

/** DB 에 손익을 쓰는 경로 — 전부 SSOT 를 **호출**해야 한다(이름 등장이 아니라 호출 노드). */
const WRITER_FILES = [
  SSOT_FILE, // `calculateDerivedCampaignFinancials` — 실매출 입력 라우트가 결과를 그대로 저장한다
  "src/lib/order-converter/mapping-service.ts", // 주문 동기화
  "src/services/campaignService.ts", // 캠페인 편집 PATCH
] as const;

/**
 * 알고 남겨 둔 예외. 키 = 파일, 값 = 사유.
 * ⛔ 저장 경로를 여기 넣지 말 것 — 이 목록은 「어디에도 저장되지 않는」 값 전용이다.
 */
const KNOWN_UNPERSISTED: Record<string, string> = {
  // `computeRevenue` 의 반환 필드. 유일한 호출부(`calculateDerivedCampaignFinancials`)가
  // `netRevenue`·`sellerCommission` 만 읽고 이 필드는 버린다(아래 「죽은 필드」 단언이 고정).
  "src/lib/revenue-calc.ts": "computeRevenue().operatingProfit — 총매출 기준 레거시, 소비처 없음",
};

type HitKind = "gross-basis" | "hand-rolled";
type Hit = { file: string; line: number; kind: HitKind; target: string };

function scriptKind(fileName: string): ts.ScriptKind {
  return fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isSsotCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === SSOT_FN;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === SSOT_FN;
  return false;
}

function isSubtraction(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.MinusToken;
}

/** `a - b - c` 의 맨 왼쪽 항(피감수). 괄호·`as`·`!` 는 벗긴다. */
function minuendOf(node: ts.BinaryExpression): ts.Expression {
  let current: ts.Expression = node.left;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    } else if (isSubtraction(current)) {
      current = current.left;
    } else {
      return current;
    }
  }
}

function mentionsGross(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(n) && GROSS_NAME.test(n.text)) {
      found = true;
      return;
    }
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

/**
 * 한 파일에서 「손익 이름에 뺄셈으로 만든 값이 들어가는 자리」를 전부 찾는다.
 *
 * 대상 자리: 변수 선언 · 객체 리터럴 속성(축약 포함) · 대입(`=`, `-=`).
 * 값이 변수를 거쳐 오면 같은 파일의 그 변수 선언·대입까지 **두 단계** 따라간다
 * (`const p = a - b; data: { operatingProfit: p }` 로 그물을 비켜가지 못하게).
 * SSOT 호출의 인자는 들여다보지 않는다 — 거기 들어가는 항은 이 계약의 대상이 아니다.
 */
function scanOperatingProfitSites(fileName: string, source: string): Hit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));

  // 같은 파일의 「이름 → 그 이름에 들어가는 식들」(함수 값은 제외 — 호출 대상이지 값이 아니다).
  const bindings = new Map<string, ts.Expression[]>();
  const bind = (name: string, expr: ts.Expression) => {
    if (isFunctionLike(expr)) return;
    const list = bindings.get(name) ?? [];
    list.push(expr);
    bindings.set(name, list);
  };
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bind(node.name.text, node.initializer);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      bind(node.left.text, node.right);
    }
    node.forEachChild(collect);
  };
  collect(sf);

  const classify = (expr: ts.Expression): HitKind | null => {
    let kind: HitKind | null = null;
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node, hops: number) => {
      if (kind === "gross-basis" || seen.has(node)) return;
      seen.add(node);
      if (isSsotCall(node)) return;
      if (isSubtraction(node)) {
        kind = mentionsGross(minuendOf(node)) ? "gross-basis" : (kind ?? "hand-rolled");
      }
      if (ts.isIdentifier(node) && hops > 0) {
        for (const bound of bindings.get(node.text) ?? []) visit(bound, hops - 1);
      }
      // `obj.name` 의 name · `{ key: … }` 의 key 는 값 참조가 아니다 — 따라가지 않는다.
      // `obj.name` 의 obj 도 따라가지 않는다: 필드 하나를 읽는 것이지 obj 를 만든 식 전체가
      // 값으로 들어오는 게 아니다(따라가면 `totals.x` 가 totals 를 만든 reduce 안의 무관한
      // 뺄셈에 걸린다 — 실코퍼스에서 난 거짓 양성).
      if (ts.isPropertyAccessExpression(node)) {
        if (!ts.isIdentifier(node.expression)) visit(node.expression, hops);
        return;
      }
      if (ts.isPropertyAssignment(node)) {
        visit(node.initializer, hops);
        return;
      }
      node.forEachChild((child) => visit(child, hops));
    };
    visit(expr, 2);
    return kind;
  };

  const hits: Hit[] = [];
  const report = (at: ts.Node, target: string, kind: HitKind | null) => {
    if (!kind) return;
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    hits.push({ file: fileName, line, kind, target });
  };
  const nameOf = (node: ts.Node): string | null => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    return null;
  };

  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const name = nameOf(node.name);
      if (name && isTargetName(name)) report(node, name, classify(node.initializer));
    } else if (ts.isPropertyAssignment(node)) {
      const name = nameOf(node.name);
      if (name && isTargetName(name)) report(node, name, classify(node.initializer));
    } else if (ts.isShorthandPropertyAssignment(node)) {
      if (isTargetName(node.name.text)) report(node, node.name.text, classify(node.name));
    } else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const name = nameOf(node.left);
      if (name && isTargetName(name)) {
        if (op === ts.SyntaxKind.EqualsToken) report(node, name, classify(node.right));
        // `profit -= x` 는 그 자체가 손으로 쓴 뺄셈이다.
        if (op === ts.SyntaxKind.MinusEqualsToken) report(node, name, "hand-rolled");
      }
    }
    node.forEachChild(walk);
  };
  walk(sf);
  return hits;
}

/** 식별자·속성 이름이 `name` 인 **호출 노드** 수. */
function countCalls(fileName: string, source: string, name: string): number {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  let count = 0;
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (calleeName === name) count += 1;
    }
    node.forEachChild(walk);
  };
  walk(sf);
  return count;
}

function isTestPath(relativePath: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(relativePath) ||
    relativePath.includes("/__tests__/") ||
    relativePath.startsWith("src/test/") ||
    relativePath.endsWith(".d.ts")
  );
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      const rel = relative(process.cwd(), full).split(sep).join("/");
      if (!isTestPath(rel)) out.push(rel);
    }
  }
  return out;
}

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const SOURCE_FILES = listSourceFiles(SRC_ROOT);
const ALL_HITS = SOURCE_FILES.flatMap((file) => scanOperatingProfitSites(file, read(file)));

describe("operatingProfit 산식 계약 — 영업수익 기준, 뺄셈은 SSOT 한 곳", () => {
  it("스캔 모집단이 비어 있지 않다(경로가 틀리면 아래 단언이 전부 공허한 초록이 된다)", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    for (const file of WRITER_FILES) expect(SOURCE_FILES).toContain(file);
    expect(SOURCE_FILES.some((file) => isTestPath(file))).toBe(false);
  });

  it("SSOT 는 영업수익에서 비용 넷을 뺀다 — 총매출은 입력조차 받지 않는다", () => {
    expect(
      computeOperatingProfit({
        settlementSales: 300_000,
        sellerExpense: 100_000,
        taxExpense: 18_182,
        operatingExpense: 5_000,
        miscExpense: 1_000,
      }),
    ).toBe(175_818);
    // @ts-expect-error — `actualSales` 는 이 함수의 인자가 아니다(총매출 기준 회귀의 타입 방벽).
    computeOperatingProfit({ actualSales: 1, settlementSales: 0, sellerExpense: 0, taxExpense: 0, operatingExpense: 0, miscExpense: 0 });
  });

  it("src 전수: 총매출을 피감수로 손익을 만드는 곳이 없다", () => {
    const gross = ALL_HITS.filter((hit) => hit.kind === "gross-basis" && !(hit.file in KNOWN_UNPERSISTED));
    expect(gross).toEqual([]);
  });

  it("src 전수: 손익 뺄셈을 손으로 다시 적은 곳이 없다", () => {
    const handRolled = ALL_HITS.filter((hit) => hit.kind === "hand-rolled" && !(hit.file in KNOWN_UNPERSISTED));
    expect(handRolled).toEqual([]);
  });

  it.each(WRITER_FILES)("%s 는 computeOperatingProfit 을 호출한다", (file) => {
    expect(countCalls(file, read(file), SSOT_FN)).toBeGreaterThanOrEqual(1);
  });

  it("예외 목록은 살아 있는 예외만 담는다(고쳐졌으면 목록에서 지운다)", () => {
    for (const file of Object.keys(KNOWN_UNPERSISTED)) {
      expect(ALL_HITS.filter((hit) => hit.file === file).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("예외로 둔 computeRevenue().operatingProfit 은 죽은 필드다 — 호출부가 하나이고 그 필드를 읽지 않는다", () => {
    const callers = SOURCE_FILES.filter(
      (file) => file !== "src/lib/revenue-calc.ts" && countCalls(file, read(file), "computeRevenue") > 0,
    );
    expect(callers).toEqual([SSOT_FILE]);

    const sf = ts.createSourceFile(SSOT_FILE, read(SSOT_FILE), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const reads: number[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "operatingProfit") {
        reads.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
      }
      node.forEachChild(walk);
    };
    walk(sf);
    expect(reads).toEqual([]);
  });
});

describe("스캐너 프로브 — 위 「0건」이 스캐너 고장이 아님을 같은 스캐너로 확인한다", () => {
  const kinds = (source: string, fileName = "probe.ts") =>
    scanOperatingProfitSites(fileName, source).map((hit) => hit.kind);

  it("양성: 총매출 기준 대입(이번 사고의 원형)을 잡는다", () => {
    const source = `
      export async function bad(prisma: any, nextActualSales: number, d: any) {
        d.operatingProfit =
          nextActualSales - d.sellerExpense - d.taxExpense - 1 - 2;
        await prisma.salesCampaign.update({ where: { id: "x" }, data: { operatingProfit: d.operatingProfit } });
      }
    `;
    expect(kinds(source)).toEqual(["gross-basis"]);
  });

  it("양성: 객체 리터럴 안에서 바로 만든 총매출 기준 값을 잡는다", () => {
    const source = `
      export const data = (c: any) => ({ operatingProfit: Number(c.actualSales) - c.sellerExpense });
    `;
    expect(kinds(source)).toEqual(["gross-basis"]);
  });

  it("양성: 영업수익 기준이어도 손으로 다시 적으면 잡는다", () => {
    const source = `
      export function bad(f: any, opEx: number, misc: number) {
        const netCommission = f.settlementSales - f.sellerExpense;
        f.operatingProfit = netCommission - opEx - f.taxExpense - misc;
      }
    `;
    expect(kinds(source)).toEqual(["hand-rolled"]);
  });

  it("양성: 변수를 거쳐 들어가도 잡는다(선언 → 축약 속성 / 두 단계)", () => {
    const viaShorthand = `
      export function bad(c: any) {
        const operatingProfit = c.actualSales - c.sellerExpense;
        return { operatingProfit };
      }
    `;
    // 선언 자리 1건 + 축약 속성 자리 1건.
    expect(kinds(viaShorthand)).toEqual(["gross-basis", "gross-basis"]);

    const viaTwoHops = `
      export function bad(c: any, round: (n: number) => number) {
        const raw = c.grossSales - c.sellerExpense;
        const rounded = round(raw);
        return { operatingProfit: rounded };
      }
    `;
    expect(kinds(viaTwoHops)).toEqual(["gross-basis"]);
  });

  it("양성: 복합 대입(-=)과 tsx 파일도 잡는다", () => {
    expect(kinds(`export function bad(s: any) { s.operatingProfit -= s.taxExpense; }`)).toEqual(["hand-rolled"]);
    const tsx = `
      export function Card({ c }: { c: any }) {
        const draftOperatingProfit = c.settlementSales - c.sellerExpense - c.taxExpense;
        return <p>{draftOperatingProfit}</p>;
      }
    `;
    expect(kinds(tsx, "probe.tsx")).toEqual(["hand-rolled"]);
  });

  it("음성: SSOT 호출·주석 속 금지 형태·덧셈 합산·조회 select 는 잡지 않는다", () => {
    const source = `
      import { computeOperatingProfit } from "@/lib/campaign-financials";
      // 금지: operatingProfit = actualSales - sellerExpense  ← 주석은 AST 에 없다.
      /* data: { operatingProfit: nextActualSales - x } */
      export function fine(f: any, acc: any, c: any) {
        const netCommission = f.settlementSales - f.sellerExpense;
        f.operatingProfit = computeOperatingProfit({
          settlementSales: netCommission + f.sellerExpense,
          sellerExpense: f.sellerExpense,
          taxExpense: f.taxExpense,
          operatingExpense: f.total - f.rest,
          miscExpense: 0,
        });
        const summary = { operatingProfit: acc.operatingProfit + (c.operatingProfit ?? 0) };
        const select = { operatingProfit: true, actualSales: true };
        const shown = c.operatingProfit == null ? null : Number(c.operatingProfit);
        const totals = [c].reduce((t, r) => ({ n: t.n - r.n, preTaxOperatingProfit: t.preTaxOperatingProfit + r.p }), { n: 0, preTaxOperatingProfit: 0 });
        const report = { preTaxOperatingProfit: Math.round(totals.preTaxOperatingProfit) };
        const afterTaxOperatingProfit = report.preTaxOperatingProfit - c.estimatedTotalTax;
        return { summary, select, shown, report, afterTaxOperatingProfit, margin: c.actualSales - c.settlementSales };
      }
    `;
    expect(kinds(source)).toEqual([]);
  });
});
