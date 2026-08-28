import { z } from 'zod';
import { readWorkbookGrids, gridToPromptText } from '@/lib/price-sheet/sheet-grid';
import { callPriceSheetExtractLlm } from '@/lib/price-sheet/pricesheet-extract-client';
import {
  NAVER_ORDER_FIELDS,
  parseOrderExcelRules,
  type NaverOrderField,
  type OrderExcelRules,
} from './excel-rules';

// F4 Phase 2 §3 — 업로드된 '발주서 양식'(ORDER_TEMPLATE 자산) 분석:
// 헤더 탐지 → 열별 네이버 필드 추천(1차 휴리스틱 사전 + 2차 LLM) → 드래프트 규칙.
// price-sheet 엔진과 동일한 원칙: LLM은 "구조만" 반환하고 값은 결정적 코드가 읽는다.
// 분석 결과는 DB에 저장하지 않는다(설계 D2) — 검수 UI가 수정·확정할 때만 Partner에 기록.

// ─── 1차 휴리스틱: 헤더 동의어 사전 ───
// 정확일치(공백 제거·소문자화 후)만 매핑한다. '전화'/'핸드폰'/'연락처' 같은 단독 범용어는
// 트리프처럼 수취인/주문인 블록에 중복 등장해 문맥 없이는 오매핑 위험 → 사전에서 제외(LLM 몫).
const HEADER_SYNONYMS: ReadonlyArray<readonly [NaverOrderField, readonly string[]]> = [
  ['주문일', ['주문일', '주문일자', '주문일시', '발주일']],
  ['상품주문번호', ['상품주문번호', '주문번호', '품목별주문번호']],
  ['구매자명', ['구매자명', '구매자', '주문자', '주문자명', '주문인']],
  ['구매자연락처', ['구매자연락처', '주문자연락처', '주문자휴대폰', '주문자전화']],
  ['수취인명', ['수취인명', '수취인', '수령자', '수령자명', '수령인', '수령인명', '받는사람', '받는분']],
  ['수취인연락처1', ['수취인연락처1', '수취인연락처', '수령자연락처', '수령인연락처', '수령인휴대폰', '수령인전화', '수취인휴대폰', '수취인전화']],
  ['수취인연락처2', ['수취인연락처2', '연락처2']],
  ['우편번호', ['우편번호', '우편', 'zip', 'zipcode']],
  ['배송지', ['배송지', '주소', '수취인주소', '수령인주소', '배송주소', '통합배송지']],
  ['옵션정보', ['옵션정보', '옵션명', '옵션', '품목', '구성', '세부구성']],
  ['수량', ['수량', '주문수량', '발주수량', '개수']],
  ['배송비', ['배송비', '운임', '운임비', '배송료']],
  ['배송메시지', ['배송메시지', '배송메세지', '메시지', '메세지', '배송요청사항', '요청사항']],
  ['사은품', ['사은품', '사은품명', '증정품']],
  ['상품코드', ['상품코드', '자체코드', '브랜드코드', '품목코드']],
  ['검증', ['검증']],
  ['공구판매가', ['공구판매가', '공구가', '판매가', '단가']],
];

function normalizeHeader(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, '').toLowerCase();
}

const SYNONYM_LOOKUP: ReadonlyMap<string, NaverOrderField> = new Map(
  HEADER_SYNONYMS.flatMap(([field, synonyms]) => synonyms.map((s) => [normalizeHeader(s), field] as const))
);

/** 헤더 문자열 → 네이버 필드 (정확일치 휴리스틱). 미지·빈 헤더는 null. */
export function heuristicFieldForHeader(header: unknown): NaverOrderField | null {
  const normalized = normalizeHeader(header);
  if (!normalized) return null;
  return SYNONYM_LOOKUP.get(normalized) ?? null;
}

/**
 * 상위 행들을 스캔해 헤더 행을 추정한다 — 동의어 적중이 가장 많은 행(최소 2개).
 * (parseNaverOrders의 헤더 탐지와 같은 접근을 일반화)
 */
export function scanHeaderRow(rows: unknown[][], maxScan = 10): { headerRow: number; score: number } | null {
  let best: { headerRow: number; score: number } | null = null;
  const limit = Math.min(rows.length, maxScan);
  for (let r = 0; r < limit; r++) {
    const row = rows[r] ?? [];
    const score = row.reduce<number>((acc, cell) => (heuristicFieldForHeader(cell) ? acc + 1 : acc), 0);
    if (score >= 2 && (!best || score > best.score)) {
      best = { headerRow: r, score };
    }
  }
  return best;
}

// ─── 2차 LLM: 구조만 반환 ───

const analyzeLlmResponseSchema = z.object({
  sheetName: z.string().optional(),
  headerRow: z.number().int().min(0),
  dataStartRow: z.number().int().min(0),
  columns: z.array(
    z.object({
      columnIndex: z.number().int().min(0),
      field: z.enum(NAVER_ORDER_FIELDS).nullable(),
      confidence: z.number().min(0).max(1).optional(),
    })
  ),
});

export type AnalyzeLlmResponse = z.infer<typeof analyzeLlmResponseSchema>;

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

/** LLM 응답 텍스트 → 검증된 구조. 실패 시 throw (호출부가 휴리스틱-only로 폴백 + 경고 표면화). */
export function parseAnalyzeLlmResponse(text: string): AnalyzeLlmResponse {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(text));
  } catch {
    throw new Error('LLM 응답이 JSON이 아닙니다.');
  }
  const parsed = analyzeLlmResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`LLM 응답이 스키마와 불일치: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return parsed.data;
}

const ANALYZE_PROMPT_HEADER = `당신은 브랜드사 "발주서 양식"(엑셀)의 구조만 분석하는 애널리스트입니다.
목표: 발주서의 각 열에 네이버 스마트스토어 주문의 어떤 표준 필드가 들어가야 하는지 매핑을 추천합니다.
절대 셀 값을 지어내거나 계산하지 마세요 — 오직 아래 JSON 스키마의 구조 정보만 반환합니다.

표준 필드 (field에는 반드시 이 값들 중 하나 또는 null만 사용):
- 주문일 (주문/발주 일자)
- 상품주문번호 (네이버 상품주문번호 — 송장 회신 매핑 키)
- 구매자명 (주문자/주문인), 구매자연락처 (주문자 전화)
- 수취인명 (수령자/받는사람), 수취인연락처1 (수령인 전화/핸드폰), 수취인연락처2
- 우편번호, 배송지 (주소)
- 옵션정보 (품목/옵션명/구성), 수량, 배송비 (운임)
- 배송메시지 (요청사항), 사은품
- 상품코드 (자체코드/브랜드코드), 검증, 공구판매가 (단가/판매가)

규칙:
1. 상단에 타이틀/안내 행이 있을 수 있습니다 — 실제 표 헤더 행 번호(0-based)를 정확히 찾으세요.
2. 같은 헤더가 반복될 수 있습니다(예: 수취인 블록과 주문인 블록의 '전화'/'핸드폰') — 좌측 그룹 헤더 문맥으로 구분하고, 확신이 없으면 field를 null로 두세요.
3. 브랜드 내부용 열(내부 코드·메모 등) 등 매핑 불가 열은 field: null.
4. confidence는 0~1 (확신 낮으면 낮게).
5. JSON 외 다른 텍스트는 절대 포함하지 마세요.

행 번호는 "R<번호>|" 접두사로 표시된 값입니다 (0-based). 셀은 "<열번호>:<값>" 형식입니다.

반환 JSON 스키마:
{
  "sheetName": "시트명",
  "headerRow": 0,
  "dataStartRow": 1,
  "columns": [{ "columnIndex": 0, "field": "수취인명", "confidence": 0.9 }, { "columnIndex": 5, "field": null }]
}
`;

// ─── 분석 오케스트레이션 ───

export type AnalyzeColumnMeta = {
  col: number; // 1-based (규칙과 동일 기준)
  header: string;
  suggestedField: NaverOrderField | null;
  source: 'heuristic' | 'llm' | null;
  confidence: number; // 휴리스틱=1, LLM=응답값(기본 0.5), 미매핑=0
};

export type OrderTemplateAnalysis = {
  sheetName: string;
  headerRow: number; // 1-based
  dataStartRow: number; // 1-based
  headers: string[];
  columns: AnalyzeColumnMeta[];
  draftRules: OrderExcelRules;
  sampleRows: string[][]; // 헤더 아래 최대 3행 미리보기 (검수 UI용)
  warnings: string[];
  llmUsed: boolean;
};

export type AnalyzeLlmCaller = (prompt: string) => Promise<{ text: string }>;

/**
 * 발주서 양식 버퍼 → 드래프트 매핑 규칙 + 열별 추천 메타.
 * llm 파라미터는 테스트 주입용 — 기본은 price-sheet Gemini 클라이언트 재사용.
 * LLM 실패는 삼키지 않고 warnings로 표면화하되 휴리스틱-only 드래프트는 항상 반환한다
 * (HITL이 곧 폴백 — LLM 없이도 검수 UI에서 전량 수동 매핑 가능해야 한다).
 */
export async function analyzeOrderTemplate(
  buffer: Buffer | ArrayBuffer,
  opts: { sourceAssetId: string | null },
  llm: AnalyzeLlmCaller = callPriceSheetExtractLlm
): Promise<OrderTemplateAnalysis> {
  let grids;
  try {
    grids = readWorkbookGrids(buffer);
  } catch (error: any) {
    if (error?.message?.includes('password-protected')) {
      throw new Error('발주서 양식 파일에 암호가 설정되어 있어 분석할 수 없습니다. 암호를 해제해 다시 업로드하세요.');
    }
    throw new Error(`발주서 양식 파일을 읽지 못했습니다: ${error?.message ?? error}`);
  }
  const sheets = grids.sheets.filter((s) => s.rows.length > 0);
  if (sheets.length === 0) {
    throw new Error('발주서 양식 파일에 내용이 있는 시트가 없습니다.');
  }

  const warnings: string[] = [];

  // 휴리스틱 기준 시트/헤더행: 동의어 적중 최다 시트(동점이면 앞 시트)
  let chosen = sheets[0];
  let chosenScan = scanHeaderRow(chosen.rows);
  for (const sheet of sheets.slice(1)) {
    const scan = scanHeaderRow(sheet.rows);
    if (scan && (!chosenScan || scan.score > chosenScan.score)) {
      chosen = sheet;
      chosenScan = scan;
    }
  }
  let headerRow0 = chosenScan?.headerRow ?? 0;
  if (!chosenScan) {
    warnings.push('헤더 행을 휴리스틱으로 확정하지 못했습니다. 첫 행을 헤더로 가정했으니 검수에서 확인하세요.');
  }

  // 2차 LLM (구조만). 실패해도 휴리스틱-only로 진행.
  let llmResponse: AnalyzeLlmResponse | null = null;
  let llmUsed = false;
  try {
    const sheetSections = sheets
      .map((sheet) => `=== 시트: ${sheet.sheetName} ===\n${gridToPromptText(sheet.rows)}`)
      .join('\n\n');
    const { text } = await llm(`${ANALYZE_PROMPT_HEADER}\n\n${sheetSections}`);
    llmResponse = parseAnalyzeLlmResponse(text);
    llmUsed = true;
  } catch (error: any) {
    warnings.push(`LLM 열 매핑 추천 실패(휴리스틱 추천만 제공): ${error?.message ?? error}`);
  }

  // LLM이 유효한 시트/헤더행을 지목하면 채택 (그리드 대비 sanitize — 범위 밖이면 휴리스틱 유지)
  if (llmResponse) {
    const llmSheet = llmResponse.sheetName ? sheets.find((s) => s.sheetName === llmResponse!.sheetName) : null;
    if (llmSheet) chosen = llmSheet;
    if (llmResponse.headerRow < chosen.rows.length) {
      headerRow0 = llmResponse.headerRow;
    } else {
      warnings.push(`LLM이 지목한 헤더 행(R${llmResponse.headerRow})이 그리드 범위를 벗어나 휴리스틱 헤더 행을 사용합니다.`);
      llmResponse = { ...llmResponse, dataStartRow: headerRow0 + 1 };
    }
  }

  const headerCells = chosen.rows[headerRow0] ?? [];
  const headers = headerCells.map((c) => String(c ?? '').trim());
  if (headers.every((h) => !h)) {
    throw new Error(`헤더 행(R${headerRow0})이 비어 있습니다. 발주서 양식에 열 제목 행이 있는지 확인하세요.`);
  }

  const dataStartRow0 = Math.max(llmResponse?.dataStartRow ?? headerRow0 + 1, headerRow0 + 1);

  // 헤더행 위에 내용이 있으면 다중 헤더/타이틀 가능성 고지 (v1은 단일 헤더행 가정)
  for (let r = 0; r < headerRow0; r++) {
    if ((chosen.rows[r] ?? []).some((c) => c !== null && c !== '')) {
      warnings.push('헤더 행 위에 내용이 있습니다(타이틀/다중 헤더 의심). 생성 양식이 다르면 검수에서 조정하세요.');
      break;
    }
  }

  // 열별 추천 병합: 휴리스틱 정확일치 우선, 나머지는 LLM (그리드 범위 밖 columnIndex는 폐기)
  const llmByCol = new Map<number, { field: NaverOrderField | null; confidence: number }>();
  llmResponse?.columns.forEach((c) => {
    if (c.columnIndex >= 0 && c.columnIndex < headers.length) {
      llmByCol.set(c.columnIndex, { field: c.field, confidence: c.confidence ?? 0.5 });
    }
  });

  const columns: AnalyzeColumnMeta[] = headers.map((header, idx) => {
    const heuristic = heuristicFieldForHeader(header);
    if (heuristic) {
      return { col: idx + 1, header, suggestedField: heuristic, source: 'heuristic', confidence: 1 };
    }
    const llmSuggestion = llmByCol.get(idx);
    if (llmSuggestion?.field) {
      return { col: idx + 1, header, suggestedField: llmSuggestion.field, source: 'llm', confidence: llmSuggestion.confidence };
    }
    return { col: idx + 1, header, suggestedField: null, source: null, confidence: 0 };
  });

  const duplicated = new Map<NaverOrderField, number>();
  columns.forEach((c) => {
    if (c.suggestedField) duplicated.set(c.suggestedField, (duplicated.get(c.suggestedField) ?? 0) + 1);
  });
  for (const [field, count] of duplicated) {
    if (count > 1) warnings.push(`'${field}' 필드가 ${count}개 열에 추천되었습니다. 검수에서 하나만 남기거나 의도를 확인하세요.`);
  }
  const unmappedCount = columns.filter((c) => !c.suggestedField).length;
  if (unmappedCount > 0) {
    warnings.push(`미매핑 열 ${unmappedCount}개: 기본값은 '비움'이며 검수에서 소스를 지정할 수 있습니다.`);
  }

  const draftRules: OrderExcelRules = {
    version: 1,
    sourceAssetId: opts.sourceAssetId,
    templateStoragePath: null, // 확정 시 스냅샷 복사 후 채움 (설계 D4)
    analyzedAt: new Date().toISOString(),
    headerSnapshot: headers,
    // v1 신규 브랜드 기본 = new-workbook (설계 D5). 헤더/데이터 시작 위치는 양식과 동일하게.
    write: { mode: 'new-workbook', sheetName: chosen.sheetName, headerRow: headerRow0 + 1, dataStartRow: dataStartRow0 + 1 },
    columns: columns.map((c) => ({
      col: c.col,
      header: c.header,
      source: c.suggestedField ? { type: 'field', field: c.suggestedField } : { type: 'empty' },
    })),
    // 회신 파싱은 양식 파일로 알 수 없다 — 관대한 기본값, 첫 회신 후 조정 (경고 고지)
    reply: { orderIdHeaders: ['주문번호', '상품주문번호'], orderIdPattern: 'lenient' },
  };
  warnings.push('회신(송장) 파싱 규칙은 기본값입니다. 첫 회신 파일 수신 후 필요 시 조정하세요.');

  // 자기 검증: 조립한 드래프트가 스키마를 통과하지 못하면 조립 버그다 — 조용히 내보내지 않는다.
  if (!parseOrderExcelRules(draftRules)) {
    throw new Error('내부 오류: 조립된 드래프트 규칙이 스키마 검증에 실패했습니다.');
  }

  const sampleRows = chosen.rows
    .slice(dataStartRow0, dataStartRow0 + 3)
    .map((row) => headers.map((_h, idx) => String((row ?? [])[idx] ?? '')));

  return {
    sheetName: chosen.sheetName,
    headerRow: headerRow0 + 1,
    dataStartRow: dataStartRow0 + 1,
    headers,
    columns,
    draftRules,
    sampleRows,
    warnings,
    llmUsed,
  };
}
