/**
 * 픽스처 회귀: nutrione_simulator.xlsx — 헤더 7행째(0-based row6), 시트2("DB") 별도 세그먼트,
 * 음수마진 행(row15) flags.negativeMargin 검출 (청사진 §4).
 * LLM 호출 없이 columnMap을 고정 주입해 결정적 파싱(parseRowsFromSegments)만 검증한다.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkbookGrids } from "../sheet-grid";
import { parseRowsFromSegments } from "../extract-path-a";
import { FIXTURES, fixturesAvailable } from "./fixtures";
import type { ExtractStructureAParsed } from "../schema";

describe.skipIf(!fixturesAvailable())("픽스처: nutrione_simulator.xlsx", () => {
  const buffer = fixturesAvailable() ? readFileSync(FIXTURES.nutrione) : Buffer.alloc(0);
  const grids = fixturesAvailable() ? readWorkbookGrids(buffer) : { sheets: [] };

  it("워크북에 시뮬레이션/DB 두 시트가 있다", () => {
    expect(grids.sheets.map((s) => s.sheetName)).toEqual(["시뮬레이션", "DB"]);
  });

  it("헤더가 7번째 행(0-based row6)에 있고 데이터는 row7~15", () => {
    const sheet = grids.sheets.find((s) => s.sheetName === "시뮬레이션")!;
    expect(sheet.rows[6]?.[0]).toBe("품번");
    expect(sheet.rows[6]?.[1]).toBe("제품명");
    expect(sheet.rows[7]?.[0]).toBe("NT003822");
  });

  it("시뮬레이션 시트 세그먼트를 파싱하면 음수마진 행(row15)에 negativeMargin 플래그가 붙는다", () => {
    const structure: ExtractStructureAParsed = {
      segments: [
        {
          segmentIndex: 0,
          sheetName: "시뮬레이션",
          headerRow: 6,
          dataStartRow: 7,
          dataEndRow: 15,
          columnMap: [
            { columnIndex: 1, field: "productName" },
            { columnIndex: 3, field: "supplyPrice" },
            { columnIndex: 4, field: "sellingPrice" },
            { columnIndex: 10, field: "note" },
          ],
        },
      ],
      policyBlocks: [],
    };

    const { rows, detectedTables } = parseRowsFromSegments(grids, structure);
    expect(detectedTables).toBe(1);
    // row7~15 = 9행
    expect(rows).toHaveLength(9);

    const negativeMarginRow = rows.find((r) => r.rowIndex === 15);
    expect(negativeMarginRow).toBeDefined();
    expect(negativeMarginRow!.sellingPrice).toBe(0);
    expect(negativeMarginRow!.supplyPrice).toBe(3223);
    expect(negativeMarginRow!.flags.negativeMargin).toBe(true);

    const firstRow = rows.find((r) => r.rowIndex === 7);
    expect(firstRow!.productName).toBe("관절연골엔 뮤코다당단백 콘드로이친(공용,60정), 1");
    expect(firstRow!.supplyPrice).toBe(7898);
    expect(firstRow!.sellingPrice).toBe(30900);
    expect(firstRow!.flags.negativeMargin).toBeUndefined();
  });

  it("DB 시트를 독립 세그먼트로 파싱하면 품명/원가 컬럼이 별도 columnMap으로 매핑된다", () => {
    const structure: ExtractStructureAParsed = {
      segments: [
        {
          segmentIndex: 1,
          sheetName: "DB",
          headerRow: 0,
          dataStartRow: 1,
          dataEndRow: 5,
          columnMap: [
            { columnIndex: 1, field: "productName" },
            { columnIndex: 3, field: "supplyPrice" },
          ],
        },
      ],
      policyBlocks: [],
    };

    const { rows, detectedTables } = parseRowsFromSegments(grids, structure);
    expect(detectedTables).toBe(1);
    expect(rows).toHaveLength(5);
    expect(rows[0].tableSegment).toBe(1);
    expect(rows[0].productName).toBe("지노프리 질유산균(공용,30캡슐), 1");
    expect(rows[0].supplyPrice).toBe(13024);
  });

  it("두 세그먼트를 동시에 넘기면 detectedTables=2, rawCells에 시트명이 보존된다", () => {
    const structure: ExtractStructureAParsed = {
      segments: [
        {
          segmentIndex: 0,
          sheetName: "시뮬레이션",
          headerRow: 6,
          dataStartRow: 7,
          dataEndRow: 8,
          columnMap: [
            { columnIndex: 1, field: "productName" },
            { columnIndex: 4, field: "sellingPrice" },
          ],
        },
        {
          segmentIndex: 1,
          sheetName: "DB",
          headerRow: 0,
          dataStartRow: 1,
          dataEndRow: 2,
          columnMap: [{ columnIndex: 1, field: "productName" }],
        },
      ],
      policyBlocks: [{ text: "테스트 정책 문장" }],
    };

    const { rows, detectedTables } = parseRowsFromSegments(grids, structure);
    expect(detectedTables).toBe(2);
    expect(rows.every((r) => r.rawCells.__sheetName === (r.tableSegment === 0 ? "시뮬레이션" : "DB"))).toBe(
      true
    );
  });
});
