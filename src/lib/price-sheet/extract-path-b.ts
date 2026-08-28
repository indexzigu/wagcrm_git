/**
 * 경로 B(이미지/pdf/pptx): 멀티모달/텍스트 LLM 1회 호출로 행 배열 자체를 받는다
 * (Phase 3 청사진 §2). 경로 A와 달리 "렌더링된 그리드"가 없으므로 결정적 코드가
 * 셀 위치를 알 수 없다 — 대신 LLM에게 "불확실하면 null, 지어내기 금지"를 강하게 요구하고,
 * zod로 숫자/문자열 타입만 강제한 뒤 결정적 코드는 정규화(파싱)만 수행한다.
 *
 * pdf/이미지는 partnerService.ts:353-411의 mock-안전 패턴(inlineData base64, 실패 시 throw,
 * DB에 안 씀)을 그대로 따른다. pptx는 pptx-text.ts로 텍스트만 뽑아 텍스트 프롬프트로 보낸다
 * (렌더링 불필요 — 실증됨).
 */
import { z } from "zod";
import { normalizeItemName } from "./normalize-name";
import { callPriceSheetExtractLlm, PriceSheetLlmError, type InlinePart } from "./pricesheet-extract-client";
import { extractPptxSlideTexts, slidesToPromptText } from "./pptx-text";
import { computeRowFlags } from "./flags";
import { parseRateCell } from "./value-parse";
import { PriceSheetExtractError, MAX_FILE_SIZE_BYTES, type ExtractResultB, type ParsedRow } from "./types";

// M3(경로B): 비율 정규화 후에도 1보다 큰 값(예: 1.5 = 150%로 해석 불가능한 진짜 이상값)은
// "30%"→0.3처럼 되돌릴 수 없으므로 사고 방지용으로 needsReview 플래그를 붙인다.
const RATE_SANITY_MAX = 1;
// M4(경로B): 판매가가 비상식적으로 크면(오타/단위 오류 등) 검토 플래그.
const SELLING_PRICE_SANITY_MAX = 100_000_000; // 1억원

const ROW_PROMPT_HEADER = `당신은 브랜드사가 보낸 가격표(이미지/PDF/PPT)에서 표와 정책을 추출하는 애널리스트입니다.

규칙:
1. 표 형태가 아니라 산문/슬라이드 텍스트 안에 가격이 매립되어 있어도 복원하세요
   (예: "예상 공구가: 99,000원, 정산 금액: 28,200원(30%)" → sellingPrice=99000, supplyPrice=28200, commissionRate=0.3).
2. 금액은 숫자만 반환하세요(콤마/원화 기호 제거). 비율은 0~1 소수로 반환하세요(30% → 0.3).
3. 불확실하거나 명시되지 않은 값은 반드시 null로 반환하세요 — 절대 지어내지 마세요.
4. 여러 표/제품이 있으면 각각 별도 행으로 분리하세요(tableSegment로 구분, 0-based).
5. 정산조건/환불정책/원천징수 등 자유 텍스트 정책은 policyText 하나로 모으세요.
6. JSON 외 다른 텍스트는 절대 포함하지 마세요.

반환 JSON 스키마:
{
  "rows": [
    {
      "tableSegment": 0,
      "productName": "string|null",
      "optionName": "string|null",
      "sellingPrice": "number|null",
      "commissionRate": "number|null",
      "supplyPrice": "number|null",
      "listPrice": "number|null",
      "floorPrice": "number|null",
      "discountRate": "number|null",
      "note": "string|null"
    }
  ],
  "policyText": "string|null"
}
`;

const extractedRowBSchema = z.object({
  tableSegment: z.number().int().min(0).optional(),
  productName: z.string().nullable().optional(),
  optionName: z.string().nullable().optional(),
  sellingPrice: z.number().nullable().optional(),
  commissionRate: z.number().nullable().optional(),
  supplyPrice: z.number().nullable().optional(),
  listPrice: z.number().nullable().optional(),
  floorPrice: z.number().nullable().optional(),
  discountRate: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
});

const extractStructureBSchema = z.object({
  rows: z.array(extractedRowBSchema),
  policyText: z.string().nullable().optional(),
});

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

export function parseRowResponse(text: string): z.infer<typeof extractStructureBSchema> {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch (err) {
    throw new PriceSheetExtractError("LLM 행 응답이 유효한 JSON이 아닙니다", err);
  }
  const result = extractStructureBSchema.safeParse(json);
  if (!result.success) {
    throw new PriceSheetExtractError(`LLM 행 응답이 스키마를 만족하지 않습니다: ${result.error.message}`);
  }
  return result.data;
}

/**
 * LLM이 반환한 행 배열을 ParsedRow[]로 정규화(플래그 계산 포함)한다 — 순수 함수, 테스트 가능.
 *
 * M3: LLM은 프롬프트상 0~1 소수를 반환하도록 지시받지만("30% -> 0.3"), 실제로는 "30"처럼
 * 퍼센트 표기를 그대로 정수로 반환하는 경우가 있다 — 이 값이 그대로 Deal.totalCommissionRate에
 * 들어가면 "수수료율 3000%"라는 금전 사고가 된다. 경로 A(parseRateCell 사용)와 동일한
 * 정규화를 여기서도 적용한다: 1보다 큰 값은 /100, 0~1이면 그대로. parseRateCell이 이미
 * 처리하지 못하는 "정규화해도 1보다 큰"(예: 원본이 150 같은 값 -> 1.5) 진짜 이상값은
 * 사고 방지를 위해 needsReview 플래그로 검수자에게 넘긴다(클램프하지 않음 — 값을 임의로
 * 덮어쓰면 원본 의도를 알 수 없게 되므로 사람이 보게 한다).
 */
export function normalizeRowsB(
  parsed: z.infer<typeof extractStructureBSchema>
): { rows: ParsedRow[]; detectedTables: number } {
  const rows: ParsedRow[] = parsed.rows.map((row, idx) => {
    // 경로 A 와 같은 정규화 — 이미지/PDF 에서도 모델이 줄바꿈·번호를 그대로 옮겨 온다.
    const productName = normalizeItemName(row.productName);
    const sellingPrice = row.sellingPrice ?? null;
    const supplyPrice = row.supplyPrice ?? null;
    const optionName = normalizeItemName(row.optionName);
    const note = row.note ?? null;
    const missingRequiredField = !productName;

    // M3: commissionRate/discountRate에 parseRateCell과 동일한 정규화 적용.
    const commissionRate = parseRateCell(row.commissionRate ?? null);
    const discountRate = parseRateCell(row.discountRate ?? null);

    const flags = computeRowFlags({
      productName,
      optionName,
      note,
      sellingPrice,
      supplyPrice,
      missingRequiredField,
    });

    // M3: 정규화 후에도 1을 넘는 비율(예: 원본 150 -> 1.5)은 진짜 이상값 — 자동 보정하지
    // 않고 검토 플래그만 세워 사람이 판단하게 한다.
    const rateOutOfRange =
      (commissionRate !== null && commissionRate > RATE_SANITY_MAX) ||
      (discountRate !== null && discountRate > RATE_SANITY_MAX);

    // M4: 수치 sanity — 음수 값, sellingPrice가 비상식적으로 큰 경우(1억 초과) 등은
    // 결정적 코드가 확신할 수 없으므로 needsReview로 사람에게 넘긴다.
    const numericSanityFailed =
      (sellingPrice !== null && sellingPrice < 0) ||
      (supplyPrice !== null && supplyPrice < 0) ||
      (row.listPrice != null && row.listPrice < 0) ||
      (row.floorPrice != null && row.floorPrice < 0) ||
      (sellingPrice !== null && sellingPrice > SELLING_PRICE_SANITY_MAX);

    if (rateOutOfRange || numericSanityFailed) {
      flags.needsReview = true;
      flags.reason = [
        ...(flags.reason ?? []),
        ...(rateOutOfRange ? ["비율 정규화 후에도 1 초과(원본 값 확인 필요)"] : []),
        ...(numericSanityFailed ? ["수치 이상값(음수 또는 비상식적으로 큰 값) 검출"] : []),
      ];
    }

    return {
      rowIndex: idx,
      tableSegment: row.tableSegment ?? 0,
      productName,
      optionName,
      sellingPrice,
      commissionRate,
      supplyPrice,
      listPrice: row.listPrice ?? null,
      floorPrice: row.floorPrice ?? null,
      discountRate,
      note,
      flags,
      rawCells: { ...row },
    };
  });

  const detectedTables = new Set(rows.map((r) => r.tableSegment)).size || 1;
  return { rows, detectedTables };
}

export function assertFileSizeLimit(sizeBytes: number): void {
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new PriceSheetExtractError(
      `파일 크기가 20MB를 초과합니다 (${(sizeBytes / 1024 / 1024).toFixed(1)}MB)`
    );
  }
}

async function callLlmAndParse(prompt: string, inlinePart?: InlinePart) {
  let text: string;
  try {
    const result = await callPriceSheetExtractLlm(prompt, inlinePart);
    text = result.text;
  } catch (err) {
    if (err instanceof PriceSheetLlmError) {
      throw new PriceSheetExtractError(err.message, err);
    }
    throw err;
  }
  return parseRowResponse(text);
}

/** pptx: zip+regex로 텍스트만 뽑아 텍스트 프롬프트로 LLM 호출 (렌더링 불필요). */
export async function extractPathBPptx(buffer: Buffer): Promise<ExtractResultB> {
  assertFileSizeLimit(buffer.byteLength);
  const slides = await extractPptxSlideTexts(buffer);
  const slideText = slidesToPromptText(slides);
  const prompt = `${ROW_PROMPT_HEADER}\n\n=== 슬라이드 텍스트 ===\n${slideText}`;

  const parsed = await callLlmAndParse(prompt);
  const { rows, detectedTables } = normalizeRowsB(parsed);
  return { rows, policyText: parsed.policyText ?? null, detectedTables };
}

/** 이미지/pdf: inlineData base64로 멀티모달 호출 (partnerService.ts OCR 패턴). */
export async function extractPathBInline(
  buffer: Buffer,
  mimeType: string
): Promise<ExtractResultB> {
  assertFileSizeLimit(buffer.byteLength);
  const base64 = buffer.toString("base64");
  const prompt = ROW_PROMPT_HEADER;

  const parsed = await callLlmAndParse(prompt, { mimeType, data: base64 });
  const { rows, detectedTables } = normalizeRowsB(parsed);
  return { rows, policyText: parsed.policyText ?? null, detectedTables };
}
