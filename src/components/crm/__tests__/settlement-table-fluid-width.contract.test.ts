import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SETTLEMENT_TABLE_CHECKBOX_WIDTH,
  SETTLEMENT_TABLE_MIN_WIDTH,
  settlementCheckboxCol,
  settlementFluidCol,
  settlementTableStyle,
} from "../settlement-table-layout";

/**
 * 정산 두 표의 **가로 폭 규약**을 고정한다. 행위 테스트로는 못 잡는 부류다 —
 * jsdom 은 레이아웃을 계산하지 않아 열이 어떻게 배분되는지 화면으로 확인할 수 없고,
 * 그래서 한쪽 표만 규약을 벗어나도 테스트는 계속 초록이다. 실제로 2026-08-25 에
 * 그 갈림(체크박스 폭 48 vs 54)이 오너 신고로 발견됐다.
 */
describe("정산 표 유동폭 규약", () => {
  const read = (file: string) =>
    readFileSync(path.join(process.cwd(), "src/components/crm", file), "utf8");

  const tableTagOf = (source: string) => {
    // `<table ... >` 여는 태그만 떼어 낸다 — 주석은 이 안에 없으므로 주석 제거가 불필요하다
    // (설명 주석이 자기 자신을 위반으로 잡는 사고를 피한다).
    const match = source.match(/<table\b[\s\S]*?>/);
    expect(match).not.toBeNull();
    return match![0];
  };

  it("체크박스 열은 어떤 폭에서도 고정 48px — 두 표의 캠페인명 시작 좌표를 맞추는 축이다", () => {
    expect(settlementCheckboxCol.width).toBe("48px");
    expect(SETTLEMENT_TABLE_CHECKBOX_WIDTH).toBe(48);
  });

  it("유동폭은 최소폭에 대한 백분율이다 — 최소폭에서 원래 픽셀과 정확히 일치한다", () => {
    // 분모가 최소폭 전체(994)여야 한다. ⛔ `calc(100% - 48px)` 로 체크박스를 빼는 식은
    // table-layout:fixed 의 열 폭으로 적용되지 않는다(모듈 주석의 🪤).
    expect(settlementFluidCol(86).width).toBe(
      `${((86 / SETTLEMENT_TABLE_MIN_WIDTH) * 100).toFixed(4)}%`,
    );
    const px = (basePx: number) =>
      (parseFloat(settlementFluidCol(basePx).width) / 100) * SETTLEMENT_TABLE_MIN_WIDTH;
    expect(px(86)).toBeCloseTo(86, 2);
    expect(px(128)).toBeCloseTo(128, 2);
    expect(settlementTableStyle.minWidth).toBe(`${SETTLEMENT_TABLE_MIN_WIDTH}px`);
  });

  it.each(["settlement-table.tsx", "settlement-completed-table.tsx"])(
    "%s 의 표는 상한 없이 카드를 꽉 채운다",
    (file) => {
      const tag = tableTagOf(read(file));
      expect(tag).toContain("w-full");
      expect(tag).toContain("table-fixed");
      expect(tag).toContain("settlementTableStyle");
      // ⛔ `max-w` 상한이 되살아나면 넓은 화면에서 카드 우측에 빈 띠가 돌아온다
      // (오너 지적 2026-08-28). 근거는 `settlement-table-layout.ts` 주석.
      expect(tag).not.toMatch(/max-w-/);
    },
  );

  it.each(["settlement-table.tsx", "settlement-completed-table.tsx"])(
    "%s 의 `<col>` 은 공유 헬퍼만 쓴다 — 픽셀 리터럴이 되살아나면 창 폭을 못 따라간다",
    (file) => {
      const source = read(file);
      const cols = source.match(/<col\b[^>]*\/>/g) ?? [];
      expect(cols.length).toBeGreaterThan(5);
      expect(cols.filter((col) => col.includes("settlementCheckboxCol"))).toHaveLength(1);
      // 캠페인명은 폭 미지정 흡수 열이므로 헬퍼가 없는 `<col />` 이 정확히 하나 있다.
      expect(cols.filter((col) => col.trim() === "<col />")).toHaveLength(1);
      for (const col of cols) {
        expect(col).not.toMatch(/width:\s*"\d/);
      }
    },
  );
});
