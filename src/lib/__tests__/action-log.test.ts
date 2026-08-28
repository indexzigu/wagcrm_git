import { describe, it, expect } from 'vitest';
import {
  deriveCountStatus,
  buildConfirmOrderLog,
  buildRequestPoLog,
  buildFetchInvoiceLog,
  buildRegisterInvoiceLog,
  buildDelayDispatchLog,
  sanitizeActionLogInput,
  ORDER_ACTIONS,
  ORDER_ACTION_LABELS,
} from '@/lib/order-converter/action-log';

const camp = { id: 'camp_1', name: '와이그라운드(김본명) - 뉴트리원' };

describe('deriveCountStatus', () => {
  it('실패 0 → OK', () => {
    expect(deriveCountStatus(5, 0)).toBe('OK');
    expect(deriveCountStatus(0, 0)).toBe('OK');
  });
  it('일부 실패 + 일부 성공 → PARTIAL', () => {
    expect(deriveCountStatus(41, 1)).toBe('PARTIAL');
  });
  it('성공 0 + 실패 있음 → ERROR', () => {
    expect(deriveCountStatus(0, 3)).toBe('ERROR');
  });
  it('음수/비정상 카운트는 0으로 취급', () => {
    expect(deriveCountStatus(-1, -1)).toBe('OK');
  });
});

describe('buildConfirmOrderLog (주문확인)', () => {
  it('전량 발주확인 성공 → OK, 에러메시지 없음', () => {
    const log = buildConfirmOrderLog({ campaign: camp, confirmSuccessCount: 12, confirmFailCount: 0 });
    expect(log.status).toBe('OK');
    expect(log.successCount).toBe(12);
    expect(log.errorMessage).toBeNull();
    expect(log.action).toBe('CONFIRM_ORDER');
    expect(log.campaignId).toBe('camp_1');
  });
  it('일부 발주확인 실패 → PARTIAL, 첫 사유 보존', () => {
    const log = buildConfirmOrderLog({
      campaign: camp,
      confirmSuccessCount: 10,
      confirmFailCount: 2,
      confirmFirstError: '이미 발주확인된 주문',
    });
    expect(log.status).toBe('PARTIAL');
    expect(log.failCount).toBe(2);
    expect(log.errorMessage).toBe('이미 발주확인된 주문');
  });
  it('스트림/네트워크 fatalError → ERROR, 카운트 0', () => {
    const log = buildConfirmOrderLog({ campaign: camp, fatalError: '서버 통신 오류' });
    expect(log.status).toBe('ERROR');
    expect(log.successCount).toBe(0);
    expect(log.failCount).toBe(0);
    expect(log.errorMessage).toBe('서버 통신 오류');
  });
  it('네이버 미확인 잔류(deferred) → status는 OK 유지하되 skipCount로 기록', () => {
    // 2026-07-13 실사고: 17건 제출 중 9건만 확인되고 8건이 조용히 누락. 실패 0이라
    // 상태는 OK지만, 잔여 미확인을 skipCount에 남겨 무증상으로 묻히지 않게 한다.
    const log = buildConfirmOrderLog({
      campaign: camp,
      confirmSuccessCount: 9,
      confirmFailCount: 0,
      confirmDeferredCount: 8,
    });
    expect(log.status).toBe('OK');
    expect(log.successCount).toBe(9);
    expect(log.failCount).toBe(0);
    expect(log.skipCount).toBe(8);
    expect(log.errorMessage).toBeNull();
  });
  it('실패 + 미확인 잔류 동시 → PARTIAL, skipCount 반영', () => {
    const log = buildConfirmOrderLog({
      campaign: camp,
      confirmSuccessCount: 5,
      confirmFailCount: 2,
      confirmDeferredCount: 3,
      confirmFirstError: '이미 발주확인된 주문',
    });
    expect(log.status).toBe('PARTIAL');
    expect(log.failCount).toBe(2);
    expect(log.skipCount).toBe(3);
    expect(log.errorMessage).toBe('이미 발주확인된 주문');
  });
});

describe('buildRequestPoLog (발주요청)', () => {
  it('메일 발송 성공 → OK, successCount 1', () => {
    const log = buildRequestPoLog({ campaign: camp, ok: true, fileName: 'po.xlsx', toEmail: 'order@x.co' });
    expect(log.status).toBe('OK');
    expect(log.successCount).toBe(1);
    expect(log.failCount).toBe(0);
    expect(log.details).toMatchObject({ fileName: 'po.xlsx', toEmail: 'order@x.co' });
  });
  it('orderCount가 주어지면 성공 건수에 실제 발주 주문 수를 반영한다', () => {
    const log = buildRequestPoLog({ campaign: camp, ok: true, orderCount: 37 });
    expect(log.status).toBe('OK');
    expect(log.successCount).toBe(37);
  });
  it('orderCount가 0/미상이면 성공을 최소 1건으로 폴백한다', () => {
    expect(buildRequestPoLog({ campaign: camp, ok: true, orderCount: 0 }).successCount).toBe(1);
    expect(buildRequestPoLog({ campaign: camp, ok: true }).successCount).toBe(1);
  });
  it('발송 실패 → ERROR, 사유 보존(없으면 기본 문구)', () => {
    const log = buildRequestPoLog({ campaign: camp, ok: false });
    expect(log.status).toBe('ERROR');
    expect(log.failCount).toBe(1);
    expect(log.errorMessage).toBe('메일 발송 실패');
  });
});

describe('buildFetchInvoiceLog (송장회신)', () => {
  it('송장 N건 확보 → OK', () => {
    const log = buildFetchInvoiceLog({ campaign: camp, trackingCount: 41, hadAttachment: true, fileName: 'reply.xlsx' });
    expect(log.status).toBe('OK');
    expect(log.successCount).toBe(41);
    expect(log.errorMessage).toBeNull();
  });
  it('첨부는 있으나 송장 0건 → ERROR (성공 위장 금지)', () => {
    const log = buildFetchInvoiceLog({ campaign: camp, trackingCount: 0, hadAttachment: true });
    expect(log.status).toBe('ERROR');
    expect(log.successCount).toBe(0);
    expect(log.errorMessage).toContain('0건');
  });
  it('메일/첨부 자체 없음 → ERROR', () => {
    const log = buildFetchInvoiceLog({ campaign: camp, trackingCount: 0, hadAttachment: false });
    expect(log.status).toBe('ERROR');
    expect(log.errorMessage).toContain('찾지 못함');
  });
});

describe('buildRegisterInvoiceLog (송장등록 — 실사고 핵심)', () => {
  it('전량 성공 → OK', () => {
    const log = buildRegisterInvoiceLog({ campaign: camp, successCount: 42, failCount: 0, skipCount: 0 });
    expect(log.status).toBe('OK');
    expect(log.successCount).toBe(42);
    expect(log.details).toBeNull();
  });
  it('중복 송장 1건 실패 → PARTIAL, failed[] 보존 + 사유', () => {
    const log = buildRegisterInvoiceLog({
      campaign: camp,
      successCount: 41,
      failCount: 1,
      skipCount: 0,
      failed: [{ productOrderId: '2024010112345', reason: '중복 송장번호' }],
      firstFailReason: '중복 송장번호',
      fileName: 'invoice.xls',
    });
    expect(log.status).toBe('PARTIAL');
    expect(log.errorMessage).toBe('중복 송장번호');
    expect((log.details as any).failed).toHaveLength(1);
    expect((log.details as any).failed[0].productOrderId).toBe('2024010112345');
    expect((log.details as any).fileName).toBe('invoice.xls');
  });
  it('스킵만 있음(이미 배송중 등) → OK, skipCount 반영', () => {
    const log = buildRegisterInvoiceLog({
      campaign: camp,
      successCount: 0,
      failCount: 0,
      skipCount: 3,
      skipped: [{ productOrderId: 'x', reason: 'DELIVERING' }],
    });
    expect(log.status).toBe('OK');
    expect(log.skipCount).toBe(3);
    expect((log.details as any).skipped).toHaveLength(1);
  });
  it('failed[] 상한(100) 초과분 절단', () => {
    const failed = Array.from({ length: 150 }, (_, i) => ({ productOrderId: String(i), reason: 'x' }));
    const log = buildRegisterInvoiceLog({ campaign: camp, successCount: 0, failCount: 150, skipCount: 0, failed });
    expect((log.details as any).failed).toHaveLength(100);
    expect(log.status).toBe('ERROR');
  });
  it('campaign.id 없으면 campaignId=null (미리보기 확정 경로)', () => {
    const log = buildRegisterInvoiceLog({ campaign: { name: '알수없는 캠페인' }, successCount: 1, failCount: 0, skipCount: 0 });
    expect(log.campaignId).toBeNull();
    expect(log.campaignName).toBe('알수없는 캠페인');
  });
});

describe('buildDelayDispatchLog (발송지연 — 고객 알림 즉시 발송 액션)', () => {
  it('전량 성공 → OK, 발송예정일·사유가 details에 보존된다', () => {
    const log = buildDelayDispatchLog({
      campaign: camp,
      successCount: 7,
      failCount: 0,
      skipCount: 0,
      dispatchDueDate: '2026-07-15T23:59:59.000+09:00',
      delayedDispatchReason: 'PRODUCT_PREPARE',
    });
    expect(log.action).toBe('DELAY_DISPATCH');
    expect(log.status).toBe('OK');
    expect(log.successCount).toBe(7);
    expect(log.errorMessage).toBeNull();
    expect(log.details).toMatchObject({
      dispatchDueDate: '2026-07-15T23:59:59.000+09:00',
      delayedDispatchReason: 'PRODUCT_PREPARE',
    });
  });
  it('일부 실패 → PARTIAL, failed[]와 첫 사유 보존', () => {
    const log = buildDelayDispatchLog({
      campaign: camp,
      successCount: 5,
      failCount: 2,
      skipCount: 0,
      failed: [{ productOrderId: '2026071012345', reason: '이미 발송된 주문' }],
      firstFailReason: '이미 발송된 주문',
    });
    expect(log.status).toBe('PARTIAL');
    expect(log.errorMessage).toBe('이미 발송된 주문');
    expect((log.details as any).failed).toHaveLength(1);
  });
  it('스킵만 있음(클레임 진행중 등) → OK, skipped[] 보존', () => {
    const log = buildDelayDispatchLog({
      campaign: camp,
      successCount: 0,
      failCount: 0,
      skipCount: 2,
      skipped: [
        { productOrderId: 'a', reason: 'CLAIM_IN_PROGRESS' },
        { productOrderId: 'b', reason: 'DELIVERING' },
      ],
    });
    expect(log.status).toBe('OK');
    expect(log.skipCount).toBe(2);
    expect((log.details as any).skipped).toHaveLength(2);
  });
  it('성공 0 + 실패만 → ERROR, 기본 실패 문구 폴백', () => {
    const log = buildDelayDispatchLog({ campaign: camp, successCount: 0, failCount: 3, skipCount: 0 });
    expect(log.status).toBe('ERROR');
    expect(log.errorMessage).toBe('발송지연 안내 일부 실패');
  });
  it('failed[] 상한(100) 초과분 절단', () => {
    const failed = Array.from({ length: 130 }, (_, i) => ({ productOrderId: String(i), reason: 'x' }));
    const log = buildDelayDispatchLog({ campaign: camp, successCount: 0, failCount: 130, skipCount: 0, failed });
    expect((log.details as any).failed).toHaveLength(100);
  });
  it('sanitizeActionLogInput이 DELAY_DISPATCH를 허용한다', () => {
    const out = sanitizeActionLogInput({
      campaignName: '테스트',
      action: 'DELAY_DISPATCH',
      status: 'OK',
      successCount: 1,
      failCount: 0,
      skipCount: 0,
    });
    expect(out).not.toBeNull();
    expect(out!.action).toBe('DELAY_DISPATCH');
  });
  it('라벨 매핑 — 작업기록 패널 표기용', () => {
    expect(ORDER_ACTION_LABELS.DELAY_DISPATCH).toBe('발송지연');
  });
});

describe('sanitizeActionLogInput (서버 검증)', () => {
  it('유효 입력 정규화', () => {
    const out = sanitizeActionLogInput({
      campaignId: 'c1',
      campaignName: '테스트',
      action: 'REGISTER_INVOICE',
      status: 'PARTIAL',
      successCount: 5,
      failCount: 1,
      skipCount: 0,
      errorMessage: '사유',
      details: { failed: [] },
    });
    expect(out).not.toBeNull();
    expect(out!.action).toBe('REGISTER_INVOICE');
  });
  it('알 수 없는 action 거부', () => {
    expect(sanitizeActionLogInput({ campaignName: 'x', action: 'HACK', status: 'OK' })).toBeNull();
  });
  it('잘못된 status 거부', () => {
    expect(sanitizeActionLogInput({ campaignName: 'x', action: 'CONFIRM_ORDER', status: 'WIN' })).toBeNull();
  });
  it('campaignName 누락 거부', () => {
    expect(sanitizeActionLogInput({ campaignName: '  ', action: 'CONFIRM_ORDER', status: 'OK' })).toBeNull();
  });
  it('배열 details 거부(객체만 허용)', () => {
    const out = sanitizeActionLogInput({ campaignName: 'x', action: 'CONFIRM_ORDER', status: 'OK', details: [1, 2] });
    expect(out!.details).toBeNull();
  });
  it('ORDER_ACTIONS 5종 노출', () => {
    expect(ORDER_ACTIONS).toEqual(['CONFIRM_ORDER', 'REQUEST_PO', 'FETCH_INVOICE', 'REGISTER_INVOICE', 'DELAY_DISPATCH']);
  });
});
