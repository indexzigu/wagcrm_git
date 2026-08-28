// 대금 칸이 **서는 날짜**의 단일 판정 계약 (2026-08-26).
//
// 완료된 칸은 예정일이 아니라 **실제로 오간 날**에 선다(오너 지적 2026-07-15 —
// "20일이 지급예정인데 15일에 지급되었으면 예정일정은 캘린더에서 없어지고 지급일정으로
// 변경돼야 하는 거 아니야?"). 판정 SSOT 는 `resolveMoneySlotEffectiveDate` 하나다.
//
// **왜 계약으로 고정하나:** 이 규칙은 원래 구글 캘린더 동기화만 갖고 있었고
// (`완료일 ?? 예정일`, #459) 앱 안 표면 넷은 `slot.expectedField` 를 직접 읽었다 —
// 같은 캠페인이 구글에서는 15일, 앱에서는 20일에 뜨는 상태가 두 달 가까이 유지됐다.
// 표면이 하나씩 늘 때마다 예정일을 손으로 읽는 쪽이 자연스러워 보이므로(그게 그 필드의
// 이름이다) 사람 리뷰로는 다시 갈린다. 단위 테스트는 **미래의 새 표면**을 못 막는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * **일정 표면** — "이 대금이 며칠에 일어나는가"를 그리는 곳. 완료 여부와 무관하게 날짜를
 * 하나 골라야 하므로 전부 SSOT 를 통과해야 한다.
 *
 * ⚠️ 여기 없는 파일이 전부 면제인 것은 아니다 — 새 일정 표면을 만들면 이 목록에 넣는다.
 */
const SCHEDULE_SURFACES = [
  // 데스크톱 캘린더 자금 도트
  "src/lib/calendar-entities.ts",
  // 데스크톱 캘린더 팝오버(캠페인·조합)
  "src/components/crm/calendar-view.tsx",
  // 모바일 일정탭 링
  "src/components/mobile/mobile-schedule-calendar.tsx",
  // 모바일 날짜 목록
  "src/components/mobile/mobile-schedule-day-list.tsx",
  // 홈 「다가올 14일 일정」
  "src/lib/desktop-dashboard.ts",
  // 구글 캘린더 대금 이벤트(이 규칙의 최초 소유자 — 사본이 아니라 같은 함수를 쓴다)
  "src/lib/google-calendar-sync.ts",
];

/**
 * 예정일을 직접 읽어도 되는 표면 — **"언제까지 하기로 했나"를 묻는 곳**이라 축이 다르다.
 * 지연 판정·정산 목록 일정 열·정산 리포트·대기 시트는 완료 건을 애초에 제외하거나 약정
 * 날짜를 보여주는 것이 목적이고, 정산 카드는 그 값을 **편집**한다.
 *
 * ⛔ 이 목록으로 일정 표면을 옮겨 계약을 우회하지 말 것. 판정 기준은 "완료된 칸을 화면에
 * 그리는가"다 — 그리면 일정 표면이고, 안 그리면 여기다.
 */
const EXPECTED_DATE_OWNERS = [
  "src/components/crm/settlement-section.tsx",
  "src/components/crm/settlement-table.tsx",
  "src/lib/agenda-settlements.ts",
  "src/lib/settlement-report.ts",
  "src/components/mobile/mobile-settlement-pending-sheet.tsx",
  "src/components/mobile/mobile-campaign-detail-sheet.tsx",
];

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
 * `slot.expectedField` 를 **값으로 읽는** 자리를 찾는다 — `x[slot.expectedField]` 색인도,
 * `eff.date(slot.expectedField)` 처럼 넘기는 것도 같은 우회다(한쪽만 막으면 다른 쪽으로
 * 샌다). 타입 자리(`CampaignMoneySlot["expectedField"]`)는 IndexedAccessType 이라 걸리지
 * 않는다 — 필드 **이름의 타입**을 쓰는 것은 판정을 복제하는 것이 아니다.
 *
 * ⚠️ **완전한 커버리지는 아니다** — `const { expectedField } = slot` 로 구조분해한 뒤 평범한
 * 식별자로 색인하면 AST 상 `PropertyAccessExpression` 이 아니라 걸리지 않는다(교차검증에서
 * 지적된 이론적 우회). 이 계약이 겨냥하는 것은 **표면이 늘 때 자연스럽게 나오는 형태**이고,
 * 우회하려는 코드를 막는 장치는 아니다.
 *
 * 🪤 **정규식으로 세지 말 것** — 이 레포는 손수 만든 스트리퍼가 주석·정규식 리터럴을
 * 잘못 삼켜 고장이 초록으로 보인 전례가 있다. AST 는 주석을 애초에 노드로 만들지 않으므로,
 * 위 금지 규칙을 **설명하는 주석**이 자기 자신을 위반으로 잡는 사고도 구조적으로 없다.
 */
function findExpectedFieldReads(raw: string, file: string): number[] {
  const sourceFile = parse(raw, file);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "expectedField") {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

describe("대금 칸의 날짜 판정 — 일정 표면은 SSOT 를 통과한다", () => {
  it.each(SCHEDULE_SURFACES)("%s 는 예정일을 직접 색인하지 않는다", (file) => {
    expect(findExpectedFieldReads(read(file), file)).toEqual([]);
  });

  it.each(SCHEDULE_SURFACES)("%s 는 resolveMoneySlotEffectiveDate 를 쓴다", (file) => {
    expect(read(file)).toContain("resolveMoneySlotEffectiveDate");
  });

  /**
   * **양성 대조군** — 스캐너가 고장 나면(선택자 오타·AST API 변경) 위 단언이 전부 통과해
   * 계약이 죽은 채 초록을 찍는다. 위반 스니펫에서 반드시 잡혀야 한다.
   */
  it("스캐너가 실제로 위반을 잡는다(양성 프로브 — 색인·인자 두 형태)", () => {
    const violation = `
      const date = campaign[slot.expectedField];
      const other = lookup(slot.expectedField);
    `;
    expect(findExpectedFieldReads(violation, "probe.ts")).toEqual([2, 3]);
  });

  it("완료일 색인과 타입 자리는 위반이 아니다(음성 프로브)", () => {
    const benign = `
      const date = campaign[slot.completedAtField];
      type Field = CampaignMoneySlot["expectedField"];
    `;
    expect(findExpectedFieldReads(benign, "probe.ts")).toEqual([]);
  });

  /**
   * 예정일을 소유한 표면은 **그대로 둔다.** 이 단언이 없으면 "전부 SSOT 로 옮기자"는
   * 다음 정리 패스가 지연 판정·정산 카드까지 끌고 가, 약정일이 화면에서 사라진다.
   */
  it.each(EXPECTED_DATE_OWNERS)("%s 는 예정일을 계속 직접 읽는다", (file) => {
    expect(findExpectedFieldReads(read(file), file).length).toBeGreaterThan(0);
  });
});
