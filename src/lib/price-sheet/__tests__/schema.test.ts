import { describe, expect, it } from "vitest";
import { extractStructureASchema, sanitizeSegmentAgainstGrid, tableSegmentSchema } from "../schema";

describe("extractStructureASchema — LLM 구조 응답 zod 검증", () => {
  it("표준 필드 화이트리스트 밖의 field는 파싱을 거부한다", () => {
    const result = extractStructureASchema.safeParse({
      segments: [
        {
          segmentIndex: 0,
          headerRow: 0,
          dataStartRow: 1,
          dataEndRow: 2,
          columnMap: [{ columnIndex: 0, field: "totallyMadeUpField" }],
        },
      ],
      policyBlocks: [],
    });
    expect(result.success).toBe(false);
  });

  it("유효한 구조는 통과한다", () => {
    const result = extractStructureASchema.safeParse({
      segments: [
        {
          segmentIndex: 0,
          headerRow: 0,
          dataStartRow: 1,
          dataEndRow: 2,
          columnMap: [{ columnIndex: 0, field: "productName" }],
        },
      ],
      policyBlocks: [{ text: "정책" }],
    });
    expect(result.success).toBe(true);
  });

  it("policyBlocks 생략 시 빈 배열로 기본값 처리된다", () => {
    const result = extractStructureASchema.safeParse({
      segments: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policyBlocks).toEqual([]);
    }
  });
});

describe("sanitizeSegmentAgainstGrid — 시트 실제 범위로 재검증", () => {
  const baseSegment = tableSegmentSchema.parse({
    segmentIndex: 0,
    headerRow: 0,
    dataStartRow: 1,
    dataEndRow: 10,
    columnMap: [{ columnIndex: 0, field: "productName" }],
  });

  it("headerRow가 시트 행 수를 벗어나면 null(세그먼트 폐기)", () => {
    const outOfRange = tableSegmentSchema.parse({ ...baseSegment, headerRow: 20, dataStartRow: 21, dataEndRow: 25 });
    expect(sanitizeSegmentAgainstGrid(outOfRange, 5, 3)).toBeNull();
  });

  it("dataEndRow가 시트 범위를 넘으면 clamp된다", () => {
    const result = sanitizeSegmentAgainstGrid(baseSegment, 8, 3);
    expect(result).not.toBeNull();
    expect(result!.dataEndRow).toBe(7);
  });

  it("dataStartRow > dataEndRow면 null", () => {
    const invalid = tableSegmentSchema.parse({
      ...baseSegment,
      dataStartRow: 10,
      dataEndRow: 2,
    });
    expect(sanitizeSegmentAgainstGrid(invalid, 20, 3)).toBeNull();
  });
});
