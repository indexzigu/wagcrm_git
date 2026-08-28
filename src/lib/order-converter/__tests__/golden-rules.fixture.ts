import type { OrderExcelRules } from '../excel-rules';

// F4 Phase 2 §7 — 골든 검증된 트리프·뉴트리원 열 매핑 규칙 (테스트 전용 오라클).
//
// 이 두 규칙은 실제 브랜드에 발송돼 정상 수취 확인된 발주서 원본(D7 골든)으로부터
// 역설계·검증됐다. 프로덕션 코드에서는 제거됐고(레거시 폴백 삭제, 2026-07-08) —
// 이제 두 브랜드(뉴트리원·명성/트리프)는 거래처 orderExcelRules로 시드돼 있어 이 규칙이
// 런타임 폴백으로 필요하지 않다. 다만 규칙 "엔진"(applyOrderExcelRules/resolveColumnValue)이
// 이 실양식 레이아웃을 골든 스냅샷과 바이트 동일하게 재현하는지 검증하는 회귀 오라클로
// 남긴다 — excel-generator-parity 스냅샷의 기준값이다. 값은 절대 임의 변경 금지.

/** 트리프 인라인 18열 new-workbook (col2=수취인연락처1 골든 확정). */
export const TRIPP_GOLDEN_RULES: OrderExcelRules = {
  version: 1,
  sourceAssetId: null,
  templateStoragePath: null,
  analyzedAt: '',
  headerSnapshot: [
    '수취인', '전화', '핸드폰', '우편', '주소', '주문인', '전화', '핸드폰', '우편', '주소',
    '수량', '운임구분', '운임비', '품목', '수량', '메시지', '업체명', '주문번호',
  ],
  write: { mode: 'new-workbook', sheetName: '발주서', headerRow: 1, dataStartRow: 2 },
  columns: [
    { col: 1, header: '수취인', source: { type: 'field', field: '수취인명' } },
    { col: 2, header: '전화', source: { type: 'field', field: '수취인연락처1' } },
    { col: 3, header: '핸드폰', source: { type: 'empty' } },
    { col: 4, header: '우편', source: { type: 'field', field: '우편번호' } },
    { col: 5, header: '주소', source: { type: 'field', field: '배송지' } },
    { col: 6, header: '주문인', source: { type: 'empty' } },
    { col: 7, header: '전화', source: { type: 'empty' } },
    { col: 8, header: '핸드폰', source: { type: 'empty' } },
    { col: 9, header: '우편', source: { type: 'empty' } },
    { col: 10, header: '주소', source: { type: 'empty' } },
    { col: 11, header: '수량', source: { type: 'empty' } },
    { col: 12, header: '운임구분', source: { type: 'empty' } },
    { col: 13, header: '운임비', source: { type: 'empty' } },
    { col: 14, header: '품목', source: { type: 'field', field: '옵션정보' } },
    { col: 15, header: '수량', source: { type: 'field', field: '수량', fallbackValue: 1 } },
    { col: 16, header: '메시지', source: { type: 'field', field: '배송메시지' } },
    { col: 17, header: '업체명', source: { type: 'template', template: '와이그라운드({{sellerName}})', fallback: '와이그라운드' } },
    { col: 18, header: '주문번호', source: { type: 'field', field: '상품주문번호' } },
  ],
  reply: {
    orderIdHeaders: ['주문번호', '상품주문번호'],
    orderIdPattern: 'naver-strict',
  },
};

/** 뉴트리원 template-file 채움 18열 (public/nutrione_template.xlsx 실측). */
export const NUTRIONE_GOLDEN_RULES: OrderExcelRules = {
  version: 1,
  sourceAssetId: null,
  templateStoragePath: null,
  analyzedAt: '',
  headerSnapshot: [
    '주문일', '주문번호', '품목별 주문번호', '주문자', '주문자 연락처', '수령자', '수령자 연락처',
    '우편번호', '주소', '옵션명', '수량', '배송비', '배송메세지', '사은품', '', '상품코드', '검증', '공구판매가',
  ],
  write: { mode: 'fill-template', sheetName: '발주서', headerRow: 1, dataStartRow: 2, codeSheet: { enabled: true } },
  columns: [
    { col: 1, header: '주문일', source: { type: 'field', field: '주문일' } },
    { col: 2, header: '주문번호', source: { type: 'field', field: '상품주문번호' } },
    { col: 3, header: '품목별 주문번호', source: { type: 'field', field: '상품주문번호' } },
    { col: 4, header: '주문자', source: { type: 'field', field: '구매자명', fallbackField: '수취인명' } },
    { col: 5, header: '주문자 연락처', source: { type: 'field', field: '구매자연락처', fallbackField: '수취인연락처1' } },
    { col: 6, header: '수령자', source: { type: 'field', field: '수취인명' } },
    { col: 7, header: '수령자 연락처', source: { type: 'field', field: '수취인연락처1' } },
    { col: 8, header: '우편번호', source: { type: 'field', field: '우편번호' } },
    { col: 9, header: '주소', source: { type: 'field', field: '배송지' } },
    { col: 10, header: '옵션명', source: { type: 'field', field: '옵션정보' } },
    { col: 11, header: '수량', source: { type: 'field', field: '수량', fallbackValue: 1 } },
    { col: 12, header: '배송비', source: { type: 'field', field: '배송비', transform: 'currency-krw' } },
    { col: 13, header: '배송메세지', source: { type: 'field', field: '배송메시지' } },
    { col: 14, header: '사은품', source: { type: 'field', field: '사은품' } },
    { col: 15, header: '', source: { type: 'empty' } },
    { col: 16, header: '상품코드', source: { type: 'field', field: '상품코드', guard: 'productCodeMapped' } },
    { col: 17, header: '검증', source: { type: 'field', field: '검증', fallbackValue: 'TRUE(API)', guard: 'productCodeMapped' } },
    { col: 18, header: '공구판매가', source: { type: 'field', field: '공구판매가', fallbackValue: 0, guard: 'productCodeMapped' } },
  ],
  reply: {
    orderIdHeaders: ['주문번호', '품목별주문번호', '상품주문번호'],
    orderIdPattern: 'lenient',
  },
};
