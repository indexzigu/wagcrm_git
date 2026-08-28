/**
 * 명세서 **표면 동등성** 계약 (T-023).
 *
 * 오너가 "목록과 상세가 다른 모듈로 구현된 건 아닌가"를 물은 이력이 두 번이다:
 *   - 1차: 상세 패널이 명세서를 SVG 로 손수 다시 그려 자사 마진이 셀러에게 갔다(P0).
 *   - 2차(T-023): 렌더 함수는 공유하는데 **파일명만** 각자 지어서, 상세에서 저장하면
 *     `settlement-{id}.png` 라는 내부 식별자가 셀러에게 전달됐다.
 *
 * 두 번 다 "정본 함수는 있는데 호출부가 한 조각을 자기 손으로 다시 만들었다"가 원인이다.
 * 이 계약은 그 조각들(HTML·파일명·캡처 경로)이 다시 갈라지는 것을 **소스 스캔**으로 막는다.
 *
 * ⚠️ 소스 스캔은 양성 프로브가 없으면 하네스 고장을 초록으로 착각한다 — 각 스캔은
 * 대상 파일이 실제로 읽혔는지(비어 있지 않은지)부터 단언한다.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

/**
 * 주석을 걷어낸 소스 — 이 계약의 주석 자체가 금지 패턴(`settlement-{id}.png`)을 인용하므로
 * 원문 그대로 스캔하면 **경고문이 위반으로 잡힌다.** 판정 대상은 실행되는 코드다.
 */
const readCode = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// 2026-08-24: 명세서 액션(복사·인쇄·저장)은 정산 표에서 **선택 액션 바**로 옮겼다 —
// 진행 중·완료 두 표가 바 하나를 공유해야 해서(둘 다 fixed 라 각자 띄우면 겹친다)
// 선택 상태와 함께 페이지 아래로 내려갔다. 표면 좌표만 바뀌었고 계약은 그대로다.
const SELECTION_BAR = "src/components/crm/settlement-selection-bar.tsx";
const SIDE_PANEL = "src/components/crm/campaign-side-panel.tsx";
const SETTLEMENT_PAGE = "src/app/settlement/settlement-page-client.tsx";

/** 명세서 이미지를 저장하는 두 표면 — 새 표면이 생기면 여기에 추가한다. */
const IMAGE_SURFACES = [SELECTION_BAR, SIDE_PANEL];

describe("명세서 이미지 표면 동등성", () => {
  it("every surface renders the PNG through the shared builder", () => {
    for (const surface of IMAGE_SURFACES) {
      const source = read(surface);
      expect(source.length, `${surface} 를 읽지 못했다`).toBeGreaterThan(0);
      expect(source, `${surface} 가 정본 렌더러를 쓰지 않는다`).toContain(
        "renderSettlementStatementPng",
      );
    }
  });

  it("no surface hand-rolls the download file name", () => {
    for (const surface of IMAGE_SURFACES) {
      const source = read(surface);
      expect(source, `${surface} 가 파일명 SSOT 를 쓰지 않는다`).toContain(
        "buildSettlementStatementFileName",
      );
      // 정본을 부르면서 그 옆에 자기 파일명 문자열을 또 만드는 경우까지 잡는다(주석 제외).
      const code = readCode(surface);
      expect(code.length, `${surface} 를 읽지 못했다`).toBeGreaterThan(0);
      const handRolled = code.match(/`[^`]*\.png`/g) ?? [];
      expect(handRolled, `${surface} 에 손으로 지은 png 파일명이 남아 있다`).toEqual([]);
    }
  });

  it("keeps html2canvas capture inside the statement SSOT only", () => {
    // 화면 DOM 캡처로 되돌아가면 내부 문서(영업이익·수수료율)가 그대로 셀러에게 간다(P0).
    for (const surface of [...IMAGE_SURFACES, SETTLEMENT_PAGE]) {
      const source = readCode(surface);
      expect(source.length, `${surface} 를 읽지 못했다`).toBeGreaterThan(0);
      const importsHtml2canvas = /import\s*\(\s*["']html2canvas["']\s*\)|from\s+["']html2canvas["']/.test(
        source,
      );
      expect(importsHtml2canvas, `${surface} 가 html2canvas 를 직접 부른다`).toBe(false);
    }

    const ssot = read("src/lib/settlement-statement.ts");
    expect(ssot).toContain('import("html2canvas")');
  });

  it("leaves no second statement HTML builder outside the SSOT", () => {
    // `<Sheet open={false}>` 안에 숨어 있던 죽은 3번째 구현(`generateStatementHtml`)이
    // 정확히 이 질문의 정체였다 — 되살아나면 여기서 걸린다.
    const page = read(SETTLEMENT_PAGE);
    expect(page.length).toBeGreaterThan(0);
    expect(page).not.toContain("generateStatementHtml");
    expect(page).not.toContain("[정산 명세서]");
  });
});

describe("명세서 정렬", () => {
  it("keeps ordering inside the SSOT — surfaces must not sort before calling", () => {
    const ssot = read("src/lib/settlement-statement.ts");
    expect(ssot).toContain("sortStatementCampaigns");

    for (const surface of IMAGE_SURFACES) {
      const source = read(surface);
      expect(source, `${surface} 가 호출 전에 자체 정렬을 한다`).not.toContain(
        "sortStatementCampaigns",
      );
    }
  });
});
