// Graph Tier0 게이트 ↔ DB 토큰 주입의 **짝과 순서** 계약 (2026-08-26 실사고).
//
// 인스타그램 장기 토큰은 60일 만료라 `.env` 가 아니라 DB(`SystemSettings`)가 정본이고,
// 서버는 자기 env 를 갱신할 수 없어서 `applyDbInstagramToken()` 이 **실행 시점에
// `process.env.INSTAGRAM_ACCESS_TOKEN` 을 덮어쓴다**(`instagram-token.ts` 머리말).
//
// **왜 계약으로 고정하나 — 이 부수효과가 프로세스 전역이기 때문이다.** 어떤 진입점이
// 그 함수를 부르면 **같은 Node 프로세스의 다른 모든 경로**가 덩달아 통과한다. 그래서
// 호출을 빠뜨린 모듈은 "대체로 잘 돌다가" 앱 재시작 뒤 회차부터 조용히 죽는다 —
// 크론 래퍼(`system-task-status.ts`)는 핸들러가 `failed: true` 를 선언해야만 ERROR 로
// 적으므로 상태판은 그동안 내내 SUCCESS 다.
//
// 실사고: `collect-campaign-posts` 가 하루는 갱신하고 다음 이틀은 0건이었는데 세 회차 모두
// `OK` 였다. 같은 잠복 결함이 `enrich-references`(→ campaign-engagement-collector)에도
// 있었다. 사람 리뷰로는 재발한다 — 새 수집 표면에서 `isGraphConfigured()` 만 부르는 쪽이
// 자연스러워 보이고(그게 그 함수의 이름이다), 앞선 크론이 채워 둔 env 덕에 **로컬에서도
// 프로덕션에서도 한동안 초록**이기 때문이다.
//
// ⚠️ **호출의 존재만 세면 이 계약은 자기 이름값을 못 한다** — 교차 검증(2026-08-26)에서
// 주입을 게이트 **뒤로** 옮긴 변이가 초판 스캐너를 그대로 통과했다. 그 배치는 이 PR 이
// 고치려던 바로 그 결함을 재현한다. 그래서 판정은 **소스 위치 비교**까지 한다.
//
// 🪤 정규식으로 세지 않는다 — 이 레포는 손수 만든 스트리퍼가 주석·정규식 리터럴을 잘못
// 삼켜 고장이 초록으로 보인 전례가 있다. AST 는 주석을 노드로 만들지 않으므로, 이 규칙을
// **설명하는 주석**(바로 이 머리말)이 자기 자신을 만족시키는 거짓 통과도 구조적으로 없다.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");

/** Tier0 게이트 판정자. 이 함수를 부르는 모듈이 계약 대상이다. */
const GATE = "isGraphConfigured";
/** 게이트 앞에 있어야 하는 토큰 주입기. */
const APPLIER = "applyDbInstagramToken";

/**
 * 게이트를 **소유**하는 모듈 — 판정 함수 자신이라 토큰 주입 의무가 없다.
 * ⛔ 소비처를 이 목록으로 옮겨 계약을 우회하지 말 것.
 */
const GATE_OWNER = "src/lib/seller-analysis/graphScraper.ts";

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

function parse(raw: string, file: string): ts.SourceFile {
  const tsx = file.endsWith(".tsx");
  return ts.createSourceFile(
    tsx ? "scan.tsx" : "scan.ts",
    raw,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * `import { isGraphConfigured as check }` 로 묶인 **로컬 이름**을 모은다.
 *
 * ⚠️ 별칭을 무시하면 이름 충돌을 피하려는 흔한 리팩터링 한 번으로 그 파일이 소비처
 * 목록에서 **통째로** 빠진다 — "소스에서 파생하니 손으로 적은 목록보다 낫다"는 이 계약의
 * 근거가 그 순간 사라진다(교차 검증 지적, 2026-08-26).
 */
function localNamesFor(sourceFile: ts.SourceFile, imported: string): Set<string> {
  const names = new Set<string>([imported]);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const spec of bindings.elements) {
      // `a as b` 면 propertyName=a·name=b, 별칭이 없으면 name 이 원래 이름이다.
      if ((spec.propertyName?.text ?? spec.name.text) === imported) names.add(spec.name.text);
    }
  }
  return names;
}

/**
 * `name(...)` 호출이 **처음 나오는 소스 위치**를 준다(없으면 -1). import 문·주석·문자열은
 * CallExpression 이 아니라 걸리지 않는다. `ns.name(...)` 네임스페이스 호출도 같이 잡는다.
 */
function firstCallPos(raw: string, file: string, imported: string): number {
  const sourceFile = parse(raw, file);
  const locals = localNamesFor(sourceFile, imported);
  let best = -1;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      const hit = ts.isIdentifier(target)
        ? locals.has(target.text)
        : ts.isPropertyAccessExpression(target) && target.name.text === imported;
      if (hit) {
        const pos = node.getStart(sourceFile);
        if (best === -1 || pos < best) best = pos;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return best;
}

/**
 * 게이트를 호출하는 파일 목록을 **소스에서 파생**한다 — 손으로 적은 목록이면 새 소비처가
 * 생겨도 이 계약이 조용히 비켜간다(이 사고가 정확히 "새 소비처가 규약을 몰랐다" 였다).
 * 값싼 부분문자열로 후보를 거른 뒤 그 몇 개만 파싱한다(전수 파싱은 느리다).
 */
function gateConsumers(): string[] {
  const found: string[] = [];
  for (const full of listSourceFiles(SRC_DIR)) {
    const raw = readFileSync(full, "utf8");
    // 별칭을 써도 import 문에는 원래 이름이 남으므로 이 사전 필터는 별칭 경로를 놓치지 않는다.
    if (!raw.includes(GATE)) continue;
    const rel = relative(ROOT, full);
    if (rel === GATE_OWNER) continue;
    if (firstCallPos(raw, rel, GATE) >= 0) found.push(rel);
  }
  return found.sort();
}

describe("Graph Tier0 게이트는 DB 토큰 주입과 짝으로, 그 뒤에 온다", () => {
  it("게이트 소비처가 소스에서 실제로 발견된다(스캐너 생존 확인)", () => {
    // 0건이면 스캐너가 죽은 것이지 위반이 없는 것이 아니다 —
    // `db-exposure-audit` 의 "테이블 0개는 깨끗함이 아니라 감사 불능" 과 같은 판정.
    expect(gateConsumers().length).toBeGreaterThan(0);
  });

  it("게이트를 부르는 모든 모듈이 같은 파일에서 토큰 주입도 부른다", () => {
    const missing = gateConsumers().filter(
      (rel) => firstCallPos(readFileSync(join(ROOT, rel), "utf8"), rel, APPLIER) < 0,
    );
    expect(missing).toEqual([]);
  });

  it("토큰 주입이 게이트보다 **먼저** 온다", () => {
    // 순서가 뒤집히면 게이트는 낡은(또는 빈) env 로 판정한다 — 호출이 있어도 결함 그대로다.
    const outOfOrder = gateConsumers().filter((rel) => {
      const raw = readFileSync(join(ROOT, rel), "utf8");
      const applier = firstCallPos(raw, rel, APPLIER);
      const gate = firstCallPos(raw, rel, GATE);
      return applier < 0 || applier > gate;
    });
    expect(outOfOrder).toEqual([]);
  });

  it("스캐너가 주입 누락을 실제로 잡는다(양성 프로브)", () => {
    const violation = `
      import { isGraphConfigured } from "@/lib/seller-analysis/graphScraper";
      export async function run() {
        if (!isGraphConfigured()) return;
      }
    `;
    expect(firstCallPos(violation, "probe.ts", GATE)).toBeGreaterThan(-1);
    expect(firstCallPos(violation, "probe.ts", APPLIER)).toBe(-1);
  });

  it("스캐너가 **순서 뒤집힘**을 잡는다(양성 프로브 — 초판이 놓친 변이)", () => {
    const lateApply = `
      import { isGraphConfigured } from "@/lib/seller-analysis/graphScraper";
      import { applyDbInstagramToken } from "@/lib/instagram-token";
      export async function run() {
        if (!isGraphConfigured()) return;
        await applyDbInstagramToken();
      }
    `;
    const applier = firstCallPos(lateApply, "probe.ts", APPLIER);
    const gate = firstCallPos(lateApply, "probe.ts", GATE);
    expect(applier).toBeGreaterThan(gate);
  });

  it("import 별칭으로 스캐너를 빠져나갈 수 없다(양성 프로브)", () => {
    const aliased = `
      import { isGraphConfigured as check } from "@/lib/seller-analysis/graphScraper";
      export async function run() {
        if (!check()) return;
      }
    `;
    expect(firstCallPos(aliased, "probe.ts", GATE)).toBeGreaterThan(-1);
  });

  it("주석·문자열·import 만으로는 만족되지 않는다(음성 프로브)", () => {
    // 이 계약의 머리말처럼 함수 **이름을 설명만** 하는 파일이 통과해선 안 된다.
    const commentOnly = `
      // applyDbInstagramToken() 를 반드시 부른다고 설명만 하는 주석
      import { applyDbInstagramToken } from "@/lib/instagram-token";
      const label = "applyDbInstagramToken()";
    `;
    expect(firstCallPos(commentOnly, "probe.ts", APPLIER)).toBe(-1);
  });

  it("게이트 소유자는 대상에서 빠진다", () => {
    expect(gateConsumers()).not.toContain(GATE_OWNER);
  });
});
