import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  ALLOWED_UPPERCASE_WORDS,
  DEV_WORDS,
  MONEY_TERM_ALIASES,
  RAW_CODE_FIELDS,
  STATUS_WORD_SPACING,
} from "@/lib/ui-glossary";

/**
 * **화면 문구 기준 기계 검사** — `docs/agents/product-ux.md` P2 「화면 문구 기준」의 집행면.
 *
 * 새 버튼·카드·배지를 넣을 때 아래 여섯 부류가 오너 화면까지 가지 않게 막는다.
 * - `spaced`   : 띄어 쓴 상태 낱말(「승인 대기」 → 「승인대기」, 오너 확정 2026-10-08)
 * - `fallback` : 라벨 표에 없으면 코드값으로 되돌려 보이는 코드(`라벨표[x] ?? x`)
 * - `rawField` : 코드값 필드(`status`·`type`…)를 라벨 표 없이 화면에 그리는 코드
 * - `rawCode`  : 화면 글자 자체가 대문자 코드값(`PENDING`)
 * - `devWord`  : 화면 글자에 개발 용어(null·payload·레코드·파라미터…)
 * - `oldMoneyTerm` : 옛 돈 이름(「총 마진」·「영업수익」…) — 문자열 **전체가** `MONEY_TERM_ALIASES` 키일 때만
 *
 * 낱말 목록은 용어집(`src/lib/ui-glossary.ts`)이 정본이다 — 여기에 다시 적지 않는다.
 *
 * ## 기준 목록(BASELINE)은 줄이기만 한다
 * 도입 시점(2026-10-15)에 이미 있던 위반은 `BASELINE` 에 묶었다 — 이 검사의 목적은 **새로 생기는
 * 것**을 막는 것이고, 기존 화면 정리는 별도 작업이다. 그래서 두 방향으로 실패한다.
 * - 기준 목록에 없는 위반이 생기면 실패 → 새 문구를 고친다.
 * - 기준 목록의 항목이 코드에서 사라졌으면 실패 → 그 줄을 지운다(고친 것을 영구히 고정한다).
 * 줄 번호를 키에 넣지 않는다 — 위에 한 줄만 끼워도 전부 「새 위반」이 되면 아무도 안 믿는다.
 *
 * ## 대상이 아닌 것(일부러)
 * - 주석·`console.*` 인자·비교식(`status === "PENDING"`)·`className` 같은 비표시 속성.
 * - 문장 속 띄어쓰기(「진행 중인 캠페인이 없습니다」) — 맞춤법대로 띄우는 것이 맞다.
 * - 같은 뜻 다른 이름(「인플루언서」/「셀러」)·말투·은유 — 기계가 판정할 수 없다. P8 Design
 *   Capability Routing 3번 검토가 판정한다.
 * - 🪤 알려진 사각 ①: `rawCode`·`devWord` 는 JSX 글자·보이는 속성(`VISIBLE_ATTRS`)에 **직접 쓴**
 *   문자열만 본다. 변수·`.ts` 상수·토스트 인자(`toast.error("…")`)·임의 prop(`message=`)으로 건너간
 *   문구는 못 본다 — 어디서 그려지는지 정적으로 따라갈 수 없어서다. 그 부분은 P8 3번 검토 몫이다.
 * - 🪤 알려진 사각 ②: 라벨 표 이름에 `label` 이 없으면(`STATUS_MAP[x] ?? x`) `fallback` 이 못 본다.
 * - 🪤 알려진 사각 ③: 라벨 표를 거치지 않은 값을 **변수에 담았다가** 그리면(`const s = row.status;
 *   … {s}`) `rawField` 가 못 본다. 식별자만으로는 한국어가 담겼는지 알 수 없어서다(오탐 실측).
 *
 * TS AST 로 판정한다 — 정규식이 놓치고 오탐한 실측은 `ui-copy-em-dash.contract.test.ts` 머리말.
 */

const ROOT = join(__dirname, "..");

export type CopyRule = "spaced" | "fallback" | "rawField" | "rawCode" | "devWord" | "oldMoneyTerm";

export interface CopyIssue {
  rule: CopyRule;
  file: string;
  line: number;
  text: string;
}

/** 화면에 글자로 보이는 JSX 속성. `className`·`href`·`key` 같은 것은 화면 글자가 아니다. */
const VISIBLE_ATTRS = new Set(["title", "placeholder", "aria-label", "alt", "label", "description", "hint"]);

/** 셀러 포털은 셀러 본인의 「매출」을 보는 표면이라 돈 낱말 통일 대상이 아니다(오너 확정 2026-10-16). */
const MONEY_EXEMPT_PATHS = ["components/portal/", "app/[slug]/", "app/p/"];

const DEV_WORD_PATTERN = buildDevWordPattern(Object.keys(DEV_WORDS));
const UPPERCASE_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const MIN_CODE_LENGTH = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 영문 낱말은 경계로(「annulled」 속 null 을 잡지 않게), 한글·기호는 부분 일치로. */
function buildDevWordPattern(words: readonly string[]): RegExp {
  const alts = words.map((w) =>
    /^[A-Za-z]+$/.test(w) ? `\\b${escapeRegExp(w)}\\b` : escapeRegExp(w),
  );
  return new RegExp(alts.join("|"));
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

function isFallbackOperator(e: ts.Node): e is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  );
}

function rawCodeFieldName(e: ts.Expression): string | null {
  const x = unwrap(e);
  return ts.isPropertyAccessExpression(x) && RAW_CODE_FIELDS.has(x.name.text) ? x.name.text : null;
}

/**
 * `라벨표[키] ?? 키` · `라벨표[x.status] || x.status` 인가. 라벨 표에 없는 값이 오면 코드값이
 * 그대로 화면에 간다 — 2026-10-15 실측 49곳의 형태.
 */
function isLabelFallback(e: ts.BinaryExpression, sf: ts.SourceFile): boolean {
  const left = unwrap(e.left);
  if (!ts.isElementAccessExpression(left)) return false;
  if (!/label/i.test(left.expression.getText(sf))) return false;
  const key = unwrap(left.argumentExpression).getText(sf);
  return unwrap(e.right).getText(sf) === key || rawCodeFieldName(e.right) !== null;
}

/**
 * 글자 노드에서 그 글자를 **그대로 그리는** 갈래를 거슬러 오른다 — 괄호·삼항 갈래·`?? || &&` 의
 * 피연산자는 값이 그대로 화면에 간다(`{ok ? "PENDING" : "—"}`). 비교식·함수 인자는 여기서 멈춘다.
 */
function climbRenderedOperands(node: ts.Node): ts.Node {
  let cur = node;
  for (let p = cur.parent; p; cur = p, p = p.parent) {
    const passes =
      ts.isParenthesizedExpression(p) ||
      (ts.isConditionalExpression(p) && p.condition !== cur) ||
      isFallbackOperator(p) ||
      (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken);
    if (!passes) return cur;
  }
  return cur;
}

/** 이 글자 노드가 화면에 보이는 위치에 있는가 — JSX 텍스트·JSX 자식 식·보이는 속성. */
function isVisibleText(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return true;
  const p = climbRenderedOperands(node).parent;
  if (ts.isJsxAttribute(p)) return VISIBLE_ATTRS.has(p.name.getText());
  if (ts.isJsxExpression(p)) {
    return ts.isJsxAttribute(p.parent) ? VISIBLE_ATTRS.has(p.parent.name.getText()) : true;
  }
  return false;
}

function insideConsoleCall(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (!ts.isCallExpression(p)) continue;
    const callee = p.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console") {
      return true;
    }
  }
  return false;
}

/**
 * JSX 자식 식에서 **실제로 그려지는 갈래**들. 삼항은 양쪽, `a ?? b` 는 b 까지 본다.
 * 라벨 표 되돌림(`라벨표[x] ?? x`)은 `fallback` 이 따로 잡으므로 들어가지 않는다(이중 보고 방지).
 */
function renderedBranches(e: ts.Expression, sf: ts.SourceFile, out: ts.Expression[] = []): ts.Expression[] {
  const x = unwrap(e);
  if (ts.isConditionalExpression(x)) {
    renderedBranches(x.whenTrue, sf, out);
    renderedBranches(x.whenFalse, sf, out);
  } else if (isFallbackOperator(x)) {
    if (isLabelFallback(x, sf)) return out;
    renderedBranches(x.left, sf, out);
    renderedBranches(x.right, sf, out);
  } else if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    renderedBranches(x.right, sf, out); // `cond && p.status` — 그려지는 것은 오른쪽이다
  } else if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // `"상태: " + row.status` — 이어 붙인 양쪽이 모두 화면에 간다(GPT 검수 지적 2026-10-15)
    renderedBranches(x.left, sf, out);
    renderedBranches(x.right, sf, out);
  } else if (ts.isTemplateExpression(x)) {
    // `` `상태 ${row.status}` `` — 끼워 넣은 값이 그대로 화면에 간다
    for (const span of x.templateSpans) renderedBranches(span.expression, sf, out);
  } else {
    out.push(x);
  }
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** 한 파일의 소스에서 문구 위반을 뽑는다. 테스트가 스캐너 자체를 검증할 수 있게 export 한다. */
export function findCopyIssues(source: string, fileName = "x.tsx"): CopyIssue[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const isTsx = fileName.endsWith(".tsx");
  const found: CopyIssue[] = [];
  const add = (rule: CopyRule, node: ts.Node, text: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ rule, file: fileName, line: line + 1, text: oneLine(text) });
  };

  const checkText = (node: ts.Node, raw: string) => {
    const text = raw.trim();
    if (!text || insideConsoleCall(node)) return;
    // 상태 낱말은 라벨 표(.ts)에 정의되는 일이 많아 표시 위치와 무관하게 「전체 일치」로 본다.
    if (Object.hasOwn(STATUS_WORD_SPACING, text)) add("spaced", node, text);
    // 돈 이름도 라벨 표·CSV 머리글(.ts)에 정의되는 일이 많아 표시 위치와 무관하게 「전체 일치」로 본다.
    if (Object.hasOwn(MONEY_TERM_ALIASES, text) && !MONEY_EXEMPT_PATHS.some((d) => fileName.startsWith(d))) {
      add("oldMoneyTerm", node, text);
    }
    if (!isTsx || !isVisibleText(node)) return;
    if (UPPERCASE_CODE.test(text) && text.length >= MIN_CODE_LENGTH && !ALLOWED_UPPERCASE_WORDS.has(text)) {
      add("rawCode", node, text);
    }
    if (DEV_WORD_PATTERN.test(text)) add("devWord", node, text);
  };

  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
      checkText(node, node.text);
    } else if (isTsx && ts.isTemplateExpression(node) && isVisibleText(node)) {
      // 변수를 끼운 문구(`${n}건 payload`)는 글자 조각을 이어 개발 용어만 본다 — 전체 일치 규칙
      // (`spaced`·`rawCode`)은 끼운 값 때문에 성립하지 않는다.
      const text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
      if (DEV_WORD_PATTERN.test(text)) add("devWord", node, text);
    } else if (isFallbackOperator(node) && isLabelFallback(node, sf) && !insideConsoleCall(node)) {
      add("fallback", node, node.getText(sf));
    } else if (isTsx && ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const expr = unwrap(node.expression);
      if (renderedBranches(expr, sf).some((b) => rawCodeFieldName(b) !== null)) {
        add("rawField", node, `{${expr.getText(sf)}}`);
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(sf);
  return found;
}

/**
 * 오너 화면이 아니라 **모델에게 주는 지시문**인 파일 — `ui-copy-em-dash.contract.test.ts` 의 제외
 * 기준 중 디렉터리 하나만 옮겼다 — 그쪽의 파일·문구 앵커 제외는 `.ts` 프롬프트용인데 여기의
 * `rawCode`·`devWord` 는 `.tsx` 화면 위치만 보므로 필요 없다(고치면 모델 출력이 바뀐다). 이유 없이 늘리지 말 것.
 */
const PROMPT_DIRS = ["lib/agent/tools/"];

/** 용어집 자체 — 띄어 쓴 형태를 「잡을 낱말」로 담고 있는 사전이라 스캔하면 전부 걸린다. */
const GLOSSARY_FILE = "lib/ui-glossary.ts";

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

const issueKey = (i: Pick<CopyIssue, "rule" | "file" | "text">) => `${i.rule} | ${i.file} | ${i.text}`;

/**
 * 도입 시점(2026-10-15)에 이미 있던 위반. **줄이기만 한다** — 고쳤으면 그 줄을 지운다(남겨 두면
 * 실패한다). 새 위반을 여기 더하지 말 것: 고치는 것이 원칙이고, 고치면 뜻이 바뀌는 예외(저장값·
 * 고유명사)는 사유와 함께 `EXCEPTIONS` 에 둔다.
 */
const BASELINE: readonly string[] = [
];

/**
 * 고치면 동작·뜻이 바뀌어서 고치지 않는 것. **사유 없이 늘리지 말 것.**
 * 키 형식은 `BASELINE` 과 같다.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  "rawCode | app/coupang-partners/page.tsx | PICK":
    "서비스 상표 「WAGPICK」 로고의 뒷글자다(코드값이 아니다).",
  "rawField | components/crm/partners-panel.tsx | {createErrors.type}":
    "폼 오류 객체의 type 칸이라 값이 한국어 오류 문장이다(코드값이 아니다).",
  "spaced | lib/validations/settlement.ts | 정산 진행":
    "정산 체크리스트의 할 일 이름(정산을 진행한다)이지 상태 낱말이 아니다. 만들어진 체크리스트 행에 이 글자가 저장돼 있어 바꾸면 새 캠페인만 달라진다(오너 확정 2026-10-15: 그대로 둔다).",
  "fallback | services/dealService.ts | FIELD_LABELS[key] || key":
    "활동 기록에 **저장되는** 칸 이름이라 「—」로 바꾸면 어느 칸이 바뀌었는지 영구히 잃는다. 대신 빠진 칸 이름을 표에 등록했고 `field-labels-coverage.contract.test.ts` 가 수정 스키마의 모든 칸이 표에 있는지 강제한다.",
  "fallback | services/partnerService.ts | FIELD_LABELS[key] || key":
    "위 dealService 와 같은 사유(저장 시점 칸 이름 · 표 등록 + 커버리지 계약).",
  "fallback | services/sellerPatchService.ts | FIELD_LABELS[key] || key":
    "위 dealService 와 같은 사유(저장 시점 칸 이름 · 표 등록 + 커버리지 계약).",
  "fallback | services/sellerService.ts | FIELD_LABELS[key] || key":
    "위 dealService 와 같은 사유(저장 시점 칸 이름 · 표 등록 + 커버리지 계약).",
  "fallback | lib/content-guide.ts | SNS_LABEL[seller.snsType] ?? seller.snsType":
    "화면이 아니라 콘텐츠 가이드 생성 모델에 주는 지시문 입력이다 — 모르는 채널이면 「—」보다 원문이 모델에게 낫다(쓰는 값 INSTAGRAM·YOUTUBE·X 는 표에 등록함).",
  "fallback | lib/order-converter/claim-derive.ts | CLAIM_STATUS_LABELS[status] ?? status":
    "네이버 클레임 상태(외부 API 코드)다. 표가 실측으로 계속 채워지는 중이라, 처음 보는 코드는 원문이 「무엇을 표에 더할지」의 단서다 — 「—」로 덮으면 사라진다. 같은 값이 봇 조회 입력으로도 간다(코드 검토 2026-10-15).",
  "fallback | lib/order-converter/claim-derive.ts | CLAIM_REASON_LABELS[code] ?? code":
    "네이버 클레임 사유 코드 — 위 클레임 상태와 같은 사유(표의 다수가 추정 코드라 미등록 코드가 실제로 온다).",
  "fallback | lib/content-guide.ts | EVIDENCE_LABEL[claim.evidenceType] ?? claim.evidenceType":
    "이 근거 카드는 콘텐츠 가이드 본문에 붙어 **저장**된다 — 「—」로 바꾸면 무엇이었는지 영구히 잃는다. 지금 오는 값(MEASURED·USER_PROVIDED)은 표에 다 있고 NEEDS_SOURCE 는 앞에서 걸러진다.",
  "oldMoneyTerm | lib/settlement-statement.ts | 판매대행비":
    "셀러에게 보내는 정산서 — 문구 통일은 오너 결정 후. 키가 낱말 단위라 이 파일의 다른 옛 이름은 여전히 잡힌다.",
  "oldMoneyTerm | lib/settlement-statement.ts | 총 거래액":
    "셀러에게 보내는 정산서 — 문구 통일은 오너 결정 후(위 판매대행비와 같은 사유).",
  "oldMoneyTerm | components/mobile/mobile-campaign-detail-sheet.tsx | 매출액":
    "모바일 상세의 품목별 주문 금액 열(주문 합계라 「총거래액」이 아니라 「판매금액」 계열일 수 있다). 모바일 표면은 애플 UI 묶음 1에서 손대지 않는다(P5) — 모바일 묶음에서 낱말을 정하며 이 줄을 지운다.",
  "oldMoneyTerm | lib/tax-invoice-mail/receipt-similarity.ts | 매출":
    "화면 라벨이 아니라 영수증 품목명 유사도 판정용 키워드다(바꾸면 판정이 달라진다).",
  "rawField | components/crm/link-search-dialog.tsx | {meta.status}":
    "값이 이미 라벨이다 — 상류에서 `labelOf`(=`displayLabel`, 표에 없는 코드는 「알 수 없음」)와 `partnerStatusLabel`(폼이 저장한 한글 거래처 상태는 그대로 보여야 하는 의도된 폴백)을 거친다.",
  "rawField | components/crm/linked-entity-section.tsx | {entity.status}":
    "`LinkedEntityItem.status` 는 호출부가 라벨 표를 거쳐 넘기는 한글 낱말이다(코드값이 아니다).",
  "rawField | components/crm/upcoming-schedule-card.tsx | {event.type}":
    "`UpcomingEvent.type` 은 「캠페인 시작」·「입금 예정 (공급사)」 같은 한글 문장이다(lib/desktop-dashboard.ts 가 만든다) — 필드 이름만 type 이다.",
  "devWord | app/privacy/page.tsx | 캠페인 운영을 위해 거래처, 셀러 SNS 핸들, 공개 팔로워 지표, 마케팅 링크 파라미터, 전환 이벤트 및 관리자 운영 로그를 저장합니다.":
    "개인정보 처리방침(법정 고지문)의 수집 항목 명칭이다 — 문구 변경은 고지 개정 사안이다.",
};

describe("화면 문구 기준 (AST 전역 스캔)", () => {
  // ── 양성 대조군: 스캐너가 실제로 잡는가 — 진짜 `findCopyIssues` 를 태운다.
  it("양성 — 띄어 쓴 상태 낱말(JSX·라벨 표 값)을 잡는다", () => {
    const hits = findCopyIssues(`const T = { A: "승인 대기" }; const C = () => <span>정산 대기</span>;`, "a.tsx");
    expect(hits.map((h) => [h.rule, h.text])).toEqual([["spaced", "승인 대기"], ["spaced", "정산 대기"]]);
  });

  it("양성 — 라벨 표에 없으면 코드값으로 되돌리는 코드를 잡는다", () => {
    const src = `const a = LABELS[k] ?? k; const b = <b>{statusLabels[x.status] || x.status}</b>;`;
    expect(findCopyIssues(src, "a.tsx").map((h) => h.rule)).toEqual(["fallback", "fallback"]);
  });

  it("양성 — 코드값 필드를 화면에 바로 그리면 잡는다(삼항 갈래 포함)", () => {
    const src = `const C = ({ p }: any) => <Badge>{ok ? "정상" : p.status}</Badge>;`;
    expect(findCopyIssues(src, "a.tsx").map((h) => h.rule)).toEqual(["rawField"]);
  });

  it("양성 — 화면 글자가 대문자 코드값이거나 개발 용어면 잡는다", () => {
    const src = `const C = () => <><b>PENDING</b><i title="payload 없음">x</i><p>레코드를 저장했습니다</p></>;`;
    expect(findCopyIssues(src, "a.tsx").map((h) => h.rule)).toEqual(["rawCode", "devWord", "devWord"]);
  });

  it("양성 — 옛 돈 이름 라벨을 잡는다", () => {
    const hits = findCopyIssues(`const C = () => <span>총 마진</span>; const T = { a: "영업수익" };`, "a.tsx");
    expect(hits.map((h) => [h.rule, h.text])).toEqual([["oldMoneyTerm", "총 마진"], ["oldMoneyTerm", "영업수익"]]);
  });

  it("음성 — 문장 속 '매출'은 잡지 않는다", () => {
    expect(findCopyIssues(`const C = () => <p>매출 목표를 설정하세요</p>;`, "a.tsx")).toEqual([]);
  });

  it("음성 — 셀러 포털 경로의 '매출'은 잡지 않는다", () => {
    const src = `const C = () => <span>매출</span>;`;
    expect(findCopyIssues(src, "components/portal/x.tsx")).toEqual([]);
    expect(findCopyIssues(src, "app/[slug]/page.tsx")).toEqual([]);
    expect(findCopyIssues(src, "app/p/[token]/page.tsx")).toEqual([]);
    expect(findCopyIssues(src, "components/crm/x.tsx").map((h) => h.rule)).toEqual(["oldMoneyTerm"]);
  });

  // ── 음성 대조군: 잡으면 안 되는 것. 여기가 무너지면 아무도 이 검사를 믿지 않는다.
  it("음성 — 문장 속 띄어쓰기·비교식·비표시 속성·주석·console 은 잡지 않는다", () => {
    const src = [
      `// 승인 대기 상태면 PENDING 이다`,
      `const busy = s === "PENDING";`,
      `console.warn("payload 없음");`,
      `const C = () => <div className="SOME_CLASS" data-x="null">진행 중인 캠페인이 없습니다</div>;`,
    ].join("\n");
    expect(findCopyIssues(src, "a.tsx")).toEqual([]);
  });

  it("음성 — 허용된 약어·한국어 라벨을 거친 값·reason 필드는 잡지 않는다", () => {
    const src = `const C = ({ r }: any) => <><b>NAVER</b><b>{LABELS[r.status] ?? "—"}</b><b>{r.reason}</b></>;`;
    expect(findCopyIssues(src, "a.tsx")).toEqual([]);
  });

  it("음성 — `annulled` 처럼 개발 용어를 품은 다른 낱말은 잡지 않는다", () => {
    expect(findCopyIssues(`const C = () => <p>annulled · enumerate</p>;`, "a.tsx")).toEqual([]);
  });

  it("양성 — 삼항 안의 라벨 표 되돌림은 `fallback` 한 번만 보고한다", () => {
    const src = `const C = ({ x }: any) => <b>{x ? STATUS_LABELS[x.status] ?? x.status : "—"}</b>;`;
    expect(findCopyIssues(src, "a.tsx").map((h) => h.rule)).toEqual(["fallback"]);
  });

  it("양성 — 삼항·`&&` 갈래와 변수를 끼운 문구 안의 코드값·개발 용어도 잡는다", () => {
    const src = [
      "const A = ({ ok, p }: any) => <p title={ok ? \"payload 없음\" : \"x\"}>{ok ? \"PENDING\" : \"—\"}</p>;",
      "const B = ({ p }: any) => <p>{p.ok && p.status}</p>;",
      "const C = ({ n }: any) => <p>{`${n}건 레코드`}</p>;",
    ].join("\n");
    expect(findCopyIssues(src, "a.tsx").map((h) => h.rule)).toEqual(["devWord", "rawCode", "rawField", "devWord"]);
  });

  it("양성 — 문자열에 끼워 넣거나 이어 붙인 코드값 필드도 잡는다", () => {
    const src = "const C = ({ r }: any) => <><p>{`상태 ${r.status}`}</p><p>{\"유형: \" + r.type}</p></>;";
    expect(findCopyIssues(src, "a.tsx").map((h) => h.rule)).toEqual(["rawField", "rawField"]);
  });

  it("음성 — 비교식·함수 인자의 갈래는 화면 글자가 아니다", () => {
    const src = `const C = ({ s }: any) => <p>{s === "PENDING" ? "대기" : f("payload")}</p>;`;
    expect(findCopyIssues(src, "a.tsx")).toEqual([]);
  });

  it("허용 목록의 모든 항목에 사유가 있다", () => {
    const blank = Object.entries(EXCEPTIONS).filter(([, why]) => why.trim().length === 0);
    expect(blank.map(([k]) => k)).toEqual([]);
  });

  // ── 본 계약
  // ⏱️ 600여 파일을 TS 파서에 태운다 — 부하 시 vitest 기본 5초를 넘으므로 여유를 명시한다
  //    (em-dash 계약과 같은 이유).
  it("새로 생긴 화면 문구 위반이 없고, 기준 목록이 낡지 않았다", { timeout: 60_000 }, () => {
    const files = sourceFiles(ROOT);
    expect(files.length).toBeGreaterThan(300); // 0건 스캔이면 늘 초록이다

    const remaining = new Map<string, number>();
    for (const k of BASELINE) remaining.set(k, (remaining.get(k) ?? 0) + 1);

    const fresh: string[] = [];
    for (const full of files) {
      const rel = relative(ROOT, full).replace(/\\/g, "/");
      if (rel === GLOSSARY_FILE || PROMPT_DIRS.some((d) => rel.startsWith(d))) continue;
      for (const issue of findCopyIssues(readFileSync(full, "utf8"), rel)) {
        const key = issueKey(issue);
        if (Object.hasOwn(EXCEPTIONS, key)) continue;
        const left = remaining.get(key) ?? 0;
        if (left > 0) remaining.set(key, left - 1);
        else fresh.push(`${rel}:${issue.line} [${issue.rule}] ${issue.text}`);
      }
    }
    const stale = [...remaining].filter(([, n]) => n > 0).map(([k]) => k);

    // 실패하면: fresh = 새 위반(문구를 고친다 — 기준은 product-ux.md 「화면 문구 기준」),
    //          stale = 이미 고쳐진 기준 목록 줄(BASELINE 에서 지운다).
    expect({ fresh, stale }).toEqual({ fresh: [], stale: [] });
  });
});

describe("MONEY_TERM_ALIASES 타입 가드", () => {
  it("별칭 값에 없는 키는 컴파일 단계에서 거부된다(typecheck 가 판정)", () => {
    // @ts-expect-error — "notAKey" 는 MONEY_TERMS 의 키가 아니다. 이 줄이 에러가 아니게 되면 키 타입이 string 으로 퍼진 것이다.
    const bad: (typeof MONEY_TERM_ALIASES)[string] = "notAKey";
    expect(bad).toBe("notAKey");
    const good: (typeof MONEY_TERM_ALIASES)[string] = "grossMerchandise";
    expect(good).toBe("grossMerchandise");
  });
});
