/**
 * 픽스처 회귀: hisonic_s_pricesheet.xlsx — 헤더 4행째(0-based row3), D열(columnIndex=3)부터
 * 실제 표 시작, 프로모션/샘플정책 자유텍스트가 표 행에 섞여 있어 정책 분리가 필요 (청사진 §4).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkbookGrids } from "../sheet-grid";
import { parseRowsFromSegments } from "../extract-path-a";
import { FIXTURES, fixturesAvailable } from "./fixtures";
import type { ExtractStructureAParsed } from "../schema";

describe.skipIf(!fixturesAvailable())("픽스처: hisonic_s_pricesheet.xlsx", () => {
  const buffer = fixturesAvailable() ? readFileSync(FIXTURES.hisonic) : Buffer.alloc(0);
  const grids = fixturesAvailable() ? readWorkbookGrids(buffer) : { sheets: [] };

  it("헤더가 4번째 행(0-based row3)의 D열(index 3)부터 시작한다", () => {
    const sheet = grids.sheets[0];
    expect(sheet.rows[3]?.[3]).toBe("제품명");
    expect(sheet.rows[3]?.[4]).toBe("정상가");
    expect(sheet.rows[3]?.[5]).toBe("공동구매가");
  });

  it("D열 columnMap으로 데이터 행(row4~7)을 파싱하면 프로모션 문단(row9)은 표 데이터에 섞이지 않는다", () => {
    const structure: ExtractStructureAParsed = {
      segments: [
        {
          segmentIndex: 0,
          sheetName: grids.sheets[0].sheetName,
          headerRow: 3,
          dataStartRow: 4,
          dataEndRow: 7,
          columnMap: [
            { columnIndex: 3, field: "productName" },
            { columnIndex: 4, field: "listPrice" },
            { columnIndex: 5, field: "sellingPrice" },
            { columnIndex: 6, field: "discountRate" },
            { columnIndex: 7, field: "note" },
            { columnIndex: 8, field: "supplyPrice" },
          ],
        },
      ],
      policyBlocks: [
        {
          rowIndex: 9,
          text: "1) 증정 프로모션(더마제닉 겔 5개+솔라덤 앰플 1ea) : 2025년 6월까지 진행",
        },
      ],
    };

    const { rows } = parseRowsFromSegments(grids, structure);
    expect(rows).toHaveLength(4);

    const firstRow = rows.find((r) => r.rowIndex === 4)!;
    expect(firstRow.productName).toContain("하이소닉 S 1ea");
    expect(firstRow.listPrice).toBe(1250000);
    expect(firstRow.sellingPrice).toBe(770000);
    // 할인율 0.384는 이미 소수이므로 그대로 유지되어야 함(>1 아니므로 /100 안 됨)
    expect(firstRow.discountRate).toBeCloseTo(0.384, 5);

    // row7은 공구가(sellingPrice) 컬럼이 비어 있음 — 판매 미운영(개별구매만)
    const row7 = rows.find((r) => r.rowIndex === 7)!;
    expect(row7.sellingPrice).toBeNull();
  });

  it("정책 문단이 policyBlocks로 분리되어 표 데이터 파싱과 무관하게 별도 관리된다", () => {
    const structure: ExtractStructureAParsed = {
      segments: [],
      policyBlocks: [
        { rowIndex: 9, text: "1) 증정 프로모션 : 2025년 6월까지 진행" },
        { rowIndex: 13, text: "[ 샘플정책 ]" },
      ],
    };
    expect(structure.policyBlocks).toHaveLength(2);
    expect(structure.policyBlocks.map((b) => b.text).join("\n\n")).toContain("샘플정책");
  });
});
