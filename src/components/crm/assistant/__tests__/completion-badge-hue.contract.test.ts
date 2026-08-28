import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * 비서 표면 「완료」 배지의 hue 계약.
 *
 * 배경(오너 승인 2026-08-26): 이 디렉터리의 완료 배지 7곳이 `status-active`
 * (브랜드 네이비 #0A3D62 틴트)를 쓰고 있었다. P8 §4 는 그 틴트를 "5개 의미축의
 * hue 가 아니라 **중립 태그 캐리어**"로만 허용하고 *"판정·심각도 의미로 쓰는 것은
 * 금지"* 한다 — 「끝났다/안 끝났다」는 그 금지 용법이다. 더 나쁜 것은 의미가
 * **정반대**였다는 점이다: 생애주기 SSOT(`StatusBadge`)에서 `status-active` 는
 * ACTIVE(=진행 중)이고 COMPLETED 가 `status-success` 다.
 *
 * ⛔ 이 결함은 tsc·eslint·기존 렌더 테스트를 **전부 통과한다**(대비도 9.48:1 로
 * AA 통과였다 — 접근성이 아니라 의미축 문제다). 사람이 규칙과 대조해야만 보이므로
 * 그물을 여기 둔다.
 *
 * 개별 렌더 검증은 각 컴포넌트 테스트가 한다(`data-variant` 단언). 이 파일은
 * **아직 없는 5번째 완료 배지**가 네이비로 들어오는 것을 막는 전수 그물이다.
 */

const ASSISTANT_DIR = join(process.cwd(), "src", "components", "crm", "assistant");

/**
 * 「끝났다」를 뜻하는 배지 문구. 「승인 대기」·「승인됨·실행 중」 같은 진행 상태는 안 걸린다.
 *
 * ⚠️ **이 그물의 경계 두 방향**(ss-ux-designer 검토 2026-08-26, P2 — 지금은 무해하나
 * 넓힐 때 함께 보라):
 * ① 놓침 — 「처리됨」·「확정」·「지급됨」처럼 **다른 어휘로 완료를 말하는** 배지가 새로
 *    생기면 안 걸린다. 완료 배지를 추가하는 사람은 이 정규식도 함께 넓힌다.
 * ② 오탐 — 앵커 없는 부분일치라 「미완료」·「완료 예정」·「완료율」이 생기면 그 배지에까지
 *    status-success 를 강제한다(현재 이 디렉터리에 그런 라벨은 없다).
 *
 * ⚠️ 스캔 범위도 **JSX 의 `<Badge variant=…>` 인라인 선언뿐**이다 — variant 를
 * `Record<string, …>` 표에 담아 쓰는 형태(price-sheet 계열)는 이 그물 밖이다.
 */
const COMPLETION_TEXT = /완료|실행됨|자동승인/;

/** ⛔ 판정 의미로 쓰면 안 되는 브랜드 네이비 틴트(P8 §4). */
const FORBIDDEN_VARIANT = "status-active";
/** 생애주기축의 「완료」 어휘 — StatusBadge 의 COMPLETED 와 같은 토큰(신규 hue 아님). */
const REQUIRED_VARIANT = "status-success";

type Site = { file: string; text: string; variants: string[] };

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function tagNameOf(node: ts.JsxElement): string {
  return node.openingElement.tagName.getText();
}

/** 노드 아래의 모든 문자열 리터럴(삼항 양쪽·템플릿 조각 포함). */
function stringLiteralsUnder(node: ts.Node): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    n.forEachChild(walk);
  };
  walk(node);
  return out;
}

/**
 * 배지가 실제로 보여줄 **문자 그대로의** 텍스트.
 * `{SETTLEMENT_STATE_LABELS[state]}` 같은 간접 참조는 리터럴이 아니므로 잡지 않는다 —
 * 그 배지들은 이 계약의 대상이 아니다(이미 무채 `outline` 이고 오너 승인 범위 밖).
 */
function literalTextOf(node: ts.JsxElement): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) parts.push(child.text);
    else if (ts.isJsxExpression(child) && child.expression) {
      parts.push(...stringLiteralsUnder(child.expression));
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function variantLiteralsOf(node: ts.JsxElement): string[] {
  for (const attribute of node.openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== "variant") continue;
    if (!attribute.initializer) continue;
    return stringLiteralsUnder(attribute.initializer);
  }
  return [];
}

function findCompletionBadges(fileLabel: string, source: string): Site[] {
  const sites: Site[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node) && tagNameOf(node) === "Badge") {
      const text = literalTextOf(node);
      if (COMPLETION_TEXT.test(text)) {
        sites.push({ file: fileLabel, text, variants: variantLiteralsOf(node) });
      }
    }
    node.forEachChild(walk);
  };
  walk(parse(fileLabel, source));
  return sites;
}

function scanAssistantDir(): Site[] {
  return readdirSync(ASSISTANT_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .flatMap((name) => findCompletionBadges(name, readFileSync(join(ASSISTANT_DIR, name), "utf8")));
}

describe("비서 표면 완료 배지 hue 계약", () => {
  // ⚠️ 음성 대조군 — 스캐너가 고장 나면 위반이 0건으로 보여 **초록이 곧 무의미**해진다.
  // 실제로 이 레포에서 소스 스캔 계약이 조용히 고장 난 전례가 있다.
  it("[대조군] 네이비 완료 배지를 넣은 픽스처는 확실히 걸린다", () => {
    const fixture = `
      const A = () => <Badge variant="status-active">실행 완료</Badge>;
      const B = () => <Badge variant={done ? "status-active" : "outline"}>입금 {done ? "완료" : "대기"}</Badge>;
      const C = () => <Badge variant="status-pending">승인 대기</Badge>;
    `;
    const sites = findCompletionBadges("fixture.tsx", fixture);

    expect(sites.map((s) => s.text)).toEqual(["실행 완료", "입금 완료 대기"]);
    expect(sites.every((s) => s.variants.includes(FORBIDDEN_VARIANT))).toBe(true);
    // 진행 상태(「승인 대기」)는 완료 어휘가 아니므로 그물에 걸리지 않는다.
    expect(sites.some((s) => s.text.includes("승인 대기"))).toBe(false);
  });

  it("[대조군] 간접 참조 배지는 대상이 아니다 (정산 리포트 상태 칸)", () => {
    const fixture = `const A = () => <Badge variant="outline">{LABELS[state] ?? state}</Badge>;`;
    expect(findCompletionBadges("fixture.tsx", fixture)).toEqual([]);
  });

  it("완료 배지를 실제로 찾아낸다 — 4개 파일이 모두 관측된다", () => {
    const sites = scanAssistantDir();

    expect(sites.length).toBeGreaterThanOrEqual(7);
    expect([...new Set(sites.map((s) => s.file))].sort()).toEqual(
      ["approval-inbox.tsx", "evidence-table.tsx", "proposal-card.tsx", "tool-result-views.tsx"].sort()
    );
  });

  it("완료 배지는 status-success 를 쓴다 — status-active(네이비) 금지 (P8 §4)", () => {
    const sites = scanAssistantDir();

    const navy = sites.filter((s) => s.variants.includes(FORBIDDEN_VARIANT));
    expect(
      navy.map((s) => `${s.file}: "${s.text}"`),
      "브랜드 네이비 틴트를 판정 의미로 쓰고 있다 — 근거는 proposal-card StatusChip 주석"
    ).toEqual([]);

    const missing = sites.filter((s) => !s.variants.includes(REQUIRED_VARIANT));
    expect(missing.map((s) => `${s.file}: "${s.text}" → ${s.variants.join("|")}`)).toEqual([]);
  });
});
