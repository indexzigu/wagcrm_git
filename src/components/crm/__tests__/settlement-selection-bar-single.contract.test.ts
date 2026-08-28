// 정산 선택 액션 바는 **화면에 하나뿐**이라는 소스 계약 (2026-08-24).
//
// 배경: 바는 `position: fixed` + body 포털이라 문서 흐름 밖에 뜬다. 「정산 진행 중」과
// 「정산 완료」 두 표가 각자 자기 바를 렌더하면, 두 섹션을 함께 선택했을 때 같은 자리에
// 겹쳐 아래쪽 바가 통째로 가려진다(위쪽 바만 조작 가능해지고, 가려진 합계는 아무도 못 본다).
// 그래서 선택 상태는 **페이지가 소유**하고 바는 페이지가 한 번만 렌더한다.
//
// ⚠️ 이 계약이 소스 스캔인 이유: 겹침은 jsdom 이 못 본다(레이아웃이 없어 fixed 두 개가
// 그냥 둘 다 "존재"한다). 실렌더로만 눈에 보이는 결함이라, 재발 지점인 **구조**를 고정한다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** 주석을 걷어낸다 — 이 계약의 근거를 설명한 주석이 자기 자신을 위반으로 잡지 않도록. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

const PAGE = stripComments(read("app/settlement/settlement-page-client.tsx"));
const ACTIVE_TABLE = stripComments(read("components/crm/settlement-table.tsx"));
const COMPLETED_TABLE = stripComments(read("components/crm/settlement-completed-table.tsx"));

describe("정산 선택 액션 바 — 단일 렌더 계약", () => {
  it("페이지가 바를 정확히 한 번 렌더한다", () => {
    expect(PAGE.split("<SettlementSelectionBar").length - 1).toBe(1);
  });

  it("두 표는 바를 스스로 렌더하지 않는다", () => {
    for (const [name, source] of [
      ["settlement-table", ACTIVE_TABLE],
      ["settlement-completed-table", COMPLETED_TABLE],
    ] as const) {
      expect(source, `${name} 이 자기 바를 렌더하면 겹친다`).not.toContain(
        "SettlementSelectionBar",
      );
      // 포털·fixed 를 직접 쓰는 것도 같은 재발 경로다.
      expect(source, `${name} 이 포털로 부유 레이어를 만들면 안 된다`).not.toContain(
        "createPortal",
      );
    }
  });

  it("두 표 모두 선택 상태를 prop 으로 받는다 — 자체 상태로 되돌아가면 바를 공유할 수 없다", () => {
    for (const [name, source] of [
      ["settlement-table", ACTIVE_TABLE],
      ["settlement-completed-table", COMPLETED_TABLE],
    ] as const) {
      expect(source, `${name} 이 selectedIds prop 을 받아야 한다`).toContain("selectedIds:");
      expect(source, `${name} 이 선택 상태를 자체 보유하면 안 된다`).not.toMatch(
        /useState<string\[\]>\(\[\]\)/,
      );
    }
  });

  it("전체선택 판정은 두 표 모두 '이 표의 행이 전부 들어 있는가'로 한다", () => {
    // selectedIds 는 페이지 전역이라 모집단이 표마다 다르다 — 개수 비교는 남의 선택에
    // 반응해 헤더를 거짓 체크한다(2026-08-24 실렌더 결함).
    for (const [name, source] of [
      ["settlement-table", ACTIVE_TABLE],
      ["settlement-completed-table", COMPLETED_TABLE],
    ] as const) {
      expect(source, `${name} 의 전체선택이 개수 비교로 되돌아갔다`).not.toMatch(
        /selectedIds\.length\s*===/,
      );
      expect(source, `${name} 이 every 로 판정해야 한다`).toMatch(
        /campaigns\.every\(\s*\(campaign\)\s*=>\s*selectedIds\.includes\(campaign\.id\)\s*\)/,
      );
    }
  });

  it("완료 표 합산은 그 표가 렌더하는 리포트 파생값으로 매핑한다(metric-integrity)", () => {
    // 캠페인 컬럼을 그대로 합산하면 폴백으로 화면에 숫자가 뜬 건이 합계에서 0 이 된다.
    expect(PAGE).toContain("toCompletedSelectionInput");
  });
});
