/**
 * LLM 구조 응답(zod) 검증 — 경로 A {headerRow, segments[], columnMap, policyBlocks}.
 * 청사진 R-B: "LLM 매핑 오판" 대응으로 headerRow/columnMap 범위와 표준필드 화이트리스트를
 * 여기서 강제한다. 검증 실패 시 해당 세그먼트/필드를 버리고 실패행 rawCells 보존 경로로 넘어간다.
 */
import { z } from "zod";
import { STANDARD_FIELDS } from "./types";

export const columnMapEntrySchema = z.object({
  columnIndex: z.number().int().min(0).max(200),
  field: z.enum(STANDARD_FIELDS),
});

export const tableSegmentSchema = z.object({
  segmentIndex: z.number().int().min(0),
  sheetName: z.string().optional(),
  headerRow: z.number().int().min(0).max(5000),
  dataStartRow: z.number().int().min(0).max(5000),
  dataEndRow: z.number().int().min(0).max(5000),
  columnMap: z.array(columnMapEntrySchema).min(1),
});

export const policyBlockSchema = z.object({
  sheetName: z.string().optional(),
  rowIndex: z.number().int().min(0).optional(),
  text: z.string().min(1),
});

export const extractStructureASchema = z.object({
  segments: z.array(tableSegmentSchema),
  policyBlocks: z.array(policyBlockSchema).default([]),
});

/**
 * 세그먼트 하나를 그리드 실제 범위에 맞춰 재검증한다.
 * - headerRow < dataStartRow <= dataEndRow < sheetRowCount
 * - columnIndex가 시트 실제 컬럼 수를 크게 벗어나면 버림(0~200 범위는 zod가 이미 커버,
 *   여기서는 시트별 실측 범위로 더 좁힘)
 * 유효하지 않으면 null을 반환해 호출부가 해당 세그먼트를 스킵(=행 전체 needsReview)하게 한다.
 */
export function sanitizeSegmentAgainstGrid(
  segment: z.infer<typeof tableSegmentSchema>,
  sheetRowCount: number,
  sheetColCount: number
): z.infer<typeof tableSegmentSchema> | null {
  if (segment.headerRow >= sheetRowCount) return null;
  if (segment.dataStartRow > segment.dataEndRow) return null;
  if (segment.dataStartRow >= sheetRowCount) return null;

  const clampedEnd = Math.min(segment.dataEndRow, sheetRowCount - 1);
  const validColumnMap = segment.columnMap.filter((c) => c.columnIndex < Math.max(sheetColCount, 1) + 50);
  // 과도하게 벗어난 컬럼 인덱스만 제거 — 완전 폐기하지 않고 최대한 살린다(R-B: 검수 확정 원칙).
  if (validColumnMap.length === 0) return null;

  return {
    ...segment,
    dataEndRow: clampedEnd,
    columnMap: validColumnMap,
  };
}

export type ExtractStructureAParsed = z.infer<typeof extractStructureASchema>;
