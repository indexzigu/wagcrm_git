import { describe, it, expect } from 'vitest';
import { interleaveAddonRows } from '../group-orders';

const row = (id: string, orderId: string, label: string) => ({ 상품주문번호: id, _orderId: orderId, label });

describe('interleaveAddonRows (발주서 주문 단위 그룹핑)', () => {
  it('추가옵션 행이 같은 주문의 메인 행 바로 뒤에 붙는다 (합포장 인지)', () => {
    const mains = [
      row('M1', 'O1', '배터리-고객A'),
      row('M2', 'O2', '배터리-고객B'),
      row('M3', 'O3', '배터리-고객C'),
    ];
    const addons = [
      row('A1', 'O2', '파우치-고객B'),
      row('A2', 'O2', '케이블-고객B'),
      row('A3', 'O1', '파우치-고객A'),
    ];
    const result = interleaveAddonRows(mains, addons).map(r => r.상품주문번호);
    expect(result).toEqual(['M1', 'A3', 'M2', 'A1', 'A2', 'M3']);
  });

  it('한 주문에 메인이 여러 행이면 그 뒤에 애드온이 온다', () => {
    const mains = [row('M1', 'O1', '배터리1'), row('M2', 'O1', '배터리2'), row('M3', 'O2', '배터리3')];
    const addons = [row('A1', 'O1', '케이블')];
    expect(interleaveAddonRows(mains, addons).map(r => r.상품주문번호)).toEqual(['M1', 'M2', 'A1', 'M3']);
  });

  it('메인이 없는 주문의 애드온은 누락 없이 뒤에 붙는다', () => {
    const mains = [row('M1', 'O1', '배터리')];
    const addons = [row('A1', 'O9', '고아 파우치'), row('A2', 'O9', '고아 케이블')];
    expect(interleaveAddonRows(mains, addons).map(r => r.상품주문번호)).toEqual(['M1', 'A1', 'A2']);
  });

  it('_orderId가 없는 행도 순서 보존하며 안전 처리된다', () => {
    const mains = [row('M1', '', 'a'), row('M2', 'O1', 'b')];
    const addons = [row('A1', '', 'c')];
    const result = interleaveAddonRows(mains, addons).map(r => r.상품주문번호);
    expect(result).toEqual(['M1', 'M2', 'A1']);
    expect(result).toHaveLength(3); // 누락 없음
  });

  it('애드온이 없으면 메인 순서를 그대로 반환한다', () => {
    const mains = [row('M1', 'O1', 'a'), row('M2', 'O2', 'b')];
    expect(interleaveAddonRows(mains, [])).toEqual(mains);
  });
});
