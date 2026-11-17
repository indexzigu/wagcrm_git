import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { CAMPAIGN_STATUSES } from "../campaign-status";
import { DEAL_STATUSES } from "../deal-status";
import { updateCampaignSchema } from "../validations/campaign-update";
import { campaignChecklistStatusSchema } from "../validations/campaign-checklist";
import { updateDealSchema } from "../validations/deal";

/**
 * 상태값 **전체 목록**은 한 곳에만 적는다 — 캠페인은 `campaign-status.ts`, 딜은 `deal-status.ts`.
 *
 * 두 목록 모두 손으로 복사된 사본이 여럿 있었다(캠페인 8개 값: zod 스키마 5곳 + 봇 도구 1곳 + 순서 목록,
 * 딜 6개 값: 검증 스키마 + 봇 검색 도구). 캠페인 상태는 DB 에서 자유 문자열이라 사본이 갈리면 막아 줄
 * 것이 없다 — 화면 저장은 받는데 봇 기안은 거절하는 식으로 조용히 어긋난다.
 *
 * 판정은 TypeScript AST 다(주석·설명 문자열을 잘못 집지 않는다). 배열 리터럴의 원소가 전부 문자열이고
 * 그 **집합이 전체 목록과 같으면** 재선언으로 본다. 부분 집합(정산 단계·칸반 열·DROPPED 를 뺀 순서
 * 목록)은 다른 질문에 답하는 목록이라 대상이 아니다.
 */
const SRC = join(__dirname, "..", "..");

const FULL_LISTS: Record<string, { values: readonly string[]; home: string }> = {
  campaign: { values: CAMPAIGN_STATUSES, home: "lib/campaign-status.ts" },
  deal: { values: DEAL_STATUSES, home: "lib/deal-status.ts" },
};

// 정본 밖에서 글자를 펼쳐 둘 수밖에 없는 곳. 봇 작업 계약 파일은 봇 쪽(파이썬) 미러 테스트가 이 파일의
// **글자**를 읽어 대조하므로 상수 참조로 바꿀 수 없다. 대신 아래에서 "여전히 전체 목록과 같다"를 확인해
// 정본에 값이 늘면 이 사본도 고치도록 강제한다.
const LITERAL_MIRRORS: Record<string, string> = {
  "lib/agent-worker/contracts.ts": "deal",
};

export function findFullStatusListLiterals(source: string, fileName = "probe.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 0) {
      const texts = node.elements.map((el) =>
        ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el) ? el.text : null,
      );
      if (texts.every((t): t is string => t !== null)) {
        const set = new Set(texts);
        for (const [name, { values }] of Object.entries(FULL_LISTS)) {
          if (set.size === values.length && values.every((v) => set.has(v))) hits.push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const PREFILTER_NEEDLES = ["SETTLEMENT_IN_PROGRESS", "SAMPLE_TESTING", "\\u", "\\x"];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "generated" ? [] : listSourceFiles(full);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

describe("상태 전체 목록 SSOT", () => {
  it("스캐너가 재선언을 잡고 부분 집합·주석은 지나친다(프로브)", () => {
    const full = CAMPAIGN_STATUSES.map((s) => `"${s}"`).join(", ");
    expect(findFullStatusListLiterals(`const a = z.enum([${full}]);`)).toEqual(["campaign"]);
    // 순서가 달라도, 유니코드 이스케이프로 적어도 같은 목록이다.
    const reversed = [...DEAL_STATUSES].reverse().map((s) => `"${s}"`).join(", ");
    expect(findFullStatusListLiterals(`const d = [${reversed}] as const;`)).toEqual(["deal"]);
    expect(
      findFullStatusListLiterals(`const a = [${full.replace('"DROPPED"', '"\\u0044ROPPED"')}];`),
    ).toEqual(["campaign"]);
    // 부분 집합과 주석은 대상이 아니다.
    expect(findFullStatusListLiterals(`const s = ["CLOSED", "SETTLEMENT_WAIT", "COMPLETED"];`)).toEqual([]);
    expect(findFullStatusListLiterals(`// const a = [${full}];\nconst b = 1;`)).toEqual([]);
  });

  it("전체 목록을 정본 파일 밖에서 다시 적은 곳이 없다", () => {
    const files = listSourceFiles(SRC);
    expect(files.length).toBeGreaterThan(500);
    const violations: string[] = [];
    let scannedHomes = 0;
    const mirrorsStillEqual = new Set<string>();
    for (const file of files) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, "utf8");
      // 파싱 전 지름길: 각 목록의 대표 값이 글자로도, 유니코드 이스케이프로도 없으면 재선언일 수 없다.
      // (`\u` 를 함께 보지 않으면 이스케이프로 적은 사본이 지름길에서 빠진다.)
      if (!PREFILTER_NEEDLES.some((needle) => text.includes(needle))) continue;
      const hits = findFullStatusListLiterals(text, file);
      for (const name of hits) {
        if (rel === FULL_LISTS[name].home) scannedHomes += 1;
        else if (LITERAL_MIRRORS[rel] === name) mirrorsStillEqual.add(rel);
        else violations.push(`${rel} — ${name} 상태 전체 목록 재선언`);
      }
    }
    // 정본 두 곳이 실제로 스캔에 잡혔다 = 스캐너가 이 트리에서 살아 있다.
    expect(scannedHomes).toBe(2);
    expect(violations).toEqual([]);
    // 펼쳐 둔 사본이 정본과 갈라지면(값 추가·삭제) 스캐너에 안 잡히게 되므로 여기서 빨개진다.
    expect([...mirrorsStillEqual].sort()).toEqual(Object.keys(LITERAL_MIRRORS).sort());
  }, 60_000);

  it("검증 스키마가 정본 목록을 그대로 받는다", () => {
    expect(campaignChecklistStatusSchema.options).toEqual([...CAMPAIGN_STATUSES]);
    for (const status of CAMPAIGN_STATUSES) {
      expect(updateCampaignSchema.safeParse({ status }).success).toBe(true);
    }
    expect(updateCampaignSchema.safeParse({ status: "UNKNOWN" }).success).toBe(false);
    for (const status of DEAL_STATUSES) {
      expect(updateDealSchema.safeParse({ status }).success).toBe(true);
    }
  });
});
