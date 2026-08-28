/**
 * F4 Phase 2 열 매핑 엔진 — 패리티 픽스처 공용 데이터/직렬화.
 *
 * 합성 주문 5건은 검수 UI가 놓치기 쉬운 엣지를 강제로 포함한다
 * (플랜 비평 반영: 구매자≠수취인 선물 주문·연락처2·수량 0·배송비 문자열·
 * 매핑 실패/검증 FALSE/검증 미기재 — guard 3분기 전부).
 * 실주문 PII는 절대 넣지 않는다 — 골든 파일은 레포 밖(소유자 보관).
 */
import ExcelJS from 'exceljs';
import type { OrderData } from '../excel-generator';

export const FIXTURE_SELLER_NAME = '김본명';

export const FIXTURE_ORDERS: OrderData[] = [
  {
    // o1: 정상 주문(구매자==수취인), 매핑 성공, 배송비 문자열 정제 대상
    주문일: '2026-07-05 10:12',
    상품주문번호: '2026070512345671',
    구매자명: '김주문',
    구매자연락처: '010-1111-2222',
    수취인명: '김주문',
    수취인연락처1: '010-1111-2222',
    우편번호: '06236',
    배송지: '서울시 강남구 테헤란로 1 101동 202호',
    옵션정보: '포켓몬 비타민C 1박스',
    수량: 2,
    배송비: '3,000원',
    배송메시지: '문 앞에 놓아주세요',
    사은품: '체험분 1포',
    상품코드: 'ABC12345',
    검증: 'TRUE',
    공구판매가: 12900,
  },
  {
    // o2: 선물 주문(구매자≠수취인), 연락처2 존재, 매핑 실패 → guard false
    주문일: '2026-07-05 11:00',
    상품주문번호: '2026070512345672',
    구매자명: '이보내',
    구매자연락처: '010-3333-4444',
    수취인명: '박받아',
    수취인연락처1: '010-5555-6666',
    수취인연락처2: '02-777-8888',
    우편번호: '48058',
    배송지: '부산시 해운대구 달맞이길 9',
    옵션정보: '미등록 옵션 세트',
    수량: 1,
    배송비: 0,
    배송메시지: '',
    사은품: '',
    상품코드: '',
    검증: '매핑 실패',
    공구판매가: 0,
  },
  {
    // o3: 상품코드는 있으나 검증 FALSE → guard false (수식 보존 분기)
    주문일: '2026-07-06 09:30',
    상품주문번호: '2026070612345673',
    구매자명: '최검증',
    구매자연락처: '010-9999-0000',
    수취인명: '최검증',
    수취인연락처1: '010-9999-0000',
    우편번호: '13529',
    배송지: '성남시 분당구 판교로 256',
    옵션정보: '포켓몬 비타민C 2박스',
    수량: 1,
    배송비: '무료',
    배송메시지: '경비실 위탁',
    사은품: '',
    상품코드: 'ABC12345',
    검증: 'FALSE (네이버: 1000원 != 계산: 2000원)',
    공구판매가: 25800,
  },
  {
    // o4: 구매자 정보 빈값(fallback 수취인) + 수량 0(||1) + 주문일 빈값
    주문일: '',
    상품주문번호: '2026070612345674',
    구매자명: '',
    구매자연락처: '',
    수취인명: '한수취',
    수취인연락처1: '010-1212-3434',
    우편번호: '',
    배송지: '대전시 유성구 대학로 99',
    옵션정보: '포켓몬 비타민C 1박스',
    수량: 0,
    배송비: '2500',
    배송메시지: '',
    사은품: '',
    상품코드: 'ABC12345',
    검증: 'TRUE',
    공구판매가: 12900,
  },
  {
    // o5: 검증/공구판매가 미기재 + 상품코드 존재 → guard true, fallback('TRUE(API)', 0)
    주문일: '2026-07-07 08:01',
    상품주문번호: '2026070712345675',
    구매자명: '정직진',
    구매자연락처: '010-2468-1357',
    수취인명: '정직진',
    수취인연락처1: '010-2468-1357',
    우편번호: '21999',
    배송지: '인천시 연수구 송도동 123-4',
    옵션정보: '포켓몬 비타민C 3박스',
    수량: 3,
    배송비: '3000',
    배송메시지: '부재 시 전화',
    사은품: '',
    상품코드: 'XYZ99999',
  },
];

// '코드' 시트 재생성 검증용 — 빈 상품명 + 유사 옵션(내리채우기 O)/이질 옵션(내리채우기 X) 포함
export const FIXTURE_MAPPINGS = [
  { productName: '포켓몬 비타민C', optionName: '포켓몬 비타민C 1박스', brandCode: 'ABC12345', price: 12900 },
  { productName: '', optionName: '포켓몬 비타민C 2박스', brandCode: 'ABC22345', price: 25800 },
  { productName: '', optionName: '전혀 다른 무언가', brandCode: 'ZZZ00001', price: 100 },
];

export type SheetCellMap = Record<string, { v?: unknown; f?: string; sf?: string }>;
export type WorkbookSnapshot = Record<string, SheetCellMap>;

/**
 * 생성된 xlsx 버퍼 → {시트명: {셀주소: {값, 수식}}} 스냅샷. 값·수식만 비교(스타일 제외).
 * ExcelJS로 읽는다 — SheetJS는 캐시값 없는 수식 셀(<f>만 있는 셀)을 떨어뜨려
 * VLOOKUP 폴백·총판매가 수식의 회귀를 잡을 수 없다(2026-07-07 리더 교체).
 */
export async function snapshotWorkbook(buffer: Buffer | ArrayBuffer): Promise<WorkbookSnapshot> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const out: WorkbookSnapshot = {};
  wb.eachSheet((sheet) => {
    const cells: SheetCellMap = {};
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.type === ExcelJS.ValueType.Null) return; // 스타일만 있는 셀 제외
        const entry: SheetCellMap[string] = {};
        if (cell.type === ExcelJS.ValueType.Formula) {
          const value = cell.value as ExcelJS.CellFormulaValue & { sharedFormula?: string };
          if (value?.formula) entry.f = value.formula;
          else if (value?.sharedFormula) entry.sf = value.sharedFormula;
          if (value?.result !== undefined) entry.v = value.result;
        } else {
          entry.v = cell.value;
        }
        cells[cell.address] = entry;
      });
    });
    out[sheet.name] = cells;
  });
  return out;
}
