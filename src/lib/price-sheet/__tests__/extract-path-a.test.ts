/**
 * 경로 A(xlsx/csv) 순수 함수 테스트 — parseStructureResponse(LLM 구조 JSON 파싱)와
 * 멱등성(동일 그리드+동일 구조 → 동일 파싱 결과) 회귀를 검증한다.
 */
import { describe, expect, it } from "vitest";
import { parseStructureResponse, parseRowsFromSegments } from "../extract-path-a";
import { PriceSheetExtractError } from "../types";
import type { WorkbookGrids } from "../sheet-grid";

describe("parseStructureResponse", () => {
  it("유효한 구조 JSON을 파싱한다", () => {
    const text = JSON.stringify({
      segments: [
        {
          segmentIndex: 0,
          headerRow: 0,
          dataStartRow: 1,
          dataEndRow: 2,
          columnMap: [{ columnIndex: 0, field: "productName" }],
        },
      ],
      policyBlocks: [],
    });
    const structure = parseStructureResponse(text);
    expect(structure.segments).toHaveLength(1);
  });

  it("코드펜스 감싼 응답도 파싱한다", () => {
    const text = "```json\n" + JSON.stringify({ segments: [], policyBlocks: [] }) + "\n```";
    expect(() => parseStructureResponse(text)).not.toThrow();
  });

  it("화이트리스트 밖 필드가 있으면 throw", () => {
    const text = JSON.stringify({
      segments: [
        {
          segmentIndex: 0,
          headerRow: 0,
          dataStartRow: 1,
          dataEndRow: 2,
          columnMap: [{ columnIndex: 0, field: "존재하지않는필드" }],
        },
      ],
      policyBlocks: [],
    });
    expect(() => parseStructureResponse(text)).toThrow(PriceSheetExtractError);
  });

  it("JSON이 아닌 텍스트는 throw", () => {
    expect(() => parseStructureResponse("이것은 JSON이 아님")).toThrow(PriceSheetExtractError);
  });
});

describe("parseRowsFromSegments — 멱등성(동일 입력 → 동일 출력) 회귀", () => {
  const grids: WorkbookGrids = {
    sheets: [
      {
        sheetName: "시트1",
        rows: [
          ["제품명", "가격"],
          ["상품A", 1000],
          ["상품B", 2000],
        ],
      },
    ],
  };
  const structure = {
    segments: [
      {
        segmentIndex: 0,
        sheetName: "시트1",
        headerRow: 0,
        dataStartRow: 1,
        dataEndRow: 2,
        columnMap: [
          { columnIndex: 0, field: "productName" as const },
          { columnIndex: 1, field: "sellingPrice" as const },
        ],
      },
    ],
    policyBlocks: [],
  };

  it("같은 그리드+구조를 두 번 파싱하면 완전히 동일한 rows가 나온다", () => {
    const result1 = parseRowsFromSegments(grids, structure);
    const result2 = parseRowsFromSegments(grids, structure);
    expect(result1.rows).toEqual(result2.rows);
  });

  it("빈 행은 결과에서 제외된다", () => {
    const gridsWithEmpty: WorkbookGrids = {
      sheets: [
        {
          sheetName: "시트1",
          rows: [["제품명", "가격"], ["상품A", 1000], [null, null], ["상품B", 2000]],
        },
      ],
    };
    const structureExtended = {
      ...structure,
      segments: [{ ...structure.segments[0], dataEndRow: 3 }],
    };
    const { rows } = parseRowsFromSegments(gridsWithEmpty, structureExtended);
    expect(rows).toHaveLength(2);
  });
});
