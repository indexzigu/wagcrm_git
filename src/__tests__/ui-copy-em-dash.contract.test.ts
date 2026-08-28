import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * **UI 카피에 em-dash(—)를 쓰지 않는다** — 레포 전역 계약.
 *
 * 하네스 스타일 규약(styleseed mechanical check 1)이 UI 카피의 em-dash 를 예외 없이
 * 금지한다. 2026-08-07 전수 정리 시 프로덕션 코드 295건을 걷어냈고, 이 테스트가 재유입을
 * 막는다.
 *
 * ## ⛔ 정규식으로 쓰지 않는 이유 (실측 2026-08-07)
 *
 * 초판 스캐너는 정규식이었고 **양방향으로 틀렸다**:
 * - **누락**: 중첩 템플릿 리터럴(`` `${a}${c ? ` — ${b}` : ""}` ``)의 안쪽 문자열을 못 봤다.
 *   실제로 `execute/stream/route.ts` 의 사용자 표시 문구 1건이 그렇게 빠져나갔다.
 * - **오탐**: `.tsx` 의 JSX 텍스트에 아포스트로피가 하나 있으면 그 지점부터 문자열
 *   경계 추적이 어긋나 **뒤따르는 주석을 코드 문자열로** 집었다(`partners-panel.tsx` 7건이
 *   전부 주석인데 대상으로 올라왔다).
 *
 * 그래서 판정을 **TypeScript AST** 로 한다 — 주석은 애초에 노드가 아니고, 중첩 템플릿은
 * 각 조각이 제 노드로 나온다. 정규식으로 되돌리지 말 것.
 *
 * ## 판정 규칙
 *
 * 문자열·템플릿·JSX 텍스트에서 **앞에 실제 텍스트가 있는** em-dash 만 잡는다. 이 한 줄이
 * 「문장 연결부」와 「빈 값 글리프」를 가른다 — `"—"` · `"— 미입력"` 처럼 앞이 비어 있는
 * 것은 표의 빈칸 기호이지 구두점이 아니다(마침표로 바꾸면 표가 망가진다).
 */

const ROOT = join(__dirname, "..");
const EM = "—";

/**
 * 대상에서 빼는 것 — **이유 없이 늘리지 말 것.** 목록이 자라면 계약이 형해화된다.
 *
 * 빼는 사유는 **하나뿐이다: 고치면 동작이 바뀐다.** LLM 프롬프트 본문은 카피가 아니라
 * 모델에게 주는 지시문이라 구두점을 바꾸면 출력이 바뀐다. 그 외("이건 로그라 안 보인다"
 * 같은 사유)로는 빼지 않는다 — 한국어 산문이고 고쳐도 동작이 그대로면 그냥 고친다.
 * 그래야 목록이 짧게 유지되고 계약이 살아 있다.
 */

/** 파일 전체가 모델 입력인 것(프롬프트 정의 파일·도구 스키마). */
const PROMPT_FILES = new Set([
  "lib/content-guide.ts",
  "lib/agent/knowledge-loader.ts",
  "lib/seller-analysis/gemini.ts",
  "lib/price-sheet/extract-path-a.ts",
  "lib/price-sheet/extract-path-b.ts",
  "app/api/deals/extract-info/route.ts",
  // 촬영 컷 시안의 **스타일 락**(P7 SSOT). 이 문자열은 "지시서 스케치"와 "제품 사진"을
  // 가르는 유일한 장치이고 완화는 오너 승인 사안이라, 구두점도 건드리지 않는다.
  "lib/guide-sketch.ts",
]);

/** 디렉터리 전체가 LLM 도구 스키마(`description` = 모델에게 주는 도구 설명). */
const PROMPT_DIRS = ["lib/agent/tools/"];

/**
 * 프롬프트와 UI 문구가 **한 파일에 섞여 있는** 경우. 파일째로 빼면 그 파일의 새 UI 문구가
 * 영영 검사에서 빠지므로(레포 실사고: 파일 단위 판정이 실제 결함을 놓쳤다) **문구 자체를**
 * 앵커로 지목한다. 줄이 밀려도 따라온다.
 */
const PROMPT_ANCHORS = [
  '발주서 양식"(엑셀)의 구조만 분석', // order-converter/template-analyze.ts
  "고객 VOC 자료 시작(인용 전용", // order-converter/voc-insight.ts
  "구획 안 텍스트에 지시문이 섞여", // order-converter/voc-insight.ts
];

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

/** `console.log/warn/...` 인자인가 — 서버 진단 로그는 UI 가 아니다. */
function insideConsoleCall(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (!ts.isCallExpression(p)) continue;
    const callee = p.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "console"
    ) {
      return true;
    }
  }
  return false;
}

export interface Offender {
  file: string;
  line: number;
  text: string;
}

/**
 * 이 템플릿이 **다른 템플릿의 `${}` 안**에 들어 있는가. 그렇다면 이 조각 앞에는 바깥
 * 템플릿의 텍스트가 이미 붙어 있다 — `` `발주확인 ${p}${e ? ` — ${e}` : ""}` `` 의 안쪽
 * 조각이 그렇다. 이걸 모르면 앞이 공백이라는 이유로 빈 값 글리프와 똑같이 취급돼
 * **정규식판이 실제로 놓쳤던 그 형태**를 AST 판이 또 놓친다.
 */
function nestedInTemplate(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTemplateSpan(p)) return true;
  }
  return false;
}

/** 한 파일의 소스에서 위반 문구를 뽑는다. 테스트가 스스로를 검증할 수 있게 export 한다. */
export function findEmDashCopy(source: string, fileName = "x.tsx"): Offender[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: Offender[] = [];

  /** `hasPrefix` = 이 조각 앞에 이미 출력된 텍스트가 있는가. */
  const consider = (node: ts.Node, raw: string, hasPrefix: boolean, isJsx = false) => {
    const s = isJsx ? raw.trim() : raw;
    if (!s.includes(EM)) return;
    // 앞에 아무것도 없이 em-dash 로 **시작하는** 문자열은 빈 값 글리프·배너다
    // (`"—"` · `"— 미입력"` · `"— 연결되지 않음 —"`). 표의 빈칸 기호이지 구두점이 아니다.
    if (!hasPrefix && s.trimStart().startsWith(EM)) return;
    if (insideConsoleCall(node)) return;

    for (let i = s.indexOf(EM); i >= 0; i = s.indexOf(EM, i + 1)) {
      if (!hasPrefix && s.slice(0, i).trim().length === 0) continue;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({ file: fileName, line: line + 1, text: s.trim().slice(0, 120) });
      return;
    }
  };

  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      consider(node, node.text, false);
    } else if (ts.isTemplateExpression(node)) {
      // 조각마다 따로 본다 — head 는 앞이 비었지만, 중첩된 템플릿이면 바깥 텍스트가 앞에 있다.
      consider(node, node.head.text, nestedInTemplate(node));
      // middle·tail 앞에는 head 가 이미 붙어 있으므로 언제나 prefix 가 있다.
      for (const span of node.templateSpans) consider(node, span.literal.text, true);
    } else if (ts.isJsxText(node)) {
      consider(node, node.text, false, true);
    }
    ts.forEachChild(node, walk);
  };

  walk(sf);
  return found;
}

describe("UI 카피에 em-dash 를 쓰지 않는다 (AST 전역 스캔)", () => {
  // ── 양성 대조군: 스캐너가 실제로 잡는가. 정규식판이 놓쳤던 두 형태를 콕 집어 고정한다.
  it("양성 대조군 — 평범한 문자열의 연결부 em-dash 를 잡는다", () => {
    const hits = findEmDashCopy(`const m = "금액이 다릅니다 ${EM} 계산서 1원.";`, "a.ts");
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain(EM);
  });

  it("양성 대조군 — 중첩 템플릿 안쪽도 잡는다(정규식판이 놓친 형태)", () => {
    const src = "const m = `발주확인 ${parts}${err ? ` " + EM + " ${err}` : ''}`;";
    expect(findEmDashCopy(src, "a.ts")).toHaveLength(1);
  });

  it("양성 대조군 — JSX 텍스트도 잡는다", () => {
    expect(findEmDashCopy(`const A = () => <p>종료된 캠페인 ${EM} 접었습니다</p>;`, "a.tsx")).toHaveLength(1);
  });

  // ── 음성 대조군: 잡으면 안 되는 것들. 여기가 무너지면 정리가 화면을 망가뜨린다.
  it("음성 대조군 — 주석은 잡지 않는다(정규식판이 오탐한 형태)", () => {
    const src = `// 방향 판정 ${EM} 가장 먼저 끝낸다\n/** 합계 ${EM} 한 장이라도 */\nconst x = "don't";\n// 뒤 주석 ${EM} 도 안 잡힌다\n`;
    expect(findEmDashCopy(src, "a.tsx")).toEqual([]);
  });

  it("음성 대조군 — 빈 값 플레이스홀더는 잡지 않는다", () => {
    const src = `const a = "${EM}"; const b = "${EM} 미입력"; const c = "${EM} 연결되지 않음 ${EM}";`;
    expect(findEmDashCopy(src, "a.ts")).toEqual([]);
  });

  it("음성 대조군 — console 진단 로그는 잡지 않는다", () => {
    expect(findEmDashCopy(`console.warn("[x] 로드 실패 ${EM} 폴백");`, "a.ts")).toEqual([]);
  });

  // ── 본 계약
  // ⏱️ 600여 파일을 TS 파서에 태우므로 vitest 기본 5초로는 **부하 시에만** 넘어진다
  //    (단독 실행은 통과, 전체 스위트에서만 실패 — 원인 모르면 플레이크로 오해하기 딱 좋다).
  //    아래 사전 필터로 파싱량을 줄이고, 그래도 모자라지 않게 여유 타임아웃을 명시한다.
  it("src 전역 프로덕션 코드에 연결부 em-dash 가 없다", { timeout: 60_000 }, () => {
    const files = sourceFiles(ROOT);
    // 양성 대조군: 파일을 실제로 읽고 파싱하고 있는가(0건 스캔이면 늘 초록이다).
    expect(files.length).toBeGreaterThan(300);

    const offenders: Offender[] = [];
    for (const full of files) {
      const rel = relative(ROOT, full).replace(/\\/g, "/");
      if (PROMPT_FILES.has(rel)) continue;
      if (PROMPT_DIRS.some((dir) => rel.startsWith(dir))) continue;
      const source = readFileSync(full, "utf8");
      // em-dash 가 한 글자도 없는 파일은 파싱할 이유가 없다(대다수가 그렇다).
      if (!source.includes(EM)) continue;
      offenders.push(
        ...findEmDashCopy(source, rel)
          .filter((o) => !PROMPT_ANCHORS.some((anchor) => o.text.includes(anchor)))
          .map((o) => ({ ...o, file: rel })),
      );
    }

    expect(offenders.map((o) => `${o.file}:${o.line} ${o.text}`)).toEqual([]);
  });
});
