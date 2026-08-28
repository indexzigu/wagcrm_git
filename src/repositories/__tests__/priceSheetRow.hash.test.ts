import { describe, expect, it } from "vitest";
import { PriceSheetRowRepository } from "../priceSheetRepository";

// 멱등 해시 결정성 검증: sha256(priceSheetId+rawCells).
// rawCells는 원본 셀 보존이 필수이므로, 동일 rawCells는 항상 동일 해시를 내야
// 재실행 시 upsertByHash가 중복 행을 만들지 않는다.

describe("PriceSheetRowRepository.computeRowHash — 결정성", () => {
  const priceSheetId = "sheet-1";
  const rawCells = { A: "상품A", B: "10000", C: "20%" };

  it("동일 입력에 대해 항상 동일한 해시를 반환한다", () => {
    const h1 = PriceSheetRowRepository.computeRowHash(priceSheetId, rawCells);
    const h2 = PriceSheetRowRepository.computeRowHash(priceSheetId, { A: "상품A", B: "10000", C: "20%" });
    expect(h1).toBe(h2);
  });

  it("sha256 hex 다이제스트 형식(64자 16진수)을 반환한다", () => {
    const hash = PriceSheetRowRepository.computeRowHash(priceSheetId, rawCells);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("priceSheetId가 다르면 해시가 달라진다 (다른 파일의 동일 셀 내용도 구분)", () => {
    const h1 = PriceSheetRowRepository.computeRowHash("sheet-1", rawCells);
    const h2 = PriceSheetRowRepository.computeRowHash("sheet-2", rawCells);
    expect(h1).not.toBe(h2);
  });

  it("rawCells 내용이 다르면 해시가 달라진다", () => {
    const h1 = PriceSheetRowRepository.computeRowHash(priceSheetId, rawCells);
    const h2 = PriceSheetRowRepository.computeRowHash(priceSheetId, { A: "상품B", B: "10000", C: "20%" });
    expect(h1).not.toBe(h2);
  });

  it("rawCells가 배열 형태(원본 셀 배열 보존)여도 결정적으로 해시된다", () => {
    const arrCells = ["상품A", "10000", "20%"];
    const h1 = PriceSheetRowRepository.computeRowHash(priceSheetId, arrCells);
    const h2 = PriceSheetRowRepository.computeRowHash(priceSheetId, ["상품A", "10000", "20%"]);
    expect(h1).toBe(h2);
  });

  it("키 순서가 다른 객체는 JSON.stringify 특성상 다른 해시가 날 수 있음을 인지한다 (원본 셀 순서 보존이 의도된 동작)", () => {
    const h1 = PriceSheetRowRepository.computeRowHash(priceSheetId, { A: "1", B: "2" });
    const h2 = PriceSheetRowRepository.computeRowHash(priceSheetId, { B: "2", A: "1" });
    // rawCells는 원본 셀을 그대로 보존하는 목적이므로 키 순서가 바뀌면 다른 해시가 나는 것이
    // 회귀가 아니라 의도된 동작이다 (원본 파싱 순서를 신뢰).
    expect(h1).not.toBe(h2);
  });
});
