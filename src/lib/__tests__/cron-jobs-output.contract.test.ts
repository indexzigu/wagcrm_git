import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { KNOWN_JOBS } from "@/lib/cron-jobs";

/**
 * 산출 선언 계약 — 「성공 기록인데 산출 없음」(사고 B) 판정의 전제를 고정한다.
 *
 *  O1. 19개 작업 전부가 `output` 키를 **명시적으로** 가진다(선언 또는 `null` 면제). 키를 빠뜨린
 *      작업은 「판정 대상인지」를 아무도 정하지 않은 상태라, 그 작업의 산출 0 이 영영 안 잡힌다.
 *  O2. 선언 대상은 실질 실패 선언(`declareTotalFailure`·`declareStoryCaptureOutcome`)을
 *      쓰는 작업 중 판정 면제를 뺀 5개와 정확히 같다(설계 ⚙️J8).
 *  O3. 실질 실패 선언을 부르는 크론 라우트의 작업 키 ⊆ 선언 집합 ∪ 사유 있는 면제 — 새 수집 작업이
 *      선언도 면제 사유도 없이 생기면 여기서 깨진다.
 *
 * ⚠️ 소스 스캔은 정규식이 아니라 **컴파일러(AST)** 로 한다 — 주석에 함수 이름만 적힌 라우트가
 * 호출하는 것으로 잡히면 안 되고, 손수 만든 주석 제거기는 문자열·정규식 리터럴에서 틀린다.
 */

const root = process.cwd();
const CRON_DIR = join(root, "src/app/api/cron");
const OUTCOME_FUNCTIONS = new Set(["declareTotalFailure", "declareStoryCaptureOutcome"]);

// 실질 실패 선언은 쓰지만 「산출 0」 판정은 면제한 작업 — 면제는 사유와 함께만 둔다.
const EXEMPT_WITH_REASON: Record<string, string> = {
  "capture-stories":
    "스토리는 24시간이면 사라지고 셀러가 며칠씩 안 올리는 것이 흔해 산출 0 만으로 고장을 못 가른다(2026-10-20 첫 실 B 경보가 거짓 경보)",
};

const EXPECTED_DECLARED: Record<string, string> = {
  "collect-instagram": "인스타 지표",
  "collect-youtube": "유튜브 지표",
  "collect-campaign-posts": "캠페인 게시물",
  "enrich-references": "참조 지표",
  "analyze-voc": "VOC 분석",
};

function parse(raw: string): ts.SourceFile {
  return ts.createSourceFile("scan.ts", raw, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
}

/** 이 소스가 실질 실패 선언 함수를 **호출**하는가(주석·문자열 속 이름은 세지 않는다). */
function callsOutcomeDeclaration(raw: string): boolean {
  const sourceFile = parse(raw);
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && OUTCOME_FUNCTIONS.has(node.expression.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** `withSystemTaskStatus("<key>", …)` 의 첫 인자 — 라우트가 기록하는 작업 키. */
function wrappedJobKey(raw: string): string | null {
  const sourceFile = parse(raw);
  let key: string | null = null;
  const visit = (node: ts.Node) => {
    if (key) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "withSystemTaskStatus" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      key = node.arguments[0].text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return key;
}

describe("KNOWN_JOBS 산출 선언 계약", () => {
  it("O1: 모든 작업이 output 키를 명시적으로 가진다(선언 또는 null 면제)", () => {
    expect(KNOWN_JOBS.length).toBe(19);
    // 타입상 필수라 `in` 은 never 로 좁혀진다 — 실제 객체에 키가 **있는지**를 런타임으로 본다.
    const missing = KNOWN_JOBS.filter((job) => !Object.hasOwn(job, "output")).map((job) => job.key);
    expect(missing).toEqual([]);
  });

  it("O2: 선언 대상은 정확히 5개(면제 제외)이고 라벨·연속 횟수가 설계와 같다", () => {
    const declared = Object.fromEntries(
      KNOWN_JOBS.filter((job) => job.output != null).map((job) => [job.key, job.output]),
    );
    expect(Object.keys(declared).sort()).toEqual(Object.keys(EXPECTED_DECLARED).sort());
    for (const [key, label] of Object.entries(EXPECTED_DECLARED)) {
      expect(declared[key]).toEqual({ label, zeroRunsToFlag: 2 });
    }
  });

  it("O3: 실질 실패 선언을 부르는 라우트는 전부 output 을 선언했다", () => {
    const declaredKeys = new Set(KNOWN_JOBS.filter((job) => job.output != null).map((job) => job.key));
    const callers: string[] = [];
    for (const dir of readdirSync(CRON_DIR)) {
      const file = join(CRON_DIR, dir, "route.ts");
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, "utf-8");
      if (!callsOutcomeDeclaration(raw)) continue;
      callers.push(wrappedJobKey(raw) ?? dir);
    }
    // 음성 대조군 — 스캔이 아무것도 못 찾으면 ⊆ 가 공허하게 통과한다.
    expect(callers.length).toBeGreaterThanOrEqual(6);
    expect(callers.filter((key) => !declaredKeys.has(key) && !(key in EXEMPT_WITH_REASON))).toEqual([]);
    // 면제는 실제로 선언 없이 남아 있어야 하고(면제 목록이 죽은 항목이 되지 않게) 사유가 비면 안 된다.
    for (const [key, reason] of Object.entries(EXEMPT_WITH_REASON)) {
      expect(KNOWN_JOBS.find((job) => job.key === key)?.output, key).toBeNull();
      expect(callers, key).toContain(key);
      expect(reason.trim().length, key).toBeGreaterThan(10);
    }
  });

  it("스캐너 반증: 주석·문자열 속 이름은 호출로 세지 않고, 실제 호출은 센다", () => {
    expect(callsOutcomeDeclaration("// declareTotalFailure({ attempted: 1 })\nexport const x = 1;")).toBe(false);
    expect(callsOutcomeDeclaration("/* declareStoryCaptureOutcome(r) */ const s = 'declareTotalFailure(x)';")).toBe(false);
    expect(callsOutcomeDeclaration("const o = declareTotalFailure({ attempted: 1, succeeded: 0 });")).toBe(true);
    expect(wrappedJobKey('export const GET = withSystemTaskStatus("job-z", handler);')).toBe("job-z");
  });
});
