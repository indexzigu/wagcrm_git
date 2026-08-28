/**
 * SQLite 로컬 개발환경에서 flags/rawCells/columnMapping이 JSON 문자열로 오는 경우를
 * API 응답 직전에 역직렬화하는 헬퍼 검증. Postgres(이미 객체)에서도 안전해야 한다(멱등).
 */
import { describe, expect, it } from "vitest";
import { normalizePriceSheetRowForResponse, normalizePriceSheetForResponse } from "../serialize-response";

describe("normalizePriceSheetRowForResponse", () => {
  it("SQLite처럼 문자열로 온 flags/rawCells를 객체로 역직렬화한다", () => {
    const row = { flags: '{"negativeMargin":true}', rawCells: '{"0":"A"}' };
    const result = normalizePriceSheetRowForResponse(row);
    expect(result.flags).toEqual({ negativeMargin: true });
    expect(result.rawCells).toEqual({ "0": "A" });
  });

  it("Postgres처럼 이미 객체인 경우 그대로 유지(멱등)", () => {
    const row = { flags: { negativeMargin: true }, rawCells: { "0": "A" } };
    const result = normalizePriceSheetRowForResponse(row);
    expect(result.flags).toEqual({ negativeMargin: true });
    expect(result.rawCells).toEqual({ "0": "A" });
  });

  it("rawCells가 null이면 빈 객체로 폴백", () => {
    const row = { flags: null, rawCells: null };
    const result = normalizePriceSheetRowForResponse(row);
    expect(result.rawCells).toEqual({});
  });
});

describe("normalizePriceSheetForResponse", () => {
  it("columnMapping과 rows[].flags/rawCells를 함께 역직렬화한다", () => {
    const sheet = {
      columnMapping: '[{"segmentIndex":0}]',
      rows: [{ flags: '{"needsReview":true}', rawCells: "{}" }],
    };
    const result = normalizePriceSheetForResponse(sheet);
    expect(result.columnMapping).toEqual([{ segmentIndex: 0 }]);
    expect(result.rows![0].flags).toEqual({ needsReview: true });
  });

  it("rows가 없는 목록 응답에서도 안전하게 동작", () => {
    const sheet: { columnMapping: null; rows?: Array<{ flags?: unknown; rawCells?: unknown }> } = {
      columnMapping: null,
    };
    const result = normalizePriceSheetForResponse(sheet);
    expect(result.columnMapping).toBeNull();
    expect(result.rows).toBeUndefined();
  });
});
