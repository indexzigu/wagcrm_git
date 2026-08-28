import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  analyzeOrderTemplate,
  heuristicFieldForHeader,
  parseAnalyzeLlmResponse,
  scanHeaderRow,
} from '../template-analyze';
import { parseOrderExcelRules } from '../excel-rules';

function buildXlsx(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows as any[][]), name);
  }
  return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
}

const FAILING_LLM = async () => {
  throw new Error('quota exceeded');
};

describe('heuristicFieldForHeader (동의어 사전)', () => {
  it('정확일치 매핑 (공백·대소문자 무시)', () => {
    expect(heuristicFieldForHeader('수령자')).toBe('수취인명');
    expect(heuristicFieldForHeader('받는분')).toBe('수취인명');
    expect(heuristicFieldForHeader('수취인 연락처')).toBe('수취인연락처1');
    expect(heuristicFieldForHeader('운임')).toBe('배송비');
    expect(heuristicFieldForHeader('메세지')).toBe('배송메시지');
    expect(heuristicFieldForHeader('품목')).toBe('옵션정보');
    expect(heuristicFieldForHeader('자체코드')).toBe('상품코드');
  });

  it("단독 범용어('전화'/'핸드폰'/'연락처')는 문맥 없이 매핑하지 않는다 (트리프 중복 블록 오매핑 방지)", () => {
    expect(heuristicFieldForHeader('전화')).toBeNull();
    expect(heuristicFieldForHeader('핸드폰')).toBeNull();
    expect(heuristicFieldForHeader('연락처')).toBeNull();
  });

  it('미지·빈 헤더 → null', () => {
    expect(heuristicFieldForHeader('브랜드내부메모')).toBeNull();
    expect(heuristicFieldForHeader('')).toBeNull();
    expect(heuristicFieldForHeader(null)).toBeNull();
  });
});

describe('scanHeaderRow', () => {
  it('동의어 적중 최다 행을 헤더로 지목한다 (타이틀 행 건너뜀)', () => {
    const rows = [
      ['○○브랜드 발주서 양식 v3'],
      [],
      ['수령자', '연락처', '주소', '품목', '수량', '비고'],
      ['홍길동', '010', '서울', 'A세트', 1, ''],
    ];
    expect(scanHeaderRow(rows)).toEqual({ headerRow: 2, score: 4 });
  });

  it('적중 2개 미만이면 null (첫 행 가정은 호출부 몫)', () => {
    expect(scanHeaderRow([['a', 'b'], ['c']])).toBeNull();
    expect(scanHeaderRow([])).toBeNull();
  });
});

describe('parseAnalyzeLlmResponse', () => {
  const valid = {
    sheetName: '발주서',
    headerRow: 0,
    dataStartRow: 1,
    columns: [{ columnIndex: 0, field: '수취인명', confidence: 0.9 }, { columnIndex: 1, field: null }],
  };

  it('유효 JSON·코드펜스 래핑 모두 통과', () => {
    expect(parseAnalyzeLlmResponse(JSON.stringify(valid)).columns).toHaveLength(2);
    expect(parseAnalyzeLlmResponse('```json\n' + JSON.stringify(valid) + '\n```').headerRow).toBe(0);
  });

  it('비JSON·미지 필드는 throw (화이트리스트 밖 값 생성 차단)', () => {
    expect(() => parseAnalyzeLlmResponse('네, 분석했습니다')).toThrow();
    expect(() =>
      parseAnalyzeLlmResponse(JSON.stringify({ ...valid, columns: [{ columnIndex: 0, field: '엉뚱한필드' }] }))
    ).toThrow();
  });
});

describe('analyzeOrderTemplate', () => {
  const FORM = {
    주문서: [
      ['○○브랜드 발주서'],
      [],
      ['받는분', '연락처', '주소', '품목', '수량', '비고'],
      ['예시 고객', '010-0000-0000', '서울시', '샘플 옵션', 1, ''],
    ],
  };

  it('휴리스틱-only (LLM 실패): 드래프트 규칙 + 경고 표면화', async () => {
    const result = await analyzeOrderTemplate(buildXlsx(FORM), { sourceAssetId: 'asset-1' }, FAILING_LLM);

    expect(result.llmUsed).toBe(false);
    expect(result.sheetName).toBe('주문서');
    expect(result.headerRow).toBe(3); // 1-based (타이틀·빈 행 아래)
    expect(result.dataStartRow).toBe(4);
    expect(result.headers).toEqual(['받는분', '연락처', '주소', '품목', '수량', '비고']);

    const byCol = Object.fromEntries(result.columns.map((c) => [c.col, c]));
    expect(byCol[1]).toMatchObject({ suggestedField: '수취인명', source: 'heuristic', confidence: 1 });
    expect(byCol[2]).toMatchObject({ suggestedField: null, source: null }); // 범용어 '연락처'는 휴리스틱 제외
    expect(byCol[3]).toMatchObject({ suggestedField: '배송지', source: 'heuristic' });
    expect(byCol[4]).toMatchObject({ suggestedField: '옵션정보', source: 'heuristic' });
    expect(byCol[5]).toMatchObject({ suggestedField: '수량', source: 'heuristic' });
    expect(byCol[6]).toMatchObject({ suggestedField: null });

    // 드래프트는 항상 스키마 유효 + 미매핑 열은 '비움'
    expect(parseOrderExcelRules(result.draftRules)).not.toBeNull();
    expect(result.draftRules.write).toMatchObject({ mode: 'new-workbook', sheetName: '주문서', headerRow: 3, dataStartRow: 4 });
    expect(result.draftRules.columns[1].source).toEqual({ type: 'empty' });
    expect(result.draftRules.sourceAssetId).toBe('asset-1');
    expect(result.draftRules.templateStoragePath).toBeNull();

    expect(result.warnings.some((w) => w.includes('LLM 열 매핑 추천 실패'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('회신(송장) 파싱 규칙은 기본값'))).toBe(true);
    expect(result.sampleRows[0]).toEqual(['예시 고객', '010-0000-0000', '서울시', '샘플 옵션', '1', '']);
  });

  it('LLM 병합: 휴리스틱 미적중 열만 LLM 추천을 채택하고, 휴리스틱이 항상 우선한다', async () => {
    const fakeLlm = async () => ({
      text: JSON.stringify({
        sheetName: '주문서',
        headerRow: 2,
        dataStartRow: 3,
        columns: [
          { columnIndex: 1, field: '수취인연락처1', confidence: 0.85 }, // 휴리스틱 미적중 → 채택
          { columnIndex: 3, field: '사은품', confidence: 0.9 }, // 휴리스틱('옵션정보')과 충돌 → 무시
          { columnIndex: 99, field: '수량' }, // 범위 밖 → 폐기
        ],
      }),
    });

    const result = await analyzeOrderTemplate(buildXlsx(FORM), { sourceAssetId: null }, fakeLlm);
    expect(result.llmUsed).toBe(true);

    const byCol = Object.fromEntries(result.columns.map((c) => [c.col, c]));
    expect(byCol[2]).toMatchObject({ suggestedField: '수취인연락처1', source: 'llm', confidence: 0.85 });
    expect(byCol[4]).toMatchObject({ suggestedField: '옵션정보', source: 'heuristic' }); // 휴리스틱 우선
    expect(result.draftRules.columns[1].source).toEqual({ type: 'field', field: '수취인연락처1' });
  });

  it('LLM이 비JSON을 반환하면 휴리스틱-only로 폴백하고 경고를 남긴다', async () => {
    const result = await analyzeOrderTemplate(
      buildXlsx(FORM),
      { sourceAssetId: null },
      async () => ({ text: '분석 결과는 다음과 같습니다...' })
    );
    expect(result.llmUsed).toBe(false);
    expect(result.warnings.some((w) => w.includes('LLM 열 매핑 추천 실패'))).toBe(true);
    expect(result.columns.filter((c) => c.suggestedField).length).toBeGreaterThan(0);
  });

  it('중복 필드 추천(수량×2 등)은 경고로 표면화한다', async () => {
    const dupForm = { 발주서: [['수량', '품목', '수량'], [1, 'A', 2]] };
    const result = await analyzeOrderTemplate(buildXlsx(dupForm), { sourceAssetId: null }, FAILING_LLM);
    expect(result.warnings.some((w) => w.includes("'수량' 필드가 2개 열"))).toBe(true);
  });

  it('내용 없는 파일은 명확한 에러', async () => {
    await expect(
      analyzeOrderTemplate(buildXlsx({ Sheet1: [] }), { sourceAssetId: null }, FAILING_LLM)
    ).rejects.toThrow('내용이 있는 시트가 없습니다');
  });
});
