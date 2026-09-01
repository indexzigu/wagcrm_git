import * as XLSX from 'xlsx';
import { NAVER_ORDER_ID_PATTERN } from './naver-order-id';
import { normalizeForCompare, toNfc } from '@/lib/text-normalize';

// Excel 날짜 시리얼 및 문자열 날짜를 안전하게 Date 객체로 파싱하는 헬퍼
function parseExcelDate(val: any): Date | null {
  if (val === undefined || val === null || val === '') return null;

  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val;
  }

  const num = Number(val);
  if (!isNaN(num) && num > 0) {
    // 엑셀 날짜 시리얼 값을 UTC 기준으로 밀리초 변환 (25569일 차이)
    const ms = Math.round((num - 25569) * 86400 * 1000);
    const utcDate = new Date(ms);
    
    // 시리얼 날짜에 명시된 시각이 로컬 시각을 의미하므로, UTC 컴포넌트를 그대로 로컬 시간대로 매핑
    return new Date(
      utcDate.getUTCFullYear(),
      utcDate.getUTCMonth(),
      utcDate.getUTCDate(),
      utcDate.getUTCHours(),
      utcDate.getUTCMinutes(),
      utcDate.getUTCSeconds()
    );
  }

  const str = String(val).trim();
  // YYYY-MM-DD HH:mm:ss 또는 YYYY.MM.DD HH:mm 등 날짜 정규식 매칭
  const dateMatch = str.match(/(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})(?:\s+(\d{1,2})[:\.](\d{1,2})(?::(\d{1,2}))?)?/);
  if (dateMatch) {
    const yyyy = parseInt(dateMatch[1], 10);
    const mm = parseInt(dateMatch[2], 10) - 1;
    const dd = parseInt(dateMatch[3], 10);
    const hh = dateMatch[4] ? parseInt(dateMatch[4], 10) : 0;
    const min = dateMatch[5] ? parseInt(dateMatch[5], 10) : 0;
    const sec = dateMatch[6] ? parseInt(dateMatch[6], 10) : 0;
    return new Date(yyyy, mm, dd, hh, min, sec);
  }

  const parsed = Date.parse(str);
  if (!isNaN(parsed)) {
    return new Date(parsed);
  }

  return null;
}

// 날짜 객체를 지정된 포맷 문자열로 변환
function formatDate(date: Date, format: string): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');

  return format
    .replace('YYYY', String(yyyy))
    .replace('MM', mm)
    .replace('DD', dd)
    .replace('HH', hh)
    .replace('mm', min)
    .replace('ss', ss);
}

export interface ProductMapping {
  상품명: string;
  옵션명: string;
  상품코드: string;
  공구판매가: number;
}

export interface NaverOrderRow {
  주문번호: string;
  상품주문번호: string;
  구매자명: string;
  구매자연락처: string;
  상품명: string;
  옵션정보: string;
  수량: number;
  수취인명: string;
  수취인연락처1: string;
  수취인연락처2: string;
  배송지: string;
  배송메시지: string;
  우편번호: string;
  주문일시: string;
  결제일: string;
  배송비: string;
  총결제금액: number;
  판매자관리코드?: string;
}

export interface BrandOrderRow extends NaverOrderRow {
  검증: string;
  상품코드?: string;
  공구판매가?: number;
  주문일?: string; // 변환된 포맷
  [key: string]: any; // 사은품 등 동적 열 허용
}

export function applyGifts(orders: BrandOrderRow[], type: 'random' | 'first-come', count: number, giftName: string, targetColumn: string = '사은품'): BrandOrderRow[] {
  if (count <= 0 || !giftName) return orders;

  const uniqueBuyers = Array.from(new Set(orders.map(o => o.구매자연락처)));
  let selectedBuyers: string[] = [];

  if (type === 'first-come') {
    const sortedByDate = [...orders].sort((a, b) => {
      const dateA = new Date(a.주문일시).getTime();
      const dateB = new Date(b.주문일시).getTime();
      if (isNaN(dateA)) return 1;
      if (isNaN(dateB)) return -1;
      return dateA - dateB;
    });
    
    for (const order of sortedByDate) {
      if (!selectedBuyers.includes(order.구매자연락처)) {
        selectedBuyers.push(order.구매자연락처);
      }
      if (selectedBuyers.length >= count) break;
    }
  } else {
    const shuffled = [...uniqueBuyers].sort(() => 0.5 - Math.random());
    selectedBuyers = shuffled.slice(0, count);
  }

  const giftedSet = new Set<string>();

  return orders.map(order => {
    let finalGift = '';
    if (selectedBuyers.includes(order.구매자연락처) && !giftedSet.has(order.구매자연락처)) {
      finalGift = giftName;
      giftedSet.add(order.구매자연락처);
    }
    return { ...order, [targetColumn]: finalGift };
  });
}

export interface NaverDeliveryRow {
  상품주문번호: string;
  배송방법: string;
  택배사: string;
  송장번호: string;
  [key: string]: any;
}

export function parseNaverOrders(arrayBuffer: ArrayBuffer): NaverOrderRow[] {
  let workbook;
  try {
    workbook = XLSX.read(arrayBuffer, { type: 'array' });
  } catch (error: any) {
    if (error.message?.includes('password-protected')) {
      throw new Error('선택하신 엑셀 파일에 암호가 설정되어 있어 내용을 읽을 수 없습니다.');
    }
    throw error;
  }
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  const rawData = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, defval: "" });
  if (rawData.length === 0) return [];

  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(rawData.length, 10); i++) {
    const row = rawData[i];
    if (row && (row.includes('상품주문번호') || row.includes('주문번호'))) {
      headerRowIndex = i;
      break;
    }
  }

  const headers = rawData[headerRowIndex] || [];
  const parsedRows: NaverOrderRow[] = [];

  for (let i = headerRowIndex + 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || !Array.isArray(row) || row.length === 0 || !row.some(Boolean)) continue;

    const rowData: Record<string, any> = {};
    headers.forEach((header: string, index: number) => {
      // 🔴 헤더 키도 NFC 로 맞춘다 — 자모 분리로 들어오면 아래 `rowData['주문번호']` 류가
      //    전부 빗나가 조용히 빈 행이 된다(회신 엑셀 헤더와 같은 축).
      const cleanHeader = header ? toNfc(String(header).replace(/\n|\r/g, '')).trim() : '';
      if (cleanHeader) {
        rowData[cleanHeader] = row[index];
      }
    });

    parsedRows.push({
      주문번호: String(rowData['주문번호'] || ''),
      상품주문번호: String(rowData['상품주문번호'] || ''),
      구매자명: String(rowData['구매자명'] || rowData['주문자명'] || rowData['주문자'] || ''),
      구매자연락처: String(rowData['구매자연락처'] || rowData['주문자 연락처'] || ''),
      상품명: String(rowData['상품명'] || ''),
      옵션정보: String(rowData['옵션정보'] || rowData['옵션명'] || ''),
      수량: Number(rowData['수량']) || 0,
      수취인명: String(rowData['수취인명'] || rowData['받는사람'] || ''),
      수취인연락처1: String(rowData['수취인연락처1'] || rowData['연락처1'] || ''),
      수취인연락처2: String(rowData['수취인연락처2'] || rowData['연락처2'] || ''),
      배송지: String(
        (rowData['통합배송지'] || rowData['기본배송지'] || rowData['배송지'] || rowData['수취인 주소'] || rowData['주소'] || '') + 
        (rowData['상세배송지'] ? ' ' + rowData['상세배송지'] : '')
      ).trim(),
      배송메시지: String(rowData['배송메시지'] || rowData['배송메세지'] || ''),
      우편번호: String(rowData['우편번호'] || ''),
      주문일시: String(rowData['주문일시'] || rowData['결제일'] || ''),
      결제일: String(rowData['결제일'] || rowData['주문일시'] || ''),
      배송비: String(rowData['배송비 합계'] || rowData['배송비합계'] || rowData['배송비'] || '0'),
      총결제금액: Number(String(rowData['최종 상품별 총 주문금액'] || rowData['상품별 총 주문금액'] || rowData['총결제금액'] || '0').replace(/[^0-9]/g, '')) || 0
    });
  }

  return parsedRows;
}

export function transformToBrandOrders(naverOrders: NaverOrderRow[], mappings: ProductMapping[]): BrandOrderRow[] {
  return naverOrders.map(order => {
    // 1순위: 네이버 판매자관리코드(옵션코드) 우선 확인
    const storeCode = order.판매자관리코드?.trim();
    let finalCode = '';
    let finalPrice = 0;
    let verificationResult = '매핑 실패';
    
    // 2순위: 옵션명 기반 매핑표 대조
    const matched = mappings.find(m => order.옵션정보.includes(m.옵션명) || m.옵션명.includes(order.옵션정보));

    if (storeCode) {
      finalCode = storeCode;
      verificationResult = 'API 직접 매핑 (옵션코드)';
      // 스토어 코드 우선 시 가격은 매핑표에 있으면 쓰고, 없으면 0으로 처리 (보통 수식에서 알아서 계산됨)
      if (matched && matched.상품코드 === storeCode) {
        finalPrice = matched.공구판매가;
      }
    } else if (matched) {
      finalCode = matched.상품코드;
      finalPrice = matched.공구판매가;
    }

    // 2. 주문일 포맷팅 (YYYY-MM-DD)
    const dateObj = parseExcelDate(order.주문일시);
    const formattedDate = dateObj ? formatDate(dateObj, 'YYYY-MM-DD') : order.주문일시;

    // 가격 검증 로직 (매핑표를 탔고 가격이 세팅된 경우)
    if (!storeCode && matched && matched.공구판매가 >= 0) {
      const totalSalesPrice = matched.공구판매가 * order.수량;
      if (order.총결제금액 === totalSalesPrice) {
        verificationResult = 'TRUE';
      } else {
        verificationResult = `FALSE (네이버: ${order.총결제금액}원 != 계산: ${totalSalesPrice}원)`;
      }
    }

    return {
      ...order,
      주문일: formattedDate,
      상품코드: finalCode,
      공구판매가: finalPrice,
      검증: verificationResult
    };
  });
}

export interface TrackingData {
  택배사: string;
  송장번호: string;
}

const DEFAULT_TRACKING_HEADERS = ['송장번호', '운송장번호', '운송장', '택배송장번호'];

/**
 * F4 Phase 2 §5단계 — 회신(송장) 파싱의 단일 코어. 브랜드별 분기를 reply 규칙으로 표현한다.
 * (설계 D6: 클라이언트 하드코딩 분기를 서버에서 규칙 기반으로 실행)
 * - trackingHeaders: 송장 컬럼 후보(공백 제거 후 매칭). 미지정 시 기본값.
 * - orderIdHeaders: 주문번호 컬럼 후보(공백 제거 후 매칭).
 * - orderIdPattern: 'naver-strict'면 위 패턴을 통과하는 값만 유효(트리프 이벤트행 배제).
 */
export function extractTrackingMapByReply(
  arrayBuffer: ArrayBuffer,
  reply: { orderIdHeaders: string[]; orderIdPattern: 'naver-strict' | 'lenient'; trackingHeaders?: string[] }
): Record<string, TrackingData> {
  let workbook;
  try {
    workbook = XLSX.read(arrayBuffer, { type: 'array' });
  } catch (error: any) {
    if (error.message?.includes('password-protected')) {
      throw new Error('선택하신 엑셀 파일에 암호가 설정되어 있어 내용을 읽을 수 없습니다.');
    }
    throw error;
  }

  // 규칙 헤더도 원본 셀 키와 동일하게 공백 제거해 비교한다(cleanRow 규약).
  // 🔴 정규화 정본은 `src/lib/text-normalize.ts` 다 — 여기서 단계를 다시 적지 말 것.
  //    브랜드사가 맥에서 만든 엑셀은 한글이 **자모 분리(NFD)** 로 들어와, `송장번호` 가
  //    눈에는 같은데 우리 상수와 안 맞아 **조용히 0건**이 되고 화면에는 「송장번호를 찾지
  //    못했습니다」로 떠 회신이 없는 것과 구분되지 않는다(2026-09-02 실증).
  const normalize = normalizeForCompare;
  const trackingKeys = (reply.trackingHeaders?.length ? reply.trackingHeaders : DEFAULT_TRACKING_HEADERS).map(normalize);
  const orderIdKeys = reply.orderIdHeaders.map(normalize);
  const strict = reply.orderIdPattern === 'naver-strict';

  const firstNonEmpty = (row: Record<string, any>, keys: string[]): string => {
    for (const key of keys) {
      const v = row[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };

  const trackingMap: Record<string, TrackingData> = {};

  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json<any>(worksheet, { defval: '', raw: false });

    jsonData.forEach(row => {
      const cleanRow: Record<string, any> = {};
      for (const k in row) {
        cleanRow[normalize(k)] = row[k];
      }

      const trackingNum = firstNonEmpty(cleanRow, trackingKeys);

      let orderId = firstNonEmpty(cleanRow, orderIdKeys);
      if (strict && !NAVER_ORDER_ID_PATTERN.test(orderId)) {
        orderId = '';
      }

      let courier = String(cleanRow[normalize('택배사')] || '').trim() || 'CJ대한통운';
      // 🔴 **셀 값도 헤더와 같은 축이다.** 헤더만 정규화하면 NFD 로 들어온 `CJ택배` 가
      //    그대로 남아 표기가 갈린다(발주서·송장 조회에서 다른 택배사로 읽힌다).
      //    교차 검증이 「같은 함수에 남은 같은 결함」으로 짚은 자리다(2026-09-02).
      if (normalizeForCompare(courier) === normalizeForCompare('CJ택배')) {
        courier = 'CJ대한통운';
      }

      if (trackingNum && orderId) {
        trackingMap[orderId] = { 택배사: courier, 송장번호: trackingNum };
      }
    });
  });

  return trackingMap;
}

/**
 * 레거시 시그니처 — templateId/formatAdapter로 reply 규칙을 유추해 코어에 위임한다.
 * (기존 테스트·비-브랜드 호출 호환. 신규 경로는 resolveReplyRule(brand)를 쓴다.)
 */
export function extractTrackingMap(
  arrayBuffer: ArrayBuffer,
  templateId: string = 'nutrione',
  formatAdapter?: 'template-file' | 'tripp'
): Record<string, TrackingData> {
  const isTripp = formatAdapter ? formatAdapter === 'tripp' : templateId === 'tripp';
  const reply = isTripp
    ? { orderIdHeaders: ['주문번호', '상품주문번호'], orderIdPattern: 'naver-strict' as const }
    : { orderIdHeaders: ['주문번호', '품목별주문번호', '상품주문번호'], orderIdPattern: 'lenient' as const };
  return extractTrackingMapByReply(arrayBuffer, reply);
}

export function mergeTrackingIntoNaverRaw(naverRawBuffer: ArrayBuffer, trackingMap: Record<string, TrackingData>): ArrayBuffer {
  let workbook;
  try {
    workbook = XLSX.read(naverRawBuffer, { type: 'array' });
  } catch (error: any) {
    if (error.message?.includes('password-protected')) {
      throw new Error('선택하신 엑셀 파일에 암호가 설정되어 있어 내용을 읽을 수 없습니다.');
    }
    throw error;
  }
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  const rawData = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, defval: "" });
  if (rawData.length === 0) return new ArrayBuffer(0);

  const firstRow = rawData[0];
  if (firstRow && firstRow.length > 0 && typeof firstRow[0] === 'string' && firstRow[0].includes('◈')) {
    rawData.shift();
  }

  const headers = rawData[0] || [];
  // 🔴 NFC 를 함께 건다 — 없으면 자모 분리 헤더에서 아래 인덱스가 전부 -1 로 남아
  //    송장 병합이 **조용히 아무것도 안 한다**(회신 엑셀 헤더와 같은 축).
  const cleanHeader = (h: any) => (h ? toNfc(String(h).replace(/\s+/g, '')) : '');

  let orderIdIdx = -1;
  let courierIdx = -1;
  let trackingNumIdx = -1;
  let orderDateIdx = -1;
  let payDateIdx = -1;
  let deliveryMethodIdx = -1;

  headers.forEach((h, idx) => {
    const cleaned = cleanHeader(h);
    if (cleaned === '상품주문번호') orderIdIdx = idx;
    if (cleaned === '택배사') courierIdx = idx;
    if (cleaned === '송장번호') trackingNumIdx = idx;
    if (cleaned === '주문일시') orderDateIdx = idx;
    if (cleaned === '결제일') payDateIdx = idx;
    if (cleaned === '배송방법') deliveryMethodIdx = idx;
  });

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    const orderId = orderIdIdx !== -1 ? String(row[orderIdIdx]).trim() : '';
    if (orderId && trackingMap[orderId]) {
      const tracking = trackingMap[orderId];
      if (courierIdx !== -1) row[courierIdx] = tracking.택배사;
      if (trackingNumIdx !== -1) row[trackingNumIdx] = tracking.송장번호;
      if (deliveryMethodIdx !== -1) row[deliveryMethodIdx] = '택배,등기,소포';
    }

    // 2단계 네이버 원본에 반영될 때에도 날짜 깨짐을 방지하고 YYYY.MM.DD HH.mm 형식으로 기입
    if (orderDateIdx !== -1 && row[orderDateIdx] !== undefined && row[orderDateIdx] !== '') {
      const dateObj = parseExcelDate(row[orderDateIdx]);
      if (dateObj) {
        row[orderDateIdx] = formatDate(dateObj, 'YYYY.MM.DD HH.mm');
      }
    }
    if (payDateIdx !== -1 && row[payDateIdx] !== undefined && row[payDateIdx] !== '') {
      const dateObj = parseExcelDate(row[payDateIdx]);
      if (dateObj) {
        row[payDateIdx] = formatDate(dateObj, 'YYYY.MM.DD HH.mm');
      }
    }
  }

  const newWorksheet = XLSX.utils.aoa_to_sheet(rawData);
  const newWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, '발송처리');

  return XLSX.write(newWorkbook, { bookType: 'xlsx', type: 'array' });
}
