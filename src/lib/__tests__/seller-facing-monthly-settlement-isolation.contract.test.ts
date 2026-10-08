/**
 * **셀러가 보는 표면은 월정산의 달별 구분을 모른다** — 계약(T-240, 오너 확정 2026-10-08).
 *
 * 월정산 거래처는 브랜드(공급사) 계산서를 캠페인 안에서 달별로 여러 장 기록하지만(`campaign-invoices.ts`,
 * #159 의 월별 정산 줄을 대체), **셀러에게는 캠페인 합산으로 정산한다.** 그래서 셀러 정산 명세서·셀러 포털(`/<slug>`, `/p/[token]`)에 「9월분」 같은
 * 월 구분이나 월별 금액이 새어 나가면 안 된다(셀러가 받은 명세서와 실제 정산 단위가 달라진다).
 * 달별 계산서에는 브랜드 쪽 수수료·물품대금 같은 내부 금액도 있어 P0 Seller-Facing Data Exposure
 * 와도 맞닿는다.
 *
 * 두 겹으로 본다:
 * ① 셀러 대면 파일이 월별 정산 이름(모델·관계·필드·응답 신호)을 직접 쓰지 않는다.
 * ② 셀러 대면 파일의 import 의존 범위(간접 포함)에 월별 정산 모듈이 들어오지 않는다 — ①만 보면
 *    중간 모듈 하나를 거쳐 들어오는 경로를 놓친다.
 *
 * 셀러 대면 범위는 **손으로 적은 목록이 아니라 디렉터리에서 파생**한다(포털 라우트·포털 컴포넌트) —
 * 새 포털 파일이 생겨도 조용히 빠지지 않게. 명세서·포털 데이터 모듈 둘은 디렉터리 밖이라 이름으로 둔다.
 *
 * 판정은 TypeScript AST 로 한다 — 주석은 노드가 아니어서 이 파일처럼 금지 이름을 **설명으로 인용한
 * 주석**은 위반이 되지 않는다(정규식 스캐너가 자기 경고문을 잡던 이 레포의 선례). 스캐너가 고장 나도
 * 「0건」은 초록이므로, 아래 양성 프로브가 같은 스캐너로 위반을 실제로 잡는지 함께 단언한다.
 *
 * ⛔ 이 계약을 풀어야 한다면(셀러 명세서에 월 구분을 넣기로 했다면) 그것은 오너 결정 사안이다.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import ts from "typescript";

const SRC = join(__dirname, "..", "..");

/** 셀러가 보는 화면의 디렉터리 — 이 아래 파일은 전부 셀러 대면이다. */
const SELLER_FACING_DIRS = ["app/[slug]", "app/p", "components/portal"];
/** 디렉터리 밖의 셀러 대면 데이터 모듈 — 명세서 HTML·텍스트 빌더와 포털 페이로드(화이트리스트). */
const SELLER_FACING_MODULES = ["lib/settlement-statement.ts", "lib/seller-portal.ts"];

/**
 * 월별 정산을 가리키는 이름 계열 — 식별자·속성 이름·문자열(일부로 포함돼도) 어디에 나와도 위반이다.
 * 정확한 이름 목록이 아니라 계열 패턴인 이유: `monthlyLineCount` 같은 새 변형이나
 * `"campaign.monthlyLines"` 같은 문자열 경로도 잡아야 한다.
 */
const BANNED_NAME = /campaignInvoice|InvoiceMonth|monthly(Settlement|Line)|monthlyCompletionBlocked/i;

/** 달별 계산서 모듈(판정·서비스·칸) — 경로에 이 조각이 있으면 월정산 달별 구분 코드다. `monthly-settlement` 는 #159 잔재 경로를 계속 막는다. */
const BANNED_MODULE = /campaign-invoice|campaignInvoiceService|monthly-settlement/;

function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      sourceFilesUnder(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function sellerFacingFiles(): string[] {
  return [
    ...SELLER_FACING_DIRS.flatMap((dir) => sourceFilesUnder(join(SRC, dir))),
    ...SELLER_FACING_MODULES.map((file) => join(SRC, file)),
  ];
}

function parse(fileName: string, text: string): ts.SourceFile {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

/** 이 파일이 import 하는 모듈 지정자 전부(정적·재수출·동적 import·require·import x = require·import 타입). */
function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specs.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

/** 금지 이름이 코드(주석 제외)에 나오는 곳과 금지 모듈 import 를 돌려준다. */
function scanSellerFacingSource(fileName: string, text: string): string[] {
  const source = parse(fileName, text);
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    const name =
      ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
        ? node.text
        : ts.isStringLiteralLike(node)
          ? node.text
          : null;
    if (name && BANNED_NAME.test(name)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      violations.push(`${fileName}:${line + 1} ${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const spec of moduleSpecifiers(source)) {
    if (BANNED_MODULE.test(spec)) violations.push(`${fileName} import ${spec}`);
  }
  return violations;
}

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolvePath(dirname(fromFile), spec);
  else return null; // 외부 패키지는 범위 밖
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 진입 파일들에서 시작한 로컬 import 의존 범위 — 월별 정산 모듈에 닿으면 그 경로를 돌려준다. */
function findBannedImportPaths(entries: string[]): { visited: number; hits: string[] } {
  const parentOf = new Map<string, string | null>();
  const queue: Array<[string, string | null]> = entries.map((entry) => [entry, null]);
  while (queue.length > 0) {
    const [file, parent] = queue.shift()!;
    if (parentOf.has(file)) continue;
    parentOf.set(file, parent);
    const source = parse(file, readFileSync(file, "utf8"));
    for (const spec of moduleSpecifiers(source)) {
      const target = resolveLocal(file, spec);
      if (target && !parentOf.has(target)) queue.push([target, file]);
    }
  }
  const hits = [...parentOf.keys()]
    // 판정은 src 기준 상대경로로 한다 — 체크아웃 경로에 금지 조각이 들어 있으면 전 파일이 걸린다.
    .filter((file) => BANNED_MODULE.test(relative(SRC, file)))
    .map((file) => {
      const chain: string[] = [];
      for (let cur: string | null | undefined = file; cur; cur = parentOf.get(cur)) {
        chain.unshift(relative(SRC, cur));
      }
      return chain.join(" → ");
    });
  return { visited: parentOf.size, hits };
}

describe("셀러 대면 표면은 월별 정산 줄을 모른다(T-240)", () => {
  const files = sellerFacingFiles();

  it("셀러 대면 범위가 실제로 읽힌다(포털·명세서 모듈 포함)", () => {
    const rel = files.map((file) => relative(SRC, file));
    expect(rel).toContain("lib/settlement-statement.ts");
    expect(rel).toContain("lib/seller-portal.ts");
    expect(rel.some((file) => file.startsWith("app/p/"))).toBe(true);
    expect(rel.some((file) => file.startsWith("components/portal/"))).toBe(true);
  });

  it("① 셀러 대면 파일은 월별 정산 이름·모듈을 직접 쓰지 않는다", () => {
    const violations = files.flatMap((file) =>
      scanSellerFacingSource(relative(SRC, file), readFileSync(file, "utf8")),
    );
    expect(violations, `셀러 명세서·포털에 월 구분이 새면 셀러 정산 단위와 갈라진다: ${violations.join(", ")}`).toEqual([]);
  });

  it("② 셀러 대면 파일의 import 의존 범위(간접 포함)에 월별 정산 모듈이 없다", () => {
    const { visited, hits } = findBannedImportPaths(files);
    expect(visited).toBeGreaterThan(files.length); // 의존을 실제로 따라갔다
    expect(hits, `간접 경로로 월별 정산 모듈이 들어왔다: ${hits.join(" | ")}`).toEqual([]);
  });

  describe("양성 프로브 — 같은 스캐너가 위반을 실제로 잡는다", () => {
    it("속성 접근·문자열 키·import 는 잡고, 주석 속 언급은 잡지 않는다", () => {
      // 건수가 아니라 「잡았다」만 단언한다 — 금지 모듈 문자열은 이름 패턴에도 함께 걸려 2건이 되기도 한다.
      expect(scanSellerFacingSource("probe.ts", "const n = campaign.monthlySettlements.length;")).not.toEqual([]);
      expect(scanSellerFacingSource("probe.ts", 'const include = { "monthlyLines": true };')).not.toEqual([]);
      // 하이픈 경로는 이름 패턴에 안 걸리므로 건수 1 = 모듈 추적이 잡은 것이다(추적이 고장 나면 0 이 된다).
      expect(scanSellerFacingSource("probe.ts", 'import { x } from "@/lib/monthly-settlement";')).toHaveLength(1);
      expect(scanSellerFacingSource("probe.ts", "const m = await import('@/lib/monthly-settlement');")).toHaveLength(1);
      expect(scanSellerFacingSource("probe.ts", 'const p = "campaign.monthlyLines";')).not.toEqual([]);
      expect(scanSellerFacingSource("probe.ts", "const { monthlyLineCount } = row;")).not.toEqual([]);
      expect(scanSellerFacingSource("probe.ts", "const m = require('@/lib/monthly-settlement');")).toHaveLength(1);
      expect(scanSellerFacingSource("probe.ts", "type T = typeof import('@/lib/monthly-settlement');")).toHaveLength(1);
      expect(scanSellerFacingSource("probe.ts", "// campaign.monthlySettlements 는 셀러에게 안 보낸다\nconst a = 1;")).toEqual([]);
      // 달별 계산서(#159 대체) — 이름·하이픈 경로 모두 잡는다.
      expect(scanSellerFacingSource("probe.ts", "const rows = campaign.campaignInvoices;")).not.toEqual([]);
      expect(scanSellerFacingSource("probe.ts", 'import { x } from "@/lib/campaign-invoices";')).toHaveLength(1);
    });

    it("의존 범위 추적은 이름에 금지 조각이 없는 파일에서 시작해도 간접 import 를 따라가 잡는다", () => {
      // 시작 파일 이름이 이미 금지 조각을 품으면 추적이 고장 나도 통과하므로, 칸을 간접 import 하는
      // 캠페인 상세 패널에서 시작한다(캠페인 상세 → 정산 칸 → 달별 계산서 칸 → 판정 모듈).
      const { hits } = findBannedImportPaths([join(SRC, "components/crm/campaign-side-panel.tsx")]);
      expect(hits.some((chain) => chain.startsWith("components/crm/campaign-side-panel.tsx → "))).toBe(true);
    });
  });
});
