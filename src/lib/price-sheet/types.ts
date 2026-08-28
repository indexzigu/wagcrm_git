/**
 * 가격표 인제스트 공통 타입 (Phase 3 청사진 §2).
 *
 * 경로 A(xlsx/csv): LLM은 {headerRow, segments[], policyBlocks} 구조만 반환하고,
 * 실제 셀 값은 결정적 코드(sheet-grid.ts + extract-path-a.ts)가 읽는다 — 값 생성 금지.
 * 경로 B(이미지/pdf/pptx): LLM이 행 배열 자체를 반환한다(표가 렌더링된 형태가 없으므로).
 */

// PriceSheetRow 표준 필드 화이트리스트. LLM columnMap의 target은 이 값들 중 하나여야 한다.
export const STANDARD_FIELDS = [
  "productName",
  "optionName",
  "sellingPrice",
  "commissionRate",
  "supplyPrice",
  "listPrice",
  "floorPrice",
  "discountRate",
  "note",
] as const;

export type StandardField = (typeof STANDARD_FIELDS)[number];

export const NUMERIC_FIELDS: readonly StandardField[] = [
  "sellingPrice",
  "commissionRate",
  "supplyPrice",
  "listPrice",
  "floorPrice",
  "discountRate",
];

// 열 인덱스는 0-based, 시트 내 절대 컬럼 위치.
export type ColumnMapEntry = {
  columnIndex: number;
  field: StandardField;
};

// 세그먼트: 한 시트/파일 내 독립된 표 하나. 각 세그먼트는 자신만의 columnMap을 가진다
// (청사진 R-C: coringco처럼 표마다 열 구성이 다를 수 있음).
export type TableSegment = {
  segmentIndex: number;
  sheetName?: string;
  headerRow: number; // 0-based, 이 표의 헤더가 위치한 행
  dataStartRow: number; // 0-based, 데이터 첫 행 (보통 headerRow + 1)
  dataEndRow: number; // 0-based inclusive, 데이터 마지막 행
  columnMap: ColumnMapEntry[];
};

export type PolicyBlock = {
  sheetName?: string;
  rowIndex?: number;
  text: string;
};

// LLM이 반환하는 "구조만" — 경로 A 전용.
export type ExtractStructureA = {
  segments: TableSegment[];
  policyBlocks: PolicyBlock[];
};

// 파싱된 행 (결정적 코드 산출물). rawCells는 항상 보존.
export type ParsedRow = {
  rowIndex: number;
  tableSegment: number;
  productName: string | null;
  optionName: string | null;
  sellingPrice: number | null;
  commissionRate: number | null;
  supplyPrice: number | null;
  listPrice: number | null;
  floorPrice: number | null;
  discountRate: number | null;
  note: string | null;
  flags: RowFlags;
  rawCells: Record<string, unknown>;
};

export type RowFlags = {
  needsReview?: boolean;
  negativeMargin?: boolean; // 판매가 - 원가(공급가) < 0
  giftOrBundle?: boolean; // "증정"/"사은품" 등 키워드 검출
  singlePurchaseBlocked?: boolean; // "단독구매불가" 등
  missingRequiredField?: boolean;
  reason?: string[];
};

export type ExtractResultA = {
  rows: ParsedRow[];
  policyText: string | null;
  detectedTables: number;
  columnMapping: TableSegment[];
};

// 경로 B(이미지/pdf/pptx) — LLM이 직접 행 배열을 반환.
export type ExtractedRowB = {
  tableSegment?: number;
  productName?: string | null;
  optionName?: string | null;
  sellingPrice?: number | null;
  commissionRate?: number | null;
  supplyPrice?: number | null;
  listPrice?: number | null;
  floorPrice?: number | null;
  discountRate?: number | null;
  note?: string | null;
};

export type ExtractStructureB = {
  rows: ExtractedRowB[];
  policyText: string | null;
};

export type ExtractResultB = {
  rows: ParsedRow[];
  policyText: string | null;
  detectedTables: number;
};

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB (청사진 R-D)

// 업로드 허용 확장자 — 서버 게이트의 정본은 업로드 라우트의 EXT_TO_FORMAT이고,
// 이 목록은 클라이언트 선검증·input accept용 파생본이다(둘이 어긋나면 라우트가 이긴다).
export const ACCEPTED_UPLOAD_EXTENSIONS = [
  "xlsx",
  "xls",
  "csv",
  "pptx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
] as const;

export class PriceSheetExtractError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PriceSheetExtractError";
  }
}
