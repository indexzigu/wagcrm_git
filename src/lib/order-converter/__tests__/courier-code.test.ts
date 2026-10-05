import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY_COURIER_LABEL,
  NAVER_COURIER_OPTIONS,
  applyCourierChoices,
  buildNaverDispatchRequests,
  confirmCourierChoices,
  groupUnresolvedCouriers,
  isCourierChoiceComplete,
  isKnownNaverCourierCode,
  resolveNaverCourierCode,
} from '../courier-code';

describe('resolveNaverCourierCode', () => {
  it.each([
    ['CJ대한통운', 'CJGLS'],
    ['CJ택배', 'CJGLS'],
    ['롯데택배', 'HYUNDAI'],
    ['우체국택배', 'EPOST'],
    ['로젠택배', 'KGB'],
    ['한진택배', 'HANJIN'],
  ])('종전 표가 지원하던 %s → %s', (name, code) => {
    expect(resolveNaverCourierCode(name)).toEqual({ ok: true, code });
  });

  it.each([
    [' CJ 대한통운 ', 'CJGLS'],
    ['cj대한통운', 'CJGLS'],
    ['한진 택배', 'HANJIN'],
    ['롯데\t택배', 'HYUNDAI'],
    ['한진택배'.normalize('NFD'), 'HANJIN'],
  ])('공백·대소문자·자모 분리 변형 %j → %s', (name, code) => {
    expect(resolveNaverCourierCode(name)).toEqual({ ok: true, code });
  });

  it('모르는 택배사는 명시적 unknown 이다 — CJGLS 로 접지 않는다', () => {
    const r = resolveNaverCourierCode('경동택배');
    expect(r).toEqual({ ok: false, reason: 'unknown', input: '경동택배' });
    expect(JSON.stringify(r)).not.toContain('CJGLS');
  });

  it.each([[''], ['   '], [null], [undefined]])('빈 값 %j 은 명시적 empty 다', (v) => {
    expect(resolveNaverCourierCode(v)).toEqual({ ok: false, reason: 'empty', input: '' });
  });
});

describe('isKnownNaverCourierCode', () => {
  it('이 모듈이 내는 코드만 통과시킨다', () => {
    expect(isKnownNaverCourierCode('CJGLS')).toBe(true);
    expect(isKnownNaverCourierCode('HYUNDAI')).toBe(true);
    for (const bad of ['', 'cjgls', 'UNKNOWN', undefined, null, 1]) {
      expect(isKnownNaverCourierCode(bad)).toBe(false);
    }
  });
});

describe('buildNaverDispatchRequests', () => {
  const DATE = '2026-10-05T00:00:00.000Z';

  it('전부 인식되면 종전과 같은 모양의 요청을 만든다', () => {
    const built = buildNaverDispatchRequests(
      [{ id: ' 2026100512345671 ', courier: 'CJ대한통운', tracking: ' 1234 ' }],
      DATE,
    );
    expect(built).toEqual({
      ok: true,
      requests: [
        {
          productOrderId: '2026100512345671',
          deliveryMethod: 'DELIVERY',
          deliveryCompanyCode: 'CJGLS',
          trackingNumber: '1234',
          dispatchDate: DATE,
        },
      ],
    });
  });

  it('한 건이라도 못 읽으면 요청을 하나도 만들지 않고, 택배사와 건수를 문구에 싣는다', () => {
    const built = buildNaverDispatchRequests(
      [
        { id: '1', courier: 'CJ대한통운', tracking: 'a' },
        { id: '2', courier: '경동택배', tracking: 'b' },
        { id: '3', courier: '경동택배', tracking: 'c' },
        { id: '4', courier: '', tracking: 'd' },
      ],
      DATE,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect('requests' in built).toBe(false);
    expect(built.unrecognised).toEqual([
      { courier: '경동택배', count: 2 },
      { courier: '택배사 미기재', count: 1 },
    ]);
    expect(built.message).toBe(
      '택배사를 인식하지 못해 등록을 중단했습니다: 경동택배(2건), 택배사 미기재(1건)',
    );
  });
});

describe('소비처 계약 — 화면이 기본 택배사 코드를 다시 들지 않는다', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');

  it('order-dashboard 는 빌더에 위임하고, 중단 분기가 네이버 호출보다 앞에 있다', () => {
    const src = read('components', 'crm', 'order-dashboard.tsx');
    expect(src).not.toMatch(/['"]CJGLS['"]/);
    expect(src).not.toContain('courierMap');
    const buildAt = src.indexOf('buildNaverDispatchRequests(');
    const abortAt = src.indexOf('if (!built.ok)');
    const fetchAt = src.indexOf("fetch('/order-converter/api/naver/dispatch'");
    expect(buildAt).toBeGreaterThan(0);
    expect(abortAt).toBeGreaterThan(buildAt);
    expect(fetchAt).toBeGreaterThan(abortAt);
  });
});

describe('운영자 택배사 선택 — 묶기·입히기 (오너 확정 2026-10-05)', () => {
  const records = [
    { id: '2026100500000001', courier: 'CJ대한통운', tracking: '111' },
    { id: '2026100500000002', courier: '경동택배', tracking: '222' },
    { id: '2026100500000003', courier: '', tracking: '333' },
    { id: '2026100500000004', courier: ' 경동택배 ', tracking: '444' },
    { id: '2026100500000005', courier: '   ', tracking: '555' },
    { id: '2026100500000006', courier: '한진', tracking: '666' },
    { id: '2026100500000007', courier: '', tracking: '777' },
  ];

  it('고를 수 있는 택배사는 서버가 받는 코드 집합과 정확히 같다(단일 정본)', () => {
    expect(NAVER_COURIER_OPTIONS.map((o) => o.label)).toEqual([
      'CJ대한통운',
      '롯데택배',
      '우체국택배',
      '로젠택배',
      '한진택배',
    ]);
    for (const option of NAVER_COURIER_OPTIONS) {
      expect(isKnownNaverCourierCode(option.code)).toBe(true);
      // 대표 표기는 다시 같은 코드로 해석돼야 한다 — 입힌 레코드가 그대로 요청 빌더를 통과하는 근거.
      expect(resolveNaverCourierCode(option.label)).toEqual({ ok: true, code: option.code });
    }
  });

  it('못 읽은 송장만, 파일에 적힌 글자별로 묶는다 — 빈 칸은 한 묶음', () => {
    expect(groupUnresolvedCouriers(records)).toEqual([
      { key: '경동택배', label: '경동택배', count: 2 },
      { key: '', label: EMPTY_COURIER_LABEL, count: 3 },
    ]);
    expect(groupUnresolvedCouriers([records[0], records[5]])).toEqual([]);
  });

  it('선택은 못 읽은 송장에만 입혀지고, 인식된 송장은 그대로다', () => {
    const applied = applyCourierChoices(records, { 경동택배: 'HANJIN', '': 'EPOST' });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.overrides).toEqual([
      { raw: '경동택배', code: 'HANJIN', count: 2 },
      { raw: EMPTY_COURIER_LABEL, code: 'EPOST', count: 3 },
    ]);
    // 인식된 두 건은 객체째 그대로(파일 값 유지).
    expect(applied.records[0]).toBe(records[0]);
    expect(applied.records[5]).toBe(records[5]);

    const built = buildNaverDispatchRequests(applied.records, '2026-10-05T00:00:00.000Z');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.requests.map((r) => r.deliveryCompanyCode)).toEqual([
      'CJGLS',
      'HANJIN',
      'EPOST',
      'HANJIN',
      'EPOST',
      'HANJIN',
      'EPOST',
    ]);
    expect(built.requests.map((r) => r.productOrderId)).toEqual(records.map((r) => r.id));
  });

  it('덜 고른 선택으로는 레코드도 요청도 나오지 않는다', () => {
    const partial = applyCourierChoices(records, { 경동택배: 'HANJIN' });
    expect(partial).toEqual({ ok: false, missing: [{ key: '', label: EMPTY_COURIER_LABEL, count: 3 }] });
    expect(isCourierChoiceComplete(groupUnresolvedCouriers(records), { 경동택배: 'HANJIN' })).toBe(false);
    expect(isCourierChoiceComplete(groupUnresolvedCouriers(records), { 경동택배: 'HANJIN', '': 'EPOST' })).toBe(true);
  });

  it('서버가 받지 않는 코드는 고른 것으로 치지 않는다', () => {
    const bogus = applyCourierChoices(records, { 경동택배: 'KDEXP', '': 'EPOST' });
    expect(bogus.ok).toBe(false);
    expect(isCourierChoiceComplete(groupUnresolvedCouriers(records), { 경동택배: 'KDEXP', '': 'EPOST' })).toBe(false);
  });

  describe('confirmCourierChoices — 묻고 기다리는 관문', () => {
    it('전부 인식되면 묻지 않고 통과한다', async () => {
      const ask = vi.fn();
      const result = await confirmCourierChoices([records[0], records[5]], ask);
      expect(ask).not.toHaveBeenCalled();
      expect(result).toEqual({ records: [records[0], records[5]], overrides: [] });
    });

    it('못 읽은 송장이 있으면 묶음을 들고 묻고, 답이 올 때까지 끝나지 않는다', async () => {
      let answer: (choices: Record<string, string> | null) => void = () => {};
      const ask = vi.fn(
        () => new Promise<Record<string, string> | null>((resolve) => { answer = resolve; }),
      );
      let settled = false;
      const pending = confirmCourierChoices(records, ask).then((r) => { settled = true; return r; });
      await Promise.resolve();
      await Promise.resolve();
      expect(ask).toHaveBeenCalledWith(groupUnresolvedCouriers(records));
      expect(settled).toBe(false);

      answer({ 경동택배: 'KGB', '': 'CJGLS' });
      const result = await pending;
      expect(result?.overrides).toEqual([
        { raw: '경동택배', code: 'KGB', count: 2 },
        { raw: EMPTY_COURIER_LABEL, code: 'CJGLS', count: 3 },
      ]);
    });

    it('취소(null)·덜 고른 답은 null — 호출부가 보낼 것이 없다', async () => {
      expect(await confirmCourierChoices(records, async () => null)).toBeNull();
      expect(await confirmCourierChoices(records, async () => ({ 경동택배: 'KGB' }))).toBeNull();
    });
  });
});
