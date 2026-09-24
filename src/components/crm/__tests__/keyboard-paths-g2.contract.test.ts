import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * interfaces 점검 묶음 G2(2026-09-24) — 키보드 경로 계약(소스 스캔).
 *
 * 행위 테스트(`keyboard-paths-g2.test.tsx`·`upload-file-picker-g2.test.tsx`)로 렌더하기 무거운
 * 표면(2천 줄대 주문 관리·정산 섹션 등)은 여기서 **형태**를 고정한다. 되돌아가는 방향이 전부
 * 조용하다 — `hidden` 한 단어·`focus-visible` 한 토막이 빠져도 tsc·eslint·기존 테스트는 초록이고,
 * 포인터 사용자는 차이를 못 느낀다.
 */

const CRM = join(process.cwd(), "src/components/crm");

/**
 * JSX 주석(`{/* … *\/}`)과 줄 전체 `//` 주석만 공백으로 바꾼다(줄번호 보존) — 설명문에 인용한
 * 클래스명이 위반으로 잡히지 않게. 🪤 일반 `/* *\/`·줄 중간 `//` 까지 걷으면 안 된다:
 * `accept="image/*,.pdf"` 가 블록 주석 시작으로, URL 의 `https://` 가 줄 주석으로 읽혀 코드가
 * 통째로 지워진다(이 파일 작성 중 실제로 그렇게 오판했다).
 */
function code(relPath: string): string {
  const source = readFileSync(join(CRM, relPath), "utf8");
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return source.replace(/\{\/\*[\s\S]*?\*\/\}/g, blank).replace(/^\s*\/\/[^\n]*/gm, blank);
}

describe("파일 입력 — display:none 으로 숨기지 않거나, 보이는 「파일 선택」 버튼이 있다", () => {
  /**
   * 두 형태만 허용한다.
   * ① 라벨로 감싼 입력(송장등록·증빙 첨부) → `sr-only` — 포커스는 받고 라벨이 이름·위치를 준다.
   * ② 드롭존(가격표·카톡·빠른 정산) → 입력은 `hidden` 이어도 되지만 같은 파일에 입력의 ref 를
   *    `.click()` 하는 **「파일 선택」 버튼**이 있어야 한다.
   */
  const LABEL_WRAPPED = ["order-dashboard.tsx", "settlement-section.tsx"];
  const DROP_ZONES = [
    "price-sheet/price-sheet-list.tsx",
    "katalk/upload-tab.tsx",
    "quick-settlement-modal.tsx",
  ];

  function fileInputTags(source: string): string[] {
    const tags: string[] = [];
    const re = /<input\b[^>]*type="file"[^>]*>/g;
    for (const [tag] of source.matchAll(re)) tags.push(tag);
    return tags;
  }

  it.each(LABEL_WRAPPED)("%s: 라벨로 감싼 파일 입력은 sr-only 다(hidden 금지)", (file) => {
    const tags = fileInputTags(code(file));
    expect(tags.length, `${file} 에서 파일 입력을 못 찾았다 — 스캔 대상 재확인`).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, `${file}: display:none 파일 입력은 탭 순서에서 빠진다`).not.toMatch(/\bhidden\b/);
      expect(tag).toMatch(/\bsr-only\b/);
    }
  });

  it.each(LABEL_WRAPPED)("%s: 파일 입력을 감싼 라벨에 focus-within 링이 있다", (file) => {
    // sr-only 입력은 보이지 않으므로 포커스 위치는 라벨이 보여 줘야 한다.
    expect(code(file)).toMatch(/focus-within:ring-2 focus-within:ring-focus-ring/);
  });

  it.each(DROP_ZONES)("%s: 드롭존에 「파일 선택」 버튼이 있고 파일 입력을 연다", (file) => {
    const source = code(file);
    expect(fileInputTags(source).length).toBeGreaterThan(0);
    expect(source).toMatch(/fileInputRef\.current\?\.click\(\);\s*\}\}\s*>\s*<Paperclip(Icon)? aria-hidden \/>\s*파일 선택/);
  });
});

describe("클릭되던 div/tr — 키보드로 닿는 실제 button 이 있다", () => {
  it("주문 관리 카드 머리: 제목 button 이 aria-expanded 로 펼침을 알린다", () => {
    const source = code("order-dashboard.tsx");
    expect(source).toMatch(
      /<button\s+type="button"\s+aria-expanded=\{expandedCampaignId === camp\.id\}[\s\S]{0,400}?\{camp\.name\}\s*<\/button>/,
    );
  });

  it("유입 리포트 링크 표: 첫 칸 button 이 상세를 연다", () => {
    expect(code("inflow-report-client.tsx")).toMatch(
      /<button[\s\S]{0,300}?setSelected\(link\);[\s\S]{0,900}?<\/button>/,
    );
  });

  it("자료 보관함: 폴더 행은 aria-expanded button, 파일명은 button 이다", () => {
    const source = code("asset-library.tsx");
    expect(source).toMatch(/<button\s+type="button"\s+aria-expanded=\{node\.isOpen\}/);
    expect(source).toMatch(/<button[\s\S]{0,600}?onClick=\{\(\) => openAsset\(asset\)\}[\s\S]{0,200}?\{asset\.fileName\}\s*<\/button>/);
    expect(source, "폴더 토글이 다시 div onClick 이 되면 키보드로 못 연다").not.toMatch(
      /<div[^>]*onClick=\{\(\) => toggleFolder/,
    );
  });

  it("시장가 모니터: 품목명 button 이 aria-expanded 로 펼침을 알린다", () => {
    expect(code("market-price-monitor.tsx")).toMatch(
      /<button\s+type="button"\s+aria-expanded=\{Boolean\(isExpanded\)\}[\s\S]{0,300}?toggleExpand\(item\.id\)/,
    );
  });

  it("매출 공백 브리핑: 주간 바 툴팁 트리거가 포커스를 받는다", () => {
    expect(code("schedule-gap-briefing-card.tsx")).toMatch(
      /<TooltipTrigger asChild>\s*<div\s+tabIndex=\{0\}/,
    );
  });
});

describe("hover 로만 보이는 버튼 — 키보드 포커스에서도 보인다", () => {
  /**
   * `opacity-0 group-hover:opacity-100` 만 있으면 Tab 으로 도달해도 안 보인다.
   * 장식 아이콘(버튼 **안**의 연필 등 — 버튼 자체는 보인다)은 대상이 아니다.
   */
  const FILES = [
    "campaign-card.tsx",
    "settlement-section.tsx",
    "campaign-side-panel.tsx",
    "asset-library.tsx",
    "category-tag-input.tsx",
  ];

  it.each(FILES)("%s", (file) => {
    const offenders: string[] = [];
    code(file)
      .split("\n")
      .forEach((line, index) => {
        if (!/\bopacity-0\b/.test(line) || !/group-hover[^\s:]*:opacity-100/.test(line)) return;
        if (/^\s*<(Pencil|ChevronDown|ChevronRight|ArrowUpDownIcon)\b/.test(line)) return;
        if (/focus-visible:opacity-100|group-focus-(within|visible)[^\s:]*:opacity-100/.test(line)) return;
        offenders.push(`${file}:${index + 1}`);
      });
    expect(offenders).toEqual([]);
  });
});

describe("InlineDataGrid 첫 칸 render — 행 열기 button 안에 들어가므로 block 요소 금지", () => {
  /**
   * onRowClick 을 주는 소비처의 **첫 컬럼** render 는 button 안에 그려진다. div·p 를 돌려주면
   * button 안 block 요소(무효 HTML)가 된다 — 행위 테스트는 DealsGrid 만 렌더하므로(셀러 관리는
   * 라우터·검색 파라미터 의존이 커서) 셀러 쪽은 여기서 소스로 막는다.
   */
  it.each([
    ["sellers-management.tsx", /key: "name",[\s\S]*?\n  \},\n  \{\n    key: "channelUrl"/],
    ["deals-grid.tsx", /key: "dealName",[\s\S]*?\n          \},\n          \{/],
  ])("%s", (file, sectionRe) => {
    const section = code(file).match(sectionRe)?.[0];
    expect(section, `${file}: 첫 컬럼 정의 구간을 못 찾았다 — 정규식 재확인`).toBeTruthy();
    // TooltipContent 는 포털로 button 밖에 그려지므로 그 안의 <p> 는 대상이 아니다.
    const inButton = section!.replace(/<TooltipContent[\s\S]*?<\/TooltipContent>/g, "");
    expect(inButton).not.toMatch(/<(div|p|h[1-6]|ul|ol|table)\b/);
  });
});
