/**
 * 픽스처 회귀: coringco.xlsx — 한 시트 안에 다중 표(row0 헤더/row8 헤더/row16 헤더)가 있고
 * 표마다 열 구성이 다르다("정산가(수수료)" vs "마진") — 세그먼트별 독립 columnMap 필수(청사진 R-C, §4).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkbookGrids } from "../sheet-grid";
import { parseRowsFromSegments } from "../extract-path-a";
import { FIXTURES, fixturesAvailable } from "./fixtures";
import type { ExtractStructureAParsed } from "../schema";

describe.skipIf(!fixturesAvailable())("픽스처: coringco.xlsx (다중표 세그먼트)", () => {
  const buffer = fixturesAvailable() ? readFileSync(FIXTURES.coringco) : Buffer.alloc(0);
  const grids = fixturesAvailable() ? readWorkbookGrids(buffer) : { sheets: [] };
  const sheetName = fixturesAvailable() ? grids.sheets[0].sheetName : "";

  it("row0과 row8이 각각 독립된 표 헤더(구성/정상가/...)를 갖는다", () => {
    const sheet = grids.sheets[0];
    expect(sheet.rows[0]?.[1]).toBe("구성");
    expect(sheet.rows[0]?.[6]).toBe("정산가(수수료)");
    expect(sheet.rows[8]?.[1]).toBe("구성");
    expect(sheet.rows[8]?.[6]).toBe("정산가(수수료)");
  });

  it("세그먼트0(row1)과 세그먼트1(row9)을 각자 columnMap으로 파싱하면 서로 다른 tableSegment로 분리된다", () => {
    const structure: ExtractStructureAParsed = {
      segments: [
        {
          segmentIndex: 0,
          sheetName,
          headerRow: 0,
          dataStartRow: 1,
          dataEndRow: 1,
          columnMap: [
            { columnIndex: 1, field: "productName" },
            { columnIndex: 2, field: "listPrice" },
            { columnIndex: 4, field: "sellingPrice" },
            { columnIndex: 6, field: "supplyPrice" },
            { columnIndex: 7, field: "commissionRate" },
          ],
        },
        {
          segmentIndex: 1,
          sheetName,
          headerRow: 8,
          dataStartRow: 9,
          dataEndRow: 9,
          columnMap: [
            { columnIndex: 1, field: "productName" },
            { columnIndex: 2, field: "listPrice" },
            { columnIndex: 4, field: "sellingPrice" },
            { columnIndex: 6, field: "supplyPrice" },
            { columnIndex: 7, field: "commissionRate" },
          ],
        },
      ],
      policyBlocks: [],
    };

    const { rows, detectedTables } = parseRowsFromSegments(grids, structure);
    expect(detectedTables).toBe(2);
    expect(rows).toHaveLength(2);

    const seg0Row = rows.find((r) => r.tableSegment === 0)!;
    expect(seg0Row.productName).toBe("일반 가닥 속눈썹 3개 set");
    expect(seg0Row.sellingPrice).toBe(34900);
    expect(seg0Row.commissionRate).toBeCloseTo(0.35, 5);

    const seg1Row = rows.find((r) => r.tableSegment === 1)!;
    expect(seg1Row.productName).toBe("노글루 속눈썹 3개 set");
    expect(seg1Row.sellingPrice).toBe(34900);
  });

  it("row2/row10 표는 '마진' 컬럼(수수료 아님)을 쓰므로 별도 columnMap이 필요하다 — 다른 헤더 텍스트 확인", () => {
    const sheet = grids.sheets[0];
    // row2, row10은 "마진" 헤더 — row0/row8("정산가(수수료)")과 다른 열 구성
    expect(sheet.rows[2]?.[6]).toBe("마진");
    expect(sheet.rows[10]?.[6]).toBe("마진");
    expect(sheet.rows[2]?.[6]).not.toBe(sheet.rows[0]?.[6]);
  });
});
