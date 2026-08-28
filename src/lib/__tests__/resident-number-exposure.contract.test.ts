// 주민등록번호 노출면 계약 (2026-07-24).
//
// 이 값은 셀러 160명 규모의 목록 페이로드에 절대 실리면 안 된다 — 상세 패널을 연
// 1명만 단건 엔드포인트(`/api/sellers/[id]/settlement-info`)로 가져온다. 위생 정리나
// "필드 몇 개 더 내려주면 편하다"는 이유로 목록에 얹히는 순간 전원의 주민번호가
// 브라우저로 나가므로, 사람 리뷰에 맡기지 않고 테스트로 고정한다.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** 주민번호를 실어도 되는 유일한 경로들 — 여기 외에는 등장하면 실패다. */
const ALLOWED_FILES = [
  // 암·복호화 SSOT
  "src/lib/encryption.ts",
  // 단건 조회 엔드포인트(상세 패널 전용)
  "src/app/api/sellers/[id]/settlement-info/route.ts",
  // 셀러 단건 PATCH — 저장 시 암호화, 응답에 복호화
  "src/app/api/sellers/[id]/route.ts",
  // 원천징수 신고(오너 인증 뒤) — 캠페인 행 → 리포트
  "src/lib/campaign-row.ts",
  "src/lib/withholding-report.ts",
  "src/app/api/settlement/withholding/route.ts",
  "src/components/crm/withholding-filing-cards.tsx",
  // 캠페인 사이드패널의 개인 셀러용 원천징수 입력 도우미(캠페인 1건, 기본 마스킹 +
  // 행 단위 펼침 — withholding-filing-cards.tsx와 동일 원칙)
  "src/components/crm/withholding-helper-dialog.tsx",
  // 상세 패널 입력면
  "src/components/crm/seller-detail-content.tsx",
  // 타입·검증 정의
  "src/lib/crm-types.ts",
  "src/lib/validations/seller.ts",
  // 재암호화 스크립트
  "scripts/reencrypt-resident-numbers.ts",
  // 키 정합 감사(2026-08-13) — **값을 읽지 않는다.** 등급 판독기(classifyDecryptability)로
  // "현재 키로 열리는가"만 세고 보고에는 개수와 셀러 id 만 담는다. 값 비유출은
  // encryption-audit.contract.test.ts 의 소스 스캔이 별도로 고정한다.
  "src/lib/encryption-audit.ts",
  "src/app/api/cron/encryption-key-audit/route.ts",
];

// ── 요청 바디 통째 로깅 금지 (2026-08-14) ────────────────────────────────────
//
// 위 ALLOWED_FILES 는 "어떤 파일이 주민등록번호를 만져도 되나"만 정한다 — 그래서
// 셀러 PATCH 라우트가 목록에 있다는 이유로, 그 안에서 요청 바디를 통째로 찍어
// **평문 주민등록번호를 서버 로그에 적재하던 한 줄**을 이 계약이 놓쳤다(선재 결함,
// PR #391 교차 검증에서 발견). 허용은 파일 단위이고 유출은 문장 단위라 축이 다르다.
//
// 🪤 **판정은 정규식이 아니라 TypeScript 컴파일러의 AST 로 한다.** 초판은 주석과
// 문자열 리터럴을 손으로 걷어낸 뒤 정규식으로 훑었는데, 그 스트리퍼가 **정규식
// 리터럴을 몰라서** 문자 클래스 안의 따옴표(`/[\\/\\\\:*?"<>|]/`)를 문자열 시작으로
// 읽고 파일 뒷부분을 통째로 삼켰다. 이 레포에 그런 정규식이 실존한다(3곳:
// partners-panel.tsx · settlement-statement.ts · PrintReportButton.tsx) — 교차 검증이
// 그 아래에 `console.log(reqBody)` 를 심어 **탐지 0건**을 실증했다.
//
// 더 나쁜 것은 그 고장이 **초록으로 보인다**는 점이다: 삼켜도 결과는 똑같이 빈
// 배열이고, "훑은 console 호출 수" 하한도 레포 전체 합산이라 파일 몇 개가 국지적으로
// 손상돼도 통과한다(실측 총 400건대 vs 하한 150). 그래서 휴리스틱을 덧대는 대신
// **어휘 분석을 컴파일러에 넘겼다** — 주석·문자열·템플릿·정규식 구분을 우리가
// 구현하지 않으므로 이 결함 부류 자체가 없어진다. ⛔ 정규식 스캔으로 되돌리지 말 것.

/** 요청 바디를 담는 식별자 — 이 레포에 **실제로 존재하는** 이름으로 한정한다. */
const BODY_NAMES = new Set([
  "body",
  "rawBody",
  "requestBody",
  "reqBody", // src/app/api/partners/[id]/business-info/route.ts
  "parsedBody",
  "payload",
  "json", // 채팅방 매핑 3곳 · 근무기록 인제스트
]);
// ⛔ `raw`·`data`·`input` 처럼 흔한 이름을 넣지 말 것 — `raw` 는 env 문자열
// (`collect-cycle.ts`)을 오탐한다(실측). 무해한 로그를 잡기 시작하면 계약이
// 무시당하고, 그러면 진짜 유출도 함께 통과한다.

type BodyLogHit = { file: string; line: number; text: string };

// ── 로그 싱크 도달 경로 전수 (2026-08-27, T-066) ─────────────────────────────
//
// 초판 판정은 `console.log(body)` 라는 **한 가지 철자**만 봤다 — 호출식이 속성
// 접근이고 그 객체가 **식별자 `console`** 인가. 그래서 같은 일을 조금 다르게 쓴
// 형태는 전부 그냥 통과했다. PR #495 교차 검증에서 발견됐고 **위반 코드는 이
// 시점에 0건**이다(사고 수습이 아니라 구멍 메우기다). 통과하던 형태:
//
//   globalThis.console.log(body)      객체가 식별자가 아니라 속성 접근이다
//   const log = console.log; log(x)   호출식이 그냥 식별자다
//   const { log } = console; log(x)   〃 (구조분해)
//   const c = console; c.log(x)       〃 (객체 별칭)
//   console["log"](x)                 속성 접근이 아니라 인덱스 접근이다
//   console.log.call(null, x)         함수 자신을 호출한다
//   process.stdout.write(x)           console 을 아예 안 거치는 같은 부류의 싱크
//
// 그리고 이 PR 의 **교차 검증에서 초판이 놓친 것으로 추가 확인된** 네 가지(전부 실측):
//
//   let x = globalThis; x = console;  한 이름이 흐름에 따라 두 대상을 가리킨다
//   console`leak: ${x}`               태그드 템플릿은 CallExpression 이 아니다
//   const k = "log"; console[k](x)    인덱스가 문자열 **상수를 담은 이름**이다
//   const [log] = [console.log]       배열 구조분해 별칭
//
// ⚠️ **마지막 줄이 범위 확장인 것은 의도다.** 이 계약이 막는 것은 「`console` 이라는
// 철자」가 아니라 **평문 요청 바디가 서버 로그로 나가는 것**이고, `process.stdout
// .write` 는 그 일을 한 줄로 한다. 그래서 판정 단위를 console 호출이 아니라
// **로그 싱크 호출**로 잡았다(아래 `logSinkCalls`).
//
// 🪤 **판정은 이름 대조가 아니라 「이 식이 무엇으로 평가되는가」다.** 이름을 세면
// 철자를 하나 늘릴 때마다 구멍이 하나 남는다 — 역할(role)을 풀면 위 형태들이 규칙
// 하나로 덮이고 적어 두지 않은 조합(`globalThis["console"]["log"]`)도 자동으로 걸린다.
// 별칭은 파일 안에서 **고정점까지 전파**하므로 `const g = globalThis; const c = g.console;
// const l = c.log; l(body)` 같은 사슬도 풀린다.
//
// ⚠️ **그래도 이름을 세는 자리가 두 곳 남아 있고, 둘 다 계약의 일부다:** 위
// `GLOBAL_OBJECT_NAMES`(전역 객체 이름)와 아래 프리필터의 낱말이다. 싱크나 진입점을
// 늘릴 때 그 둘을 함께 늘리지 않으면 새 경로가 조용히 안 걸린다.
//
// ⚠️ **남은 한계 2종(의도적):** ①**파일 스코프다** — 다른 파일에서
// `export const log = console.log` 를 만들어 import 해 쓰면 못 본다(모듈 그래프를
// 따라가지 않는다). 그 형태는 지금 레포에 없고(전수 grep 0건) 막으려면 import 해석이
// 필요해 별건이다. ②**실행 시점에야 정해지는 이름**(`console[req.query.k]` ·
// `window["con" + "sole"]`)은 원리적으로 못 푼다. 둘 다 프리필터 등가성은 깨지 않는다
// — 판정이 못 잡는 것이지 파일이 스킵되는 것이 아니다.

/** 이 이름들의 `console`·`process` 속성은 곧 그 전역 객체다. */
const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "global", "window", "self"]);

/** 함수 자신을 호출·전달하는 릴레이 — `console.log.call(null, body)` 우회. */
const FUNCTION_RELAY_NAMES = new Set(["call", "apply", "bind"]);

/**
 * 식이 평가될 수 있는 대상의 역할. `SINK` = **부르면 서버 로그에 남는 함수**이고,
 * 나머지는 그 함수로 가는 길목이다.
 *
 * 🪤 **하나가 아니라 집합(비트마스크)인 것이 핵심이다.** 한 이름이 코드 흐름에 따라
 * 두 대상을 가리킬 수 있는데(`let x = globalThis; x = console;`), 역할을 하나만
 * 들려 주면 **먼저 붙은 쪽이 나중 쪽을 가린다.** 초판이 "먼저 붙은 역할이 이긴다 —
 * 재대입 무시는 탐지 쪽으로 기운다"고 적었는데 **그 정당화가 틀렸다**(교차 검증에서
 * 실측 반례): `GLOBAL` 은 하위 멤버에서 `CONSOLE` 보다 **좁아서**(`.console`·`.process`
 * 만 통과) 위 예에서 `x.log(body)` 가 조용히 빠져나갔다. 합집합으로 두면 어느 대입이
 * 먼저 오든 방향이 **실제로** 탐지 쪽으로 고정된다.
 */
const ROLE_GLOBAL = 1 << 0;
const ROLE_CONSOLE = 1 << 1;
const ROLE_PROCESS = 1 << 2;
const ROLE_STDSTREAM = 1 << 3;
const ROLE_SINK = 1 << 4;

/** 이름 → 그 이름이 가질 수 있는 역할 집합. */
type AliasMap = Map<string, number>;

/** 한 파일의 해석 상태 — 별칭과, 인덱스 접근에 쓰이는 문자열 상수. */
type ScanContext = { aliases: AliasMap; stringConsts: Map<string, string> };

/** 값을 바꾸지 않는 껍질(괄호·타입 단언)을 벗긴다. */
function unwrapExpression(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * `a.b` 와 `a["b"]` 를 같은 것으로 읽는다. 인덱스가 **문자열 상수를 담은 이름**이어도
 * 푼다(`const key = "log"; console[key](body)` — 교차 검증에서 나온 우회).
 * 진짜로 실행 시점에 정해지는 이름(`console[req.query.k]`)은 포기한다(undefined).
 */
function staticMemberName(node: ts.Node, ctx: ScanContext): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const argument = unwrapExpression(node.argumentExpression);
    if (ts.isStringLiteralLike(argument)) return argument.text;
    if (ts.isIdentifier(argument)) return ctx.stringConsts.get(argument.text);
  }
  return undefined;
}

/** 소유자 역할 집합 × 속성 이름 → 그 멤버의 역할 집합. 접근·구조분해가 공유한다. */
function memberRoles(owner: number, name: string | undefined): number {
  if (owner === 0 || name === undefined) return 0;
  let roles = 0;
  if (owner & ROLE_GLOBAL) {
    if (name === "console") roles |= ROLE_CONSOLE;
    if (name === "process") roles |= ROLE_PROCESS;
  }
  // console 의 **모든** 메서드가 대상이다(log·error·debug·table…)
  if (owner & ROLE_CONSOLE) roles |= ROLE_SINK;
  if (owner & ROLE_PROCESS && (name === "stdout" || name === "stderr")) roles |= ROLE_STDSTREAM;
  if (owner & ROLE_STDSTREAM && name === "write") roles |= ROLE_SINK;
  if (owner & ROLE_SINK && FUNCTION_RELAY_NAMES.has(name)) roles |= ROLE_SINK;
  return roles;
}

function classifyRoles(node: ts.Node, ctx: ScanContext): number {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (expression.text === "console") return ROLE_CONSOLE;
    if (expression.text === "process") return ROLE_PROCESS;
    if (GLOBAL_OBJECT_NAMES.has(expression.text)) return ROLE_GLOBAL;
    return ctx.aliases.get(expression.text) ?? 0;
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return memberRoles(
      classifyRoles(expression.expression, ctx),
      staticMemberName(expression, ctx),
    );
  }
  if (ts.isCallExpression(expression)) {
    // `console.log.bind(console)(body)` — bind 의 **결과**도 로그 함수다.
    const callee = unwrapExpression(expression.expression);
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      staticMemberName(callee, ctx) === "bind"
    ) {
      return classifyRoles(callee.expression, ctx) & ROLE_SINK ? ROLE_SINK : 0;
    }
  }
  return 0;
}

/**
 * 별칭 후보 한 건. `property`(객체 구조분해)와 `index`(배열 구조분해)는 배타적이고,
 * 둘 다 없으면 `<name> = <init>` 직접 대입이다.
 */
type AliasBinding = { name: string; init: ts.Node; property?: string; index?: number };

/** 별칭 후보와 문자열 상수를 노드 하나에서 걷어낸다. */
function collectBindings(
  node: ts.Node,
  aliasOut: AliasBinding[],
  stringConsts: Map<string, string>,
): void {
  // 초기화식이 로그 싱크가 **될 수 있는** 모양인 것만 담는다 — 파일당 후보를 줄이려는
  // 것이고 판정을 좁히는 것이 아니다(리터럴·화살표함수는 싱크가 될 수 없다).
  const isCandidate = (init: ts.Node) => {
    const unwrapped = unwrapExpression(init);
    return (
      ts.isIdentifier(unwrapped) ||
      ts.isPropertyAccessExpression(unwrapped) ||
      ts.isElementAccessExpression(unwrapped) ||
      ts.isCallExpression(unwrapped) ||
      ts.isArrayLiteralExpression(unwrapped)
    );
  };

  if (ts.isVariableDeclaration(node) && node.initializer) {
    const initializer = unwrapExpression(node.initializer);
    // `const key = "log";` — 인덱스 접근을 푸는 데 쓴다.
    if (ts.isIdentifier(node.name) && ts.isStringLiteralLike(initializer)) {
      if (!stringConsts.has(node.name.text)) stringConsts.set(node.name.text, initializer.text);
      return;
    }
    if (!isCandidate(node.initializer)) return;
    if (ts.isIdentifier(node.name)) {
      aliasOut.push({ name: node.name.text, init: node.initializer });
      return;
    }
    if (ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const property = element.propertyName
          ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
            ? element.propertyName.text
            : undefined
          : element.name.text;
        if (property === undefined) continue;
        aliasOut.push({ name: element.name.text, init: node.initializer, property });
      }
      return;
    }
    // `const [log] = [console.log];` — 자리로 짝지어 푼다.
    if (ts.isArrayBindingPattern(node.name)) {
      node.name.elements.forEach((element, index) => {
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) return;
        aliasOut.push({ name: element.name.text, init: node.initializer!, index });
      });
    }
    return;
  }
  // `let log; log = console.log;` — 선언과 대입이 갈린 형태
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left) &&
    isCandidate(node.right)
  ) {
    aliasOut.push({ name: node.left.text, init: node.right });
  }
}

/** 한 후보가 부여하는 역할 집합. */
function bindingRoles(binding: AliasBinding, ctx: ScanContext): number {
  if (binding.index !== undefined) {
    const initializer = unwrapExpression(binding.init);
    if (!ts.isArrayLiteralExpression(initializer)) return 0;
    const element = initializer.elements[binding.index];
    return element === undefined ? 0 : classifyRoles(element, ctx);
  }
  const owner = classifyRoles(binding.init, ctx);
  return binding.property === undefined ? owner : memberRoles(owner, binding.property);
}

/**
 * 별칭을 **고정점까지** 푼다 — 사슬(`g → c → l`)은 한 바퀴로 안 풀리고, 선언이 사용보다
 * 뒤에 오는 파일도 있으므로 수집과 판정을 분리한다. 역할은 **합집합으로만 자라므로**
 * (위 비트마스크 주석) 루프는 유한하다: 이름 수 × 역할 5개가 상한이다.
 */
function resolveAliases(bindings: AliasBinding[], ctx: ScanContext): void {
  if (bindings.length === 0) return;
  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of bindings) {
      const roles = bindingRoles(binding, ctx);
      if (roles === 0) continue;
      const previous = ctx.aliases.get(binding.name) ?? 0;
      const next = previous | roles;
      if (next === previous) continue;
      ctx.aliases.set(binding.name, next);
      changed = true;
    }
  }
}

/** 이 호출이 서버 로그에 쓰는가. */
const isLogSinkCall = (node: ts.CallExpression | ts.TaggedTemplateExpression, ctx: ScanContext) =>
  (classifyRoles(ts.isCallExpression(node) ? node.expression : node.tag, ctx) & ROLE_SINK) !== 0;

/** 승인된 대안 `Object.keys(...)` — 값 없이 형태만 남으므로 그 안은 보지 않는다. */
const isKeysOnlyCall = (node: ts.Node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "Object" &&
  node.expression.name.text === "keys";

/** 인자 하나가 요청 바디를 흘리는가. */
function argumentLeaksBody(arg: ts.Node): boolean {
  let leaks = false;
  const visit = (node: ts.Node, parent: ts.Node | undefined) => {
    if (leaks) return;
    if (isKeysOnlyCall(node)) return; // 승인된 대안 — 하위는 건너뛴다
    // 인라인 `req.json()` / `request.json()` — 변수에 담지 않고 바로 찍는 형태
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "json"
    ) {
      leaks = true;
      return;
    }
    if (ts.isIdentifier(node) && BODY_NAMES.has(node.text)) {
      // `draft.body` 의 `body` 는 속성 이름이지 바디가 아니다.
      // ⚠️ parent 가 없는 경우(= 인자 전체가 그 식별자, `console.log(body)`)는
      // 가장 전형적인 유출 형태다 — parent 존재를 조건으로 걸면 그걸 놓친다.
      const isPropertyName =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node));
      if (!isPropertyName) {
        leaks = true;
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, node));
  };
  visit(arg, undefined);
  return leaks;
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

type SourceScan = { hits: BodyLogHit[]; logSinkCalls: number };

/**
 * 소스 한 덩이를 훑어 위반 위치와 로그 싱크 호출 수를 **한 번의 파싱으로** 낸다.
 * 프로브가 같은 함수를 쓴다 — 실물과 갈리지 않게.
 *
 * 🪤 **트리 순회도 한 번이다.** 별칭은 사용보다 뒤에 선언될 수 있어 판정 전에
 * 전부 모여 있어야 하는데, 그렇다고 트리를 두 번 걷지 않는다 — 한 바퀴에
 * 호출식과 별칭 후보를 함께 담고, 별칭을 푼 뒤 담아 둔 호출식만 판정한다.
 */
function scanSource(raw: string, file = "(snippet).ts"): SourceScan {
  const sourceFile = parse(raw, file);
  const rawLines = raw.split("\n");
  const hits: BodyLogHit[] = [];
  // 🪤 태그드 템플릿도 **호출이다** — ``console.log`leak: ${body}` `` 는 한 줄로
  // 바디를 흘리는데 `ts.isCallExpression` 이 거짓이라 초판이 놓쳤다(교차 검증 실측).
  const calls: (ts.CallExpression | ts.TaggedTemplateExpression)[] = [];
  const bindings: AliasBinding[] = [];
  const ctx: ScanContext = { aliases: new Map(), stringConsts: new Map() };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) calls.push(node);
    collectBindings(node, bindings, ctx.stringConsts);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  resolveAliases(bindings, ctx);
  let logSinkCalls = 0;
  for (const node of calls) {
    if (!isLogSinkCall(node, ctx)) continue;
    logSinkCalls += 1;
    // 태그드 템플릿의 "인자"는 치환식들이다 — 템플릿 노드를 통째로 넘기면
    // 자식 순회가 그것들을 본다(리터럴 텍스트는 식별자가 아니라 오탐이 없다).
    const leaks = ts.isCallExpression(node)
      ? node.arguments.some(argumentLeaksBody)
      : argumentLeaksBody(node.template);
    if (leaks) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      hits.push({ file, line, text: (rawLines[line - 1] ?? "").trim() });
    }
  }
  return { hits, logSinkCalls };
}

const scanSourceForBodyLogs = (raw: string, file = "(snippet).ts"): BodyLogHit[] =>
  scanSource(raw, file).hits;

// ── 훑기는 한 번만 한다 (2026-08-26, T-065) ──────────────────────────────────
//
// 아래 계약 3종은 모두 `src` 전체를 훑는다. 종전에는 각자 따로 걸어서 **트리를 세 번
// 읽고 AST 를 두 번 만들었다.** 그래서 「요청 바디…」 항목 하나가 CI 러너가 바쁠 때
// vitest 기본 타임아웃 5000ms 를 넘겨(실측 5543ms) **무관한 PR 이 빨강**이 됐다.
// 이제 워크·읽기·파싱을 한 번으로 합치고 결과를 공유한다.
//
// ⛔ **검사 범위를 좁혀서 빠르게 만든 것이 아니다** — 훑는 파일도 판정도 그대로다.
// 이 스캔은 범위가 곧 방어력이라, 빠르게 하되 덮는 면적은 유지하는 것이 조건이었다.

type SourceFileEntry = { rel: string; raw: string };

let sourceFileCache: SourceFileEntry[] | undefined;

/** 스캔 대상 — 프로덕션 소스 전체(테스트 제외). 디스크는 파일당 한 번만 읽는다. */
function sourceFiles(): SourceFileEntry[] {
  if (sourceFileCache) return sourceFileCache;
  const files: SourceFileEntry[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(rel);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        files.push({ rel, raw: read(rel) });
      }
    }
  };
  walk("src");
  sourceFileCache = files;
  return files;
}

/**
 * 이 파일을 파싱해야 하는가 — 로그 싱크 호출로 가는 **모든** 길은 뿌리에 식별자
 * `console` 또는 `process` 를 두거나(별칭·`globalThis.console`·`console["log"]`
 * 전부 그 글자를 원문에 남긴다), 유니코드 이스케이프로 적혀 `\u` 를 남긴다.
 * 셋 다 없으면 위반 0건·싱크 호출 0건이 **증명된다**(휴리스틱이 아니다).
 *
 * 🪤 **이스케이프 절은 편집증이 아니라 실존하는 구멍이다.** `\u0063onsole.log(body)` 는
 * 원문에 `console` 이라는 글자가 **없는데도** TS 가 식별자 `console` 로 읽는다
 * (2026-08-26 실측). 그 절을 빼면 이 계약이 막으려던 「초록으로 보이는 고장」이
 * 필터 자체에서 되살아난다 — 아래 반증 프로브가 그 자리를 지킨다.
 *
 * ⚠️ **`\x` 는 그 구멍의 나머지 절반이었다(2026-08-27 교차 검증 실측).** 종전에는
 * `\u` 만 봤는데, 문자열 리터럴에서는 **2자리 16진 `\xHH` 도 똑같이 유효한
 * 이스케이프**다 — `window["\x63onsole"]["log"](body)` 는 판정기가 정확히 잡는데
 * 프리필터가 그 파일을 통째로 건너뛰어 **조용히 통과했다.** 같은 부류의 구멍이 절반만
 * 메워져 있었던 셈이다. ⛔ 판정이 새 이스케이프 문법을 읽게 되면 이 목록도 함께
 * 늘린다. (8진 `\143` 은 대상이 아니다 — ES 모듈은 항상 strict 라 문법 오류다.)
 *
 * 실측(2026-08-27): 939 파일 중 **240 개**만 파싱하고(`process` 싱크와 `\x` 절이
 * 들어오며 종전 194 에서 늘었다), 켠 것과 끈 것의 싱크 호출 총계가 **418 로 동일**하다
 * (전수 파싱과 대조해 위반 건수도 양쪽 0 으로 같음을 확인했다).
 * ⛔ 이 술어를 도메인 필터(디렉터리·확장자·역할)로 넓히지 말 것 — 그 순간 등가성
 * 증명이 깨지고 방어 면적이 줄어든다. ⛔ 반대로 싱크를 늘리면서 이 술어의 낱말을
 * 함께 늘리지 않는 것도 금지다 — 새 싱크가 조용히 안 걸린다.
 */
const mightCallLogSink = (raw: string) =>
  raw.includes("console") ||
  raw.includes("process") ||
  raw.includes("\\u") ||
  raw.includes("\\x");

let repositoryScanCache: SourceScan | undefined;

/** 레포 전체 스캔 — 파일당 최대 한 번 파싱하고, 결과를 계약 3종이 공유한다. */
function scanRepository(): SourceScan {
  if (repositoryScanCache) return repositoryScanCache;
  const hits: BodyLogHit[] = [];
  let logSinkCalls = 0;
  for (const { rel, raw } of sourceFiles()) {
    if (!mightCallLogSink(raw)) continue;
    const scanned = scanSource(raw, rel);
    hits.push(...scanned.hits);
    logSinkCalls += scanned.logSinkCalls;
  }
  repositoryScanCache = { hits, logSinkCalls };
  return repositoryScanCache;
}

/**
 * 레포 전수 스캔 항목의 제한시간. vitest 기본값 5000ms 는 **단위 테스트용 예산**이라
 * 939 파일을 읽고 240 개를 파싱하는 이 항목에는 애초에 맞지 않는다.
 *
 * ⚠️ **이건 느린 것을 덮는 마개가 아니라 두 번째 방어선이다** — 첫 번째 방어선은 위의
 * 단일 스캔이고(테스트 합계 2270ms → 674ms, 2026-08-26 실측), 그것만으로도 재현
 * 실패는 사라졌다. 그런데도 제한을 명시하는 이유는 **이 기계가 CI 러너를 함께
 * 호스팅하기 때문**이다: 자가호스트 러너(Colima VM)와 병렬 에이전트 세션이 같은 CPU 를
 * 다투므로 벽시계는 부하에 비례해 늘어나고 그 상한이 없다. 같은 날 실측 —
 * load 247 에서 **개선 전은 2/2 실패**(6316ms · 6458ms), 개선 후는 load 186 에서
 * 1465~2519ms 로 통과했으나 한 차례 **4769ms**(기본 예산의 95%)를 찍었다.
 * 30초는 그 최악 관측의 6배이고, 진짜 hang 은 여전히 이 안에서 잡힌다.
 *
 * ⚠️ **T-066(2026-08-27)에서 이 항목이 다시 무거워졌다 — 그 대가를 여기 적어 둔다.**
 * 실측 **약 490ms → 690ms(중앙값, 약 1.4배)**. 늘어난 몫은 ①파싱 파일 194→240
 * ②별칭 고정점 해석 둘이고, 트리 순회는 여전히 파일당 한 번이다. 위 최악 관측
 * (4769ms)에 같은 비율을 적용하면 약 6.7초 — vitest 기본 예산은 넘지만 이 상한 안이다.
 *
 * 🪤 **이 항목의 절대 ms 를 다른 창에서 잰 값과 비교하지 말 것.** 이 기계는 CI 러너와
 * 병렬 세션을 함께 이고 있어 같은 코드가 load 3 에서 0.5초, load 35 에서 3.6초로 나온다
 * (같은 날 실측). 개선 전후를 **한 창에서 교대로** 재야 비교가 성립한다 — 위 배율이
 * 그렇게 나온 값이고, 따로 잰 절대치로 판단했을 때는 「2배 느려졌다」는 잘못된 경보가
 * 실제로 나왔다.
 *
 * ⛔ **느려졌다고 스캔을 쪼개 범위를 좁히지 말 것** — 이 항목은 덮는 면적이 곧
 * 방어력이고, T-066 은 애초에 그 면적의 구멍을 메운 작업이다.
 *
 * ⛔ 이 값을 올려서 느려짐을 흡수하지 말 것 — 스캔이 다시 무거워지면 그때 고칠 곳은
 * 제한이 아니라 스캔이다(범위를 좁히는 것은 그중에서도 금지다. 범위가 곧 방어력이다).
 */
const REPO_SCAN_TIMEOUT_MS = 30_000;

describe("주민등록번호 노출면 계약", () => {
  it("셀러 목록 페이로드(SellerSummary)에 주민등록번호가 실리지 않는다", () => {
    const summary = read("src/lib/seller-summary.ts");
    expect(
      summary.includes("residentNumber"),
      "seller-summary.ts 는 셀러 전원을 담는 목록 페이로드다 — 주민등록번호를 넣으면 " +
        "전원의 값이 한 번에 브라우저로 내려간다. 단건 엔드포인트를 쓸 것.",
    ).toBe(false);
  });

  it("셀러 목록 API 가 주민등록번호를 조회하지 않는다", () => {
    const listRoute = read("src/app/api/sellers/route.ts");
    expect(listRoute.includes("residentNumber")).toBe(false);
  });

  it("셀러 포털(셀러가 보는 표면)에 주민등록번호가 닿지 않는다", () => {
    const portal = read("src/lib/seller-portal.ts");
    expect(
      portal.includes("residentNumber"),
      "포털은 셀러 본인이 보는 화면이다(P0 Seller-Facing Data Exposure). " +
        "화이트리스트에 신원번호를 넣지 말 것.",
    ).toBe(false);
  });

  it("단건 조회 엔드포인트가 인증 뒤에 있다", () => {
    const rel = "src/app/api/sellers/[id]/settlement-info/route.ts";
    expect(existsSync(join(ROOT, rel))).toBe(true);
    const source = read(rel);
    expect(source).toContain("requireAuth");
    // 인증 실패 시 즉시 반환하는지 — 조회보다 먼저 게이트가 있어야 한다
    expect(source.indexOf("requireAuth")).toBeLessThan(source.indexOf("findUnique"));
  });

  it("요청 바디를 통째로 로그에 찍는 자리가 없다", () => {
    const offenders = scanRepository().hits;
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.text}`),
      "요청 바디(`body`/`payload`/`await req.json()`)를 서버 로그에 통째로 찍고 있다.\n" +
        "이 레포의 요청 바디에는 주민등록번호·계좌번호·법적 실명·연락처가 실린다 " +
        "(updateSellerSchema) — 저장은 암호화·마스킹되는데 로그만 평문으로 남는다.\n" +
        "필요한 신호가 '어떤 키가 왔나'라면 Object.keys(body) 로 키 이름만 남길 것 " +
        "(값 없이 형태만 보이므로 fail-closed 다).",
    ).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  it("바디 로깅 탐지기가 실제로 작동한다(양성·음성 프로브)", () => {
    // 값이 새는 형태 — 전부 걸려야 한다.
    for (const snippet of [
      'console.log("[PATCH] body:", body);',
      "console.error(`bad body: ${body}`);",
      "console.log(JSON.stringify(payload));",
      "console.debug(await request.json());",
      "console.log(reqBody);", // 라우트에서 실제로 쓰이는 이름
      "console.info(json);", // 〃
    ]) {
      expect(scanSourceForBodyLogs(snippet), snippet).not.toEqual([]);
    }
    // 값이 새지 않는 형태 — 걸리면 안 된다.
    for (const snippet of [
      "console.log(Object.keys(body ?? {}));", // 승인된 대안: 키 이름만
      "console.log(draft.body);", // 요청 바디가 아닌 속성 접근
      'console.warn("빈 body 입니다");', // 문자열 안의 단어
      "// console.log(body) — 주석 안의 설명은 위반이 아니다",
      "const raw = process.env.X; console.warn(`bad: ${raw}`);", // 흔한 이름은 목록 밖
    ]) {
      expect(scanSourceForBodyLogs(snippet), snippet).toEqual([]);
    }
  });

  it("console 을 다르게 쓴 형태도 잡는다(우회 형태별 프로브, T-066)", () => {
    // 종전 판정이 **철자 하나**(`console.log`)만 봐서 통과하던 형태들이다. 형태
    // 하나마다 프로브 하나 — 하나가 죽으면 그 줄만 빨강이 되어 어디가 뚫렸는지
    // 바로 읽힌다(총계 하한은 전면 고장만 잡는다).
    for (const [shape, snippet] of [
      ["전역 객체 경유", "globalThis.console.log(body);"],
      ["window 경유", "window.console.error(payload);"],
      ["인덱스 접근", 'console["log"](body);'],
      ["전역 인덱스 접근", 'globalThis["console"]["error"](payload);'],
      ["메서드 별칭", "const log = console.log;\nlog(body);"],
      ["메서드 구조분해", "const { error } = console;\nerror(payload);"],
      ["구조분해 개명", "const { log: say } = console;\nsay(body);"],
      ["객체 별칭", "const c = console;\nc.debug(reqBody);"],
      ["전역 별칭 사슬", "const g = globalThis;\nconst c = g.console;\nconst l = c.log;\nl(body);"],
      ["전역에서 구조분해", "const { console: c } = globalThis;\nc.warn(payload);"],
      ["선언 후 대입", "let log;\nlog = console.log;\nlog(body);"],
      ["사용이 선언보다 앞", "function f() {\n  log(body);\n}\nconst log = console.log;"],
      ["함수 릴레이 call", "console.log.call(null, body);"],
      ["함수 릴레이 apply", "console.log.apply(null, [payload]);"],
      ["bind 결과 호출", "console.log.bind(console)(body);"],
      ["괄호·단언 껍질", "(console as Console).log(body);"],
      // ── 아래 4종은 이 PR 의 교차 검증에서 나왔다(초판이 전부 놓쳤다) ──────────
      ["흐름에 따라 대상이 바뀌는 이름", "let x = globalThis;\nx = console;\nx.log(body);"],
      ["태그드 템플릿", "console.log`leak: ${body}`;"],
      ["문자열 상수 인덱스", 'const key = "log";\nconsole[key](body);'],
      ["배열 구조분해 별칭", "const [log] = [console.log];\nlog(body);"],
      ["16진 이스케이프 인덱스", 'window["\\x63onsole"]["log"](body);'],
      // ⚠️ 아래 둘은 console 우회가 아니라 **다른 싱크**다 — 막는 대상이
      // 「console 이라는 철자」가 아니라 「평문 바디가 서버 로그로 나가는 것」이라
      // 같은 계약이 덮는다.
      ["stdout 직접 쓰기", "process.stdout.write(JSON.stringify(body));"],
      ["stderr 직접 쓰기", "process.stderr.write(String(payload));"],
      ["스트림 별칭", "const out = process.stdout;\nout.write(String(reqBody));"],
    ] as const) {
      expect(scanSourceForBodyLogs(snippet), `${shape}: ${snippet}`).not.toEqual([]);
    }

    // 넓힌 판정이 **무해한 코드를 잡기 시작하면** 계약이 무시당한다 — 그러면 진짜
    // 유출도 함께 통과한다(위 BODY_NAMES 주석과 같은 이유). 음성 대조군:
    for (const [shape, snippet] of [
      // 레포에 실존하는 전역 별칭(api/mobile/order-sync/route.ts)
      ["전역 별칭의 무관한 속성", "const g = globalThis as typeof globalThis;\ng.__rate = body;"],
      ["process 의 무관한 속성", "console.log(process.env.NODE_ENV);"],
      ["console 이 아닌 log 함수", "const log = makeLogger();\nlog(body);"],
      ["바디의 log 속성", "body.log(body);"],
      ["같은 이름의 지역 함수", "function log(x: string) {\n  return x;\n}\nlog(String(body));"],
      ["stdout 이 아닌 write", "socket.write(JSON.stringify(body));"],
      ["키만 남기는 승인된 대안", "globalThis.console.log(Object.keys(body ?? {}));"],
    ] as const) {
      expect(scanSourceForBodyLogs(snippet), `${shape}: ${snippet}`).toEqual([]);
    }
  });

  it("정규식 리터럴 뒤의 위반도 잡는다(초판 스트리퍼가 삼키던 자리)", () => {
    // 초판은 문자 클래스 안의 따옴표를 문자열 시작으로 읽어 **그 아래를 통째로 삼켰다.**
    // 이 레포에 실존하는 형태다(partners-panel.tsx · settlement-statement.ts ·
    // PrintReportButton.tsx). 삼키면 결과가 "위반 0건"이라 고장이 초록으로 보인다.
    const afterRegex = [
      'const safe = name.replace(/[\\/\\\\:*?"<>|]/g, "_");',
      "console.log(reqBody);",
    ].join("\n");
    expect(scanSourceForBodyLogs(afterRegex), "정규식 리터럴 다음 줄의 유출").not.toEqual([]);

    // 나눗셈과 정규식이 섞인 자리도 어휘 분석이 갈라야 한다.
    const withDivision = "const r = a / b / c;\nconsole.log(payload);";
    expect(scanSourceForBodyLogs(withDivision), "나눗셈 뒤의 유출").not.toEqual([]);
  });

  it("파싱 생략 술어가 유출을 숨기지 않는다(반증 프로브)", () => {
    // 걸러도 되는 것 — 싱크 낱말도 이스케이프도 없는 소스.
    expect(mightCallLogSink("export const answer = 1;"), "무해한 소스").toBe(false);
    // 걸러선 안 되는 것 ① — 평범한 호출.
    expect(mightCallLogSink("console.log(body);"), "평범한 console 호출").toBe(true);
    // 걸러선 안 되는 것 ② — 유니코드 이스케이프로 적은 `console`. 원문에는 그 글자가
    // 없지만 TS 는 식별자로 읽으므로, 술어가 이걸 거르면 유출이 조용히 통과한다.
    const escaped = "\\u0063onsole.log(body);";
    expect(escaped.includes("console"), "이 프로브의 전제(원문에 console 글자 없음)").toBe(false);
    expect(mightCallLogSink(escaped), "이스케이프된 console 호출").toBe(true);
    expect(scanSourceForBodyLogs(escaped), "이스케이프된 console 호출의 유출").not.toEqual([]);
    // 걸러선 안 되는 것 ③ — console 을 안 거치는 싱크(T-066). 술어에 `process` 가
    // 빠지면 이 파일은 파싱조차 안 되어 위반이 **조용히** 통과한다.
    const stdout = "process.stdout.write(JSON.stringify(body));";
    expect(stdout.includes("console"), "이 프로브의 전제(원문에 console 글자 없음)").toBe(false);
    expect(mightCallLogSink(stdout), "stdout 싱크").toBe(true);
    expect(scanSourceForBodyLogs(stdout), "stdout 싱크의 유출").not.toEqual([]);
    // 걸러선 안 되는 것 ④ — **16진** 이스케이프로 적은 `console`(2026-08-27 교차
    // 검증). `\u` 절만 있던 동안 판정기는 이걸 정확히 잡는데 프리필터가 파일을 통째로
    // 건너뛰어 조용히 통과했다. 이 프로브가 그 절반의 구멍을 지킨다.
    const hexEscaped = 'window["\\x63onsole"]["log"](body);';
    expect(hexEscaped.includes("console"), "이 프로브의 전제(원문에 console 글자 없음)").toBe(
      false,
    );
    expect(hexEscaped.includes("\\u"), "이 프로브의 전제(\\u 절에 안 걸림)").toBe(false);
    expect(mightCallLogSink(hexEscaped), "16진 이스케이프 console 호출").toBe(true);
    expect(scanSourceForBodyLogs(hexEscaped), "16진 이스케이프 console 호출의 유출").not.toEqual(
      [],
    );
  });

  it("스캐너가 소스를 실제로 훑는다(파싱이 파일을 삼키지 않았다)", () => {
    // 위 "위반 0건"이 **하네스 고장**이어도 초록으로 보인다 — 스캐너가 파일을 못 읽어도
    // 결과는 똑같이 빈 배열이다. 그래서 훑은 양을 따로 센다(2026-08-27 실측: 939 파일 /
    // 싱크 호출 418건 — 파싱 생략 술어를 켠 값과 끈 값이 같다). ⚠️ 이 총합 하한은
    // **전면 고장만** 잡는다 — 파일 몇 개가 국지적으로 안 읽히는 것은 못 본다. 국지
    // 고장에 대한 실제 방어는 위의 「정규식 리터럴 뒤의 위반도 잡는다」·「console 을
    // 다르게 쓴 형태도 잡는다」 프로브이지 이 숫자가 아니다.
    expect(scanRepository().logSinkCalls).toBeGreaterThan(150);
  }, REPO_SCAN_TIMEOUT_MS);

  it("허용 목록 밖 파일에는 주민등록번호가 등장하지 않는다", () => {
    // `__tests__` 디렉터리는 통째로 제외한다(테스트 픽스처는 이 계약의 대상이 아니다) —
    // 종전 자체 워크의 `entry.name === "__tests__"` 스킵과 같은 집합이다.
    const offenders = sourceFiles()
      .filter(({ rel }) => !rel.split("/").includes("__tests__"))
      .filter(({ rel }) => !ALLOWED_FILES.includes(rel))
      .filter(({ raw }) => raw.includes("residentNumber"))
      .map(({ rel }) => rel);
    expect(
      offenders,
      `주민등록번호가 허용 목록 밖 파일에 등장한다:\n${offenders.join("\n")}\n` +
        "새 소비처가 정당하다면 ALLOWED_FILES 에 사유와 함께 등재할 것.",
    ).toEqual([]);
  });
});
