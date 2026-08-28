/**
 * xlsx/csv → 시트별 2차원 그리드 결정적 추출 (Phase 3 청사진 §2 경로 A).
 * order-parser.ts 관례(같은 xlsx 라이브러리)를 따른다. 값 해석은 여기서 하지 않는다 —
 * 순수하게 셀 원본 값만 그리드로 꺼낸다.
 */
import * as XLSX from "xlsx";

export type SheetGrid = {
  sheetName: string;
  rows: unknown[][];
};

export type WorkbookGrids = {
  sheets: SheetGrid[];
};

/**
 * xlsx/csv 파일 버퍼를 시트별 2차원 배열로 변환한다.
 * - header:1 → 배열의 배열 (헤더 자동 추론 없음, 순수 원본 그리드)
 * - raw:true → 날짜/숫자를 서식 문자열이 아닌 원본 값으로
 * - defval:null → 빈 셀을 undefined 대신 null로 통일 (JSON 직렬화 안전)
 */
export function readWorkbookGrids(buffer: Buffer | ArrayBuffer): WorkbookGrids {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheets: SheetGrid[] = wb.SheetNames.map((sheetName) => {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
    });
    return { sheetName, rows };
  });
  return { sheets };
}

/** 그리드 내 특정 셀 값을 안전하게 읽는다 (범위 밖은 null). */
export function getCell(grid: unknown[][], rowIndex: number, columnIndex: number): unknown {
  const row = grid[rowIndex];
  if (!row) return null;
  const value = row[columnIndex];
  return value === undefined ? null : value;
}

/** 행 전체를 { "0": value, "1": value, ... } 형태의 rawCells로 직렬화한다 (열 인덱스 문자열 키). */
export function rowToRawCells(row: unknown[] | undefined): Record<string, unknown> {
  if (!row) return {};
  const result: Record<string, unknown> = {};
  row.forEach((value, idx) => {
    result[String(idx)] = value === undefined ? null : value;
  });
  return result;
}

/** 시트 그리드를 LLM 프롬프트에 넣기 위한 축약 텍스트로 직렬화한다 (행 번호 포함, TSV 유사). */
export function gridToPromptText(grid: unknown[][], maxRows = 60): string {
  const lines: string[] = [];
  const limit = Math.min(grid.length, maxRows);
  for (let r = 0; r < limit; r++) {
    const row = grid[r] ?? [];
    const cells = row.map((cell, c) => {
      if (cell === null || cell === undefined || cell === "") return null;
      return `${c}:${String(cell).replace(/\s+/g, " ").trim().slice(0, 60)}`;
    }).filter(Boolean);
    if (cells.length === 0) continue;
    lines.push(`R${r}| ${cells.join(" | ")}`);
  }
  return lines.join("\n");
}
