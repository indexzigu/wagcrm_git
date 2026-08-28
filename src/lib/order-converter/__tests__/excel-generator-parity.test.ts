/**
 * F4 Phase 2 무손실 패리티 증명 (설계 §4·D7 보조지표).
 *
 * fixtures/*.snapshot.json은 generateOrderExcelBuffer 출력의 셀 단위(값·수식) 스냅샷이다.
 * 기준선: 규칙 경로 도입 직전 동작 + VLOOKUP 폴백 소실 결함 수정(소유자 승인, 2026-07-07).
 * 이 테스트가 깨지면 리팩토링이 발주서 산출물을 바꿨다는 뜻 — 발주서는 브랜드사에
 * 발송되는 운영 문서이므로 의도된 변경이라도 픽스처 재생성 전에 소유자 확인을 거칠 것.
 * (실물 정합의 1차 기준은 골든 파일 검증 — 이 스냅샷은 회귀 가드다.)
 *
 * §7(2026-07-08) 레거시 폴백 제거 후: 트리프·뉴트리원은 프로덕션에서 거래처 orderExcelRules로
 * 시드돼 있어, 여기서는 그 골든 규칙(golden-rules.fixture)을 excelRules로 명시 주입해 엔진이
 * 실양식 레이아웃을 스냅샷과 바이트 동일하게 재현하는지 검증한다. 뉴트리원 fill-template은
 * 템플릿 바이트를 fixtures/nutrione_template.xlsx(구 public/)에서 templateBuffer로 공급한다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { generateOrderExcelBuffer } from '../excel-generator';
import { DEFAULT_NEW_WORKBOOK_RULES, type OrderExcelRules } from '../excel-rules';
import { NUTRIONE_GOLDEN_RULES, TRIPP_GOLDEN_RULES } from './golden-rules.fixture';
import {
  FIXTURE_MAPPINGS,
  FIXTURE_ORDERS,
  FIXTURE_SELLER_NAME,
  snapshotWorkbook,
  type WorkbookSnapshot,
} from './excel-fixture-data';

function loadSnapshot(name: string): WorkbookSnapshot {
  return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

// 뉴트리원 fill-template 템플릿 바이트 — 프로덕션은 거래처 스냅샷(Supabase)에서 로드하지만
// 테스트는 골든 오라클로 이 고정 바이트를 사용한다(구 public/nutrione_template.xlsx).
const NUTRIONE_TEMPLATE = readFileSync(path.join(__dirname, 'fixtures', 'nutrione_template.xlsx'));

function genNutrione(orders: typeof FIXTURE_ORDERS) {
  return generateOrderExcelBuffer({
    orders,
    templateId: 'nutrione',
    sellerName: FIXTURE_SELLER_NAME,
    mappings: FIXTURE_MAPPINGS,
    excelRules: NUTRIONE_GOLDEN_RULES,
    templateBuffer: NUTRIONE_TEMPLATE,
  });
}

describe('규칙 경로 == 골든 스냅샷 (셀 단위)', () => {
  it('트리프: excelRules=TRIPP_GOLDEN_RULES == 스냅샷 (규칙 표현 무손실)', async () => {
    const buffer = await generateOrderExcelBuffer({
      orders: FIXTURE_ORDERS,
      templateId: 'ignored-when-rules-given',
      sellerName: FIXTURE_SELLER_NAME,
      mappings: FIXTURE_MAPPINGS,
      excelRules: TRIPP_GOLDEN_RULES,
    });
    expect(await snapshotWorkbook(buffer)).toEqual(loadSnapshot('excel-legacy-tripp.snapshot.json'));
  });

  it('뉴트리원: excelRules=NUTRIONE_GOLDEN_RULES + templateBuffer == 스냅샷 (규칙 표현 무손실)', async () => {
    const buffer = await genNutrione(FIXTURE_ORDERS);
    expect(await snapshotWorkbook(buffer)).toEqual(loadSnapshot('excel-legacy-nutrione.snapshot.json'));
  });
});

describe('fill-template 수식 보존 (VLOOKUP 폴백 소실 결함 수정, 2026-07-07)', () => {
  it('첫 행이 매핑 성공이어도 이후 매핑 실패 행은 VLOOKUP 폴백을 유지한다', async () => {
    // FIXTURE_ORDERS: o1(행2, guard true) → o2(행3)·o3(행4, guard false)
    const buffer = await genNutrione(FIXTURE_ORDERS);
    const sheet = (await snapshotWorkbook(buffer))['발주서'];
    // 행2(o1): guard true → 값 덮어쓰기
    expect(sheet['P2']).toEqual({ v: 'ABC12345' });
    // 행3(o2, 매핑 실패)·행4(o3, 검증 FALSE): 템플릿 VLOOKUP이 행 번호 shift되어 보존
    expect(sheet['P3']?.f).toBe("VLOOKUP(J3,'코드'!B:C,2,FALSE)");
    expect(sheet['Q3']?.f).toBe("VLOOKUP(J3,'코드'!B:B,1,FALSE)=J3");
    expect(sheet['R3']?.f).toBe("VLOOKUP(J3,'코드'!B:D,3,0)");
    expect(sheet['P4']?.f).toBe("VLOOKUP(J4,'코드'!B:C,2,FALSE)");
  });

  it('총판매가(S열) 수식이 전 데이터 행에 존재한다', async () => {
    const buffer = await genNutrione(FIXTURE_ORDERS);
    const sheet = (await snapshotWorkbook(buffer))['발주서'];
    for (let r = 2; r <= 6; r++) {
      expect(sheet[`S${r}`]?.f, `S${r}`).toBe(`K${r}*R${r}`);
    }
  });

  it('첫 행이 매핑 실패면 참조행(행2) 자체의 VLOOKUP이 보존된다', async () => {
    const reordered = [FIXTURE_ORDERS[1], FIXTURE_ORDERS[0]]; // o2(실패) 먼저, o1(성공) 다음
    const buffer = await genNutrione(reordered);
    const sheet = (await snapshotWorkbook(buffer))['발주서'];
    expect(sheet['P2']?.f).toBe("VLOOKUP(J2,'코드'!B:C,2,FALSE)");
    expect(sheet['P3']).toEqual({ v: 'ABC12345' }); // guard true 행은 값
  });
});

describe('신규 브랜드 new-workbook 규칙 (제로코드 경로)', () => {
  const CUSTOM_RULES: OrderExcelRules = {
    version: 1,
    sourceAssetId: 'asset-1',
    templateStoragePath: null,
    analyzedAt: '2026-07-07T00:00:00.000Z',
    headerSnapshot: ['받는분', '연락처', '운임', '브랜드코드', '발주처'],
    write: { mode: 'new-workbook', sheetName: '주문서', headerRow: 1, dataStartRow: 2 },
    columns: [
      { col: 1, header: '받는분', source: { type: 'field', field: '수취인명' } },
      { col: 2, header: '연락처', source: { type: 'field', field: '수취인연락처1' } },
      { col: 3, header: '운임', source: { type: 'field', field: '배송비', transform: 'currency-krw' } },
      { col: 4, header: '브랜드코드', source: { type: 'field', field: '상품코드', guard: 'productCodeMapped' } },
      { col: 5, header: '발주처', source: { type: 'template', template: 'WAG-{{sellerName}}', fallback: 'WAG' } },
    ],
    reply: { orderIdHeaders: ['주문번호'], orderIdPattern: 'lenient' },
  };

  it('시트명·헤더·guard 생략·통화 서식이 규칙대로 반영된다', async () => {
    const buffer = await generateOrderExcelBuffer({
      orders: FIXTURE_ORDERS.slice(0, 2), // o1(guard true) + o2(매핑 실패, guard false)
      templateId: 'whatever',
      sellerName: FIXTURE_SELLER_NAME,
      excelRules: CUSTOM_RULES,
    });
    const snap = await snapshotWorkbook(buffer);
    expect(Object.keys(snap)).toEqual(['주문서']);
    const sheet = snap['주문서'];
    expect(sheet['A1']?.v).toBe('받는분');
    expect(sheet['E1']?.v).toBe('발주처');
    // o1(행2): 전체 기입
    expect(sheet['A2']?.v).toBe('김주문');
    expect(sheet['C2']?.v).toBe('\\3,000');
    expect(sheet['D2']?.v).toBe('ABC12345');
    expect(sheet['E2']?.v).toBe('WAG-김본명');
    // o2(행3): guard false → D3 미기입(셀 부재)
    expect(sheet['A3']?.v).toBe('박받아');
    expect(sheet['D3']).toBeUndefined();
  });
});

describe('excelRules 미지정 → 표준 발주서 폴백 (버그 회귀 가드: 명성/보바 CUID slug)', () => {
  // 재현: (주)명성(slug=CUID, excelRules 미시드)이 발주서 생성 시 없는
  // public/{CUID}_template.xlsx를 찾아 "템플릿 파일을 찾을 수 없습니다"로 실패했었다.
  // 이제 excelRules 미지정이면 DEFAULT_NEW_WORKBOOK_RULES(new-workbook)로 폴백한다.
  it('excelRules 없음 → 에러 없이 표준 발주서(new-workbook) 생성', async () => {
    const buffer = await generateOrderExcelBuffer({
      orders: FIXTURE_ORDERS.slice(0, 2),
      templateId: 'cmphbjvq90002qegvogggiuct', // 명성/보바 실 slug — 대응 템플릿 파일 없음
      sellerName: FIXTURE_SELLER_NAME,
    });
    const snap = await snapshotWorkbook(buffer);
    expect(Object.keys(snap)).toEqual(['발주서']); // '코드' 시트 없음(fill-template 아님)
    const sheet = snap['발주서'];
    // 헤더: 표준 발주서 10열 (DEFAULT_NEW_WORKBOOK_RULES)
    expect(sheet['A1']?.v).toBe('주문일');
    expect(sheet['B1']?.v).toBe('주문번호');
    expect(sheet['C1']?.v).toBe('수취인명');
    expect(sheet['J1']?.v).toBe('업체명');
    // o1(행2): 수취인명·업체명 기입
    expect(sheet['C2']?.v).toBe('김주문');
    expect(sheet['J2']?.v).toBe('와이그라운드(김본명)');
  });

  it('DEFAULT_NEW_WORKBOOK_RULES가 폴백 규칙이다', () => {
    expect(DEFAULT_NEW_WORKBOOK_RULES.write.mode).toBe('new-workbook');
    expect(DEFAULT_NEW_WORKBOOK_RULES.columns).toHaveLength(10);
  });
});

describe('수량 ≠ 1 빨간 글자 강조 (휴먼에러 게이트, 모든 양식)', () => {
  // 픽스처 수량: o1=2·o5=3(강조), o2=1·o3=1·o4=0→폴백1(기본색)
  async function loadSheet(buffer: Buffer, name: string) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    return wb.getWorksheet(name)!;
  }

  it('트리프(수량=col15/O): 2·3개 행만 빨강, 1·0(폴백1) 행은 기본색', async () => {
    const buffer = await generateOrderExcelBuffer({
      orders: FIXTURE_ORDERS,
      templateId: 'ignored-when-rules-given',
      sellerName: FIXTURE_SELLER_NAME,
      mappings: FIXTURE_MAPPINGS,
      excelRules: TRIPP_GOLDEN_RULES,
    });
    const sheet = await loadSheet(buffer, '발주서');
    const argb = (addr: string) => sheet.getCell(addr).font?.color?.argb;
    expect(sheet.getCell('O2').value).toBe(2); // o1
    expect(argb('O2')).toBe('FFFF0000');
    expect(sheet.getCell('O6').value).toBe(3); // o5
    expect(argb('O6')).toBe('FFFF0000');
    expect(sheet.getCell('O3').value).toBe(1); // o2
    expect(argb('O3')).toBeUndefined();
    expect(sheet.getCell('O5').value).toBe(1); // o4: 수량 0 → fallbackValue 1
    expect(argb('O5')).toBeUndefined();
  });

  it('표준 발주서(수량=col8/H): 다량 행만 빨강 (신규 브랜드 경로)', async () => {
    const buffer = await generateOrderExcelBuffer({
      orders: FIXTURE_ORDERS.slice(0, 2), // o1(2)·o2(1)
      templateId: 'cmphbjvq90002qegvogggiuct', // excelRules 미지정 → DEFAULT_NEW_WORKBOOK_RULES
      sellerName: FIXTURE_SELLER_NAME,
    });
    const sheet = await loadSheet(buffer, '발주서');
    const argb = (addr: string) => sheet.getCell(addr).font?.color?.argb;
    expect(sheet.getCell('H2').value).toBe(2); // o1
    expect(argb('H2')).toBe('FFFF0000');
    expect(sheet.getCell('H3').value).toBe(1); // o2
    expect(argb('H3')).toBeUndefined();
  });

  it('뉴트리원 fill-template(수량=col11/K): 다량 행만 빨강, 기존 템플릿 폰트 보존', async () => {
    const buffer = await genNutrione(FIXTURE_ORDERS);
    const sheet = await loadSheet(buffer, '발주서');
    const argb = (addr: string) => sheet.getCell(addr).font?.color?.argb;
    expect(sheet.getCell('K2').value).toBe(2); // o1 → 빨강
    expect(argb('K2')).toBe('FFFF0000');
    expect(sheet.getCell('K6').value).toBe(3); // o5 → 빨강
    expect(argb('K6')).toBe('FFFF0000');
    expect(sheet.getCell('K3').value).toBe(1); // o2 → 기본색(빨강 아님)
    expect(argb('K3')).not.toBe('FFFF0000');
  });
});
