import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 모달 표면 안의 팝오버 목록은 포털하지 않는다 (실사고 2026-08-13, PR #384).
 *
 * **무엇이 깨지나:** Radix `Dialog`(= `Sheet` 의 기반)는 내용을 `RemoveScroll` 로
 * 감싸며 스크롤 허용 예외(`shards`)를 **그 컨텐츠 엘리먼트 하나로만** 준다.
 * `react-remove-scroll` 은 `document` 의 `wheel` 을 `{passive:false}` 로 잡아
 * 타깃이 shard 밖이면 `preventDefault()` 한다. 그래서 `document.body` 로 포털된
 * 팝오버는 **클릭·호버는 되는데 내부 목록만 스크롤되지 않는다** — 항목이
 * `max-h-[300px]` 를 넘는 순간 아래쪽을 영영 고를 수 없다.
 *
 * 접근성으로도 비포털이 옳다: 포털본은 `aria-modal="true"` 인 다이얼로그 **바깥**
 * 이라 스크린리더가 목록을 통째로 숨겼을 가능성이 높다.
 *
 * ---
 * ⚠️ **왜 `PopoverContent` 의 기본값을 전역으로 뒤집지 않았나 (판단 기록 — 다시
 * 분석하지 말 것):** 「Dialog/Sheet 안이면 포털 끔」을 컨텍스트로 자동화하는 안을
 * 검토했고, 설계로는 그쪽이 더 옳다. 하지만 이 레포의 Dialog·Sheet 호스트는
 * **33파일 38곳**이고 전부 팝오버 렌더 방식이 바뀐다. 비포털은 컨테이닝 블록이
 * 모달 컨텐츠로 바뀌므로(둘 다 `transform` 을 갖는다) 위치·클리핑을 **38곳 전부
 * 실렌더로 확인해야** 안전을 주장할 수 있는데, 그 검증 없이 내보내는 것은 이
 * 레포 P0(No Hallucinated Verification)에 어긋난다. 그래서 **범위를 실제로 깨져
 * 있던 경로로 좁혔다.** 전역 전환을 하려면 그 실렌더 예산을 먼저 확보할 것.
 *
 * ---
 * **이 계약의 한계(정직 고지):** 같은 **파일 안**에 모달과 드롭다운이 함께 있는
 * 경우만 잡는다. 컴포넌트가 다른 파일의 Sheet 안에서 렌더되는 교차 파일 사례는
 * 정적으로 판정할 수 없다. 실제로 이번 결함(셀러 시트 「소개자」)이 그 형태라
 * 파일 스캔으로는 잡히지 않았고, **공유 컴포넌트 자체를 고쳐서** 막았다
 * (아래 두 번째 describe). 새 목록 위젯을 만들 때는 그 방식을 따를 것.
 */

const SRC = join(process.cwd(), "src");

const MODAL_SURFACE = /<(DialogContent|SheetContent|AlertDialogContent)\b/;
const DROPDOWN = /<SearchableDropdown\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [full] : [];
  });
}

/** 주석 안의 인용문이 스스로를 위반으로 잡지 않게 걷어낸다. */
function stripComments(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("모달 안의 SearchableDropdown 은 포털하지 않는다", () => {
  it("같은 파일에 모달과 드롭다운이 함께 있으면 portal={false} 가 있다", () => {
    const offenders = walk(SRC)
      .map((file) => ({ file, source: stripComments(readFileSync(file, "utf8")) }))
      .filter(({ source }) => MODAL_SURFACE.test(source) && DROPDOWN.test(source))
      .filter(({ source }) => !/portal=\{false\}/.test(source))
      .map(({ file }) => file.replace(`${SRC}/`, ""));

    expect(
      offenders,
      "모달 안에서 포털된 드롭다운은 목록이 스크롤되지 않는다(클릭만 되고 휠이 죽는다)",
    ).toEqual([]);
  });
});

describe("상세 패널의 검색형 선택 필드는 공유 컴포넌트에서 막는다", () => {
  it("InlineEditField 의 searchable-select 팝오버가 포털하지 않는다", () => {
    const source = stripComments(
      readFileSync(join(SRC, "components/crm/inline-edit-field.tsx"), "utf8"),
    );
    const match = source.match(/<PopoverContent[^>]*>/);
    expect(match, "PopoverContent 를 찾지 못했다").not.toBeNull();
    expect(
      match![0],
      "이 필드의 유일한 인스턴스(셀러 상세 「소개자」)는 Sheet 안이라 포털하면 목록이 죽는다",
    ).toContain("portal={false}");
  });
});
