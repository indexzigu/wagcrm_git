/**
 * 경로 A(xlsx/csv): 그리드 결정적 추출 + LLM 구조 분석(1회) + 결정적 파싱 (Phase 3 청사진 §2).
 *
 * LLM은 절대 셀 값을 생성하지 않는다 — {headerRow, segments[], columnMap, policyBlocks}
 * "구조"만 반환하고, 실제 값은 sheet-grid.ts로 읽은 그리드에서 결정적 코드가 꺼낸다.
 * 이 분리 덕분에 테스트는 columnMap을 고정 주입해 LLM 호출 없이 파싱 정확성만 검증할 수 있다
 * (청사진 §4 픽스처 회귀 테스트).
 */
import { readWorkbookGrids, getCell, rowToRawCells, gridToPromptText, type WorkbookGrids } from "./sheet-grid";
import { extractStructureASchema, sanitizeSegmentAgainstGrid, type ExtractStructureAParsed } from "./schema";
import { computeRowFlags } from "./flags";
import { parseFieldValue } from "./value-parse";
import { normalizeItemName } from "./normalize-name";
import { callPriceSheetExtractLlm, PriceSheetLlmError } from "./pricesheet-extract-client";
import { PriceSheetExtractError, STANDARD_FIELDS, type ExtractResultA, type ParsedRow, type TableSegment } from "./types";

const STRUCTURE_PROMPT_HEADER = `당신은 브랜드사가 보낸 가격표(엑셀)의 "구조"만 분석하는 애널리스트입니다.
절대 셀 값을 지어내거나 계산하지 마세요 — 오직 아래 JSON 스키마의 구조 정보만 반환합니다.

규칙:
1. 시트 상단에 요약/타이틀/합계 행이 있을 수 있습니다 — 실제 표 헤더 행 번호(0-based)를 정확히 찾으세요.
2. 한 시트/파일 안에 서로 다른 열 구성을 가진 표가 여러 개(다중표) 있을 수 있습니다 — 각각 독립된 세그먼트로 분리하세요.
3. 각 세그먼트의 열을 아래 표준 필드 중 하나로 매핑하세요(동의어 힌트 참고). 확신 없는 열은 매핑하지 마세요.
   - productName (제품명/상품명/품명/구성)
   - optionName (옵션명/구성/규격/세부구성)
   - sellingPrice (공동구매가/공구가/판매가/셀러가)
   - commissionRate (수수료율/마진률)
   - supplyPrice (공급가/원가/정산가/밴더사 공급가)
   - listPrice (정상가/온라인 최저가/소비자가)
   - floorPrice (최저가/마지노선가)
   - discountRate (할인율)
   - note (비고/프로모션/유통기한/참고 URL)
4. 정책/프로모션/정산조건 등 표가 아닌 자유 텍스트 문단은 policyBlocks로 분리하세요.
5. JSON 외 다른 텍스트는 절대 포함하지 마세요.

행 번호는 "R<번호>|" 접두사로 표시된 값입니다 (0-based). 셀은 "<열번호>:<값>" 형식입니다.

반환 JSON 스키마:
{
  "segments": [
    {
      "segmentIndex": 0,
      "sheetName": "시트명",
      "headerRow": 0,
      "dataStartRow": 1,
      "dataEndRow": 10,
      "columnMap": [{ "columnIndex": 0, "field": "productName" }, ...]
    }
  ],
  "policyBlocks": [{ "sheetName": "시트명", "rowIndex": 12, "text": "정책 문장" }]
}
`;

function buildStructurePrompt(grids: WorkbookGrids): string {
  const sheetSections = grids.sheets
    .map((sheet) => `=== 시트: ${sheet.sheetName} ===\n${gridToPromptText(sheet.rows)}`)
    .join("\n\n");
  return `${STRUCTURE_PROMPT_HEADER}\n\n${sheetSections}`;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

/** LLM 응답 텍스트를 zod로 검증해 구조를 파싱한다. 실패 시 throw. */
export function parseStructureResponse(text: string): ExtractStructureAParsed {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch (err) {
    throw new PriceSheetExtractError("LLM 구조 응답이 유효한 JSON이 아닙니다", err);
  }
  const result = extractStructureASchema.safeParse(json);
  if (!result.success) {
    throw new PriceSheetExtractError(
      `LLM 구조 응답이 스키마를 만족하지 않습니다: ${result.error.message}`
    );
  }
  return result.data;
}

/** 시트명 → 그리드 조회 헬퍼. */
function findSheetGrid(grids: WorkbookGrids, sheetName: string | undefined): unknown[][] | null {
  if (!sheetName) return grids.sheets[0]?.rows ?? null;
  const found = grids.sheets.find((s) => s.sheetName === sheetName);
  return found?.rows ?? grids.sheets[0]?.rows ?? null;
}

/**
 * 검증된 세그먼트들 + 그리드를 받아 결정적으로 행을 파싱한다.
 * 이 함수는 LLM을 호출하지 않으므로 테스트에서 columnMap을 고정 주입해 단위 테스트할 수 있다.
 */
export function parseRowsFromSegments(
  grids: WorkbookGrids,
  structure: ExtractStructureAParsed
): { rows: ParsedRow[]; detectedTables: number; columnMapping: TableSegment[] } {
  const rows: ParsedRow[] = [];
  const usedSegments: TableSegment[] = [];

  for (const rawSegment of structure.segments) {
    const grid = findSheetGrid(grids, rawSegment.sheetName);
    if (!grid) continue;

    const sheetColCount = grid.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
    const segment = sanitizeSegmentAgainstGrid(rawSegment, grid.length, sheetColCount);
    if (!segment) continue;

    usedSegments.push(segment);

    for (let r = segment.dataStartRow; r <= segment.dataEndRow; r++) {
      const rowArray = grid[r] as unknown[] | undefined;
      // 완전 빈 행은 스킵 (모든 셀 null/빈문자)
      if (!rowArray || rowArray.every((c) => c === null || c === undefined || c === "")) continue;

      const fieldValues: Partial<Record<(typeof STANDARD_FIELDS)[number], string | number | null>> = {};
      for (const { columnIndex, field } of segment.columnMap) {
        const cellValue = getCell(grid, r, columnIndex);
        fieldValues[field] = parseFieldValue(field, cellValue);
      }

      // 셀 안 줄바꿈·선행 번호를 여기서 접는다 — 이 값이 그대로 딜명이 되기 때문이다.
      // 원본은 rawCells 에 보존되므로 검수 화면 "원본 셀"에서 확인할 수 있다.
      const productName = normalizeItemName(fieldValues.productName as string | null);
      const missingRequiredField = !productName;

      const sellingPrice = (fieldValues.sellingPrice as number | null) ?? null;
      const supplyPrice = (fieldValues.supplyPrice as number | null) ?? null;
      const optionName = normalizeItemName(fieldValues.optionName as string | null);
      const note = (fieldValues.note as string | null) ?? null;

      const flags = computeRowFlags({
        productName,
        optionName,
        note,
        sellingPrice,
        supplyPrice,
        missingRequiredField,
      });

      rows.push({
        rowIndex: r,
        tableSegment: segment.segmentIndex,
        productName,
        optionName,
        sellingPrice,
        commissionRate: (fieldValues.commissionRate as number | null) ?? null,
        supplyPrice,
        listPrice: (fieldValues.listPrice as number | null) ?? null,
        floorPrice: (fieldValues.floorPrice as number | null) ?? null,
        discountRate: (fieldValues.discountRate as number | null) ?? null,
        note,
        flags,
        rawCells: { ...rowToRawCells(rowArray), __sheetName: segment.sheetName ?? null },
      });
    }
  }

  return { rows, detectedTables: usedSegments.length, columnMapping: usedSegments };
}

function policyBlocksToText(structure: ExtractStructureAParsed): string | null {
  if (structure.policyBlocks.length === 0) return null;
  return structure.policyBlocks.map((b) => b.text).join("\n\n");
}

/**
 * 전체 파이프라인: 버퍼 → 그리드 → LLM 구조 호출 → zod 검증 → 결정적 파싱.
 * LLM 실패 시 throw만 하고 DB에는 쓰지 않는다(mock-안전 패턴) — 호출부(API 라우트)가
 * PriceSheet.status=EXTRACT_FAILED로 남긴다.
 */
export async function extractPathA(buffer: Buffer): Promise<ExtractResultA> {
  const grids = readWorkbookGrids(buffer);
  const prompt = buildStructurePrompt(grids);

  let text: string;
  try {
    const result = await callPriceSheetExtractLlm(prompt);
    text = result.text;
  } catch (err) {
    if (err instanceof PriceSheetLlmError) {
      throw new PriceSheetExtractError(err.message, err);
    }
    throw err;
  }

  const structure = parseStructureResponse(text);
  const { rows, detectedTables, columnMapping } = parseRowsFromSegments(grids, structure);

  return {
    rows,
    policyText: policyBlocksToText(structure),
    detectedTables: Math.max(detectedTables, 1),
    columnMapping,
  };
}
