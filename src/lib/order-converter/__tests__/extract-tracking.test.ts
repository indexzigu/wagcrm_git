import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { extractTrackingMap, extractTrackingMapByReply } from '../order-parser';
import {
  NUTRIONE_GOLDEN_RULES as NUTRIONE_LEGACY_RULES,
  TRIPP_GOLDEN_RULES as TRIPP_LEGACY_RULES,
} from './golden-rules.fixture';

function toXlsx(sheetName: string, rows: Record<string, unknown>[]): ArrayBuffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

describe('extractTrackingMapByReply', () => {
  it('뉴트리원 회신(브랜드가 택배사/송장번호 열 삽입, 헤더명 키·lenient): 헤더명으로 매칭', () => {
    // §10 골든 실물: 우리 템플릿 19열에 브랜드가 택배사·송장번호를 삽입해 회신.
    // '품목별 주문번호'(공백 포함)도 주문번호 후보 — 공백 제거 후 매칭돼야 한다.
    const buf = toXlsx('발주서', [
      { '주문일': '2026-06-24', '주문번호': '2026062412345671', '품목별 주문번호': '2026062412345671', '택배사': 'CJ택배', '송장번호': '123456789012' },
      { '주문일': '2026-06-24', '주문번호': '', '품목별 주문번호': '2026062412345672', '택배사': '한진택배', '송장번호': '999888777666' },
    ]);
    const map = extractTrackingMapByReply(buf, NUTRIONE_LEGACY_RULES.reply);
    expect(map['2026062412345671']).toEqual({ 택배사: 'CJ대한통운', 송장번호: '123456789012' }); // CJ택배→CJ대한통운 정규화
    expect(map['2026062412345672']).toEqual({ 택배사: '한진택배', 송장번호: '999888777666' }); // 주문번호 빈값 → 품목별 주문번호 폴백
  });

  it('맥에서 만든 회신(헤더가 자모 분리): 눈에 같은 헤더를 놓치지 않는다', () => {
    // 🔴 브랜드사가 맥에서 만든 엑셀은 한글 헤더가 **NFD** 로 들어온다. 공백만 지우고
    //    비교하면 `송장번호` 가 눈에는 같은데 우리 상수와 안 맞아 **조용히 0건**이 되고,
    //    화면에는 「송장번호를 찾지 못했습니다」로 떠서 회신이 없는 것과 구분되지 않는다
    //    (2026-09-02 실증). 편지함 이름·제목·첨부 파일명과 같은 축이다.
    const nfd = (s: string) => s.normalize('NFD');
    const buf = toXlsx(nfd('발주서'), [
      {
        [nfd('주문번호')]: '2026062412345671',
        [nfd('택배사')]: 'CJ택배',
        [nfd('송장번호')]: '123456789012',
      },
    ]);
    const map = extractTrackingMapByReply(buf, NUTRIONE_LEGACY_RULES.reply);
    expect(map['2026062412345671']).toEqual({ 택배사: 'CJ대한통운', 송장번호: '123456789012' });
  });

  it('트리프 회신(naver-strict): 16자리 주문번호만 유효, 이벤트행 배제', () => {
    // §10 골든 실물: 트리프 '주문리스트'는 '운송장번호' 컬럼 + '주문번호'가 네이버 상품주문번호.
    // '이벤트(트리프지원)' 같은 비주문 문자열 행은 strict 패턴이 배제해야 한다.
    const buf = toXlsx('주문리스트', [
      { '주문번호': '2026070712345675', '운송장번호': '111122223333', '택배사': '한진택배' },
      { '주문번호': '이벤트(트리프지원)', '운송장번호': '444455556666', '택배사': '한진택배' }, // 배제 대상
      { '주문번호': '2026070712345676', '운송장번호': '', '택배사': '한진택배' }, // 송장 없음 → 제외
    ]);
    const map = extractTrackingMapByReply(buf, TRIPP_LEGACY_RULES.reply);
    expect(Object.keys(map)).toEqual(['2026070712345675']);
    expect(map['2026070712345675']).toEqual({ 택배사: '한진택배', 송장번호: '111122223333' });
  });

  it('lenient는 비-네이버 형태 주문번호도 통과시킨다(뉴트리원 관대 모드)', () => {
    const buf = toXlsx('발주서', [{ '주문번호': 'ORD-XYZ', '송장번호': '123', '택배사': '롯데택배' }]);
    const map = extractTrackingMapByReply(buf, NUTRIONE_LEGACY_RULES.reply);
    expect(map['ORD-XYZ']).toEqual({ 택배사: '롯데택배', 송장번호: '123' });
  });

  it('trackingHeaders 미지정 시 기본 후보(송장번호/운송장번호/운송장/택배송장번호)를 쓴다', () => {
    const reply = { orderIdHeaders: ['주문번호'], orderIdPattern: 'lenient' as const };
    const buf = toXlsx('s', [{ '주문번호': 'A1', '택배송장번호': '777', '택배사': '' }]);
    const map = extractTrackingMapByReply(buf, reply);
    expect(map['A1']).toEqual({ 택배사: 'CJ대한통운', 송장번호: '777' }); // 택배사 빈값 → 기본 CJ대한통운
  });
});

describe('extractTrackingMap (레거시 시그니처 위임)', () => {
  it('templateId=tripp는 strict 규칙으로 위임(formatAdapter 없이도)', () => {
    const buf = toXlsx('주문리스트', [
      { '주문번호': '2026070712345675', '운송장번호': '111122223333' },
      { '주문번호': '증정품', '운송장번호': '000' },
    ]);
    expect(Object.keys(extractTrackingMap(buf, 'tripp'))).toEqual(['2026070712345675']);
  });

  it('formatAdapter가 templateId보다 우선(신규 브랜드 slug=거래처 id 케이스)', () => {
    // slug가 tripp이 아니어도 formatAdapter=tripp면 strict 적용
    const buf = toXlsx('주문리스트', [{ '주문번호': '증정품', '운송장번호': '000' }]);
    expect(extractTrackingMap(buf, 'some-partner-id', 'tripp')).toEqual({});
  });

  it('기본(뉴트리원 계열)은 lenient', () => {
    const buf = toXlsx('발주서', [{ '주문번호': 'ORD-1', '송장번호': '555' }]);
    expect(extractTrackingMap(buf, 'nutrione')['ORD-1']).toEqual({ 택배사: 'CJ대한통운', 송장번호: '555' });
  });
});
