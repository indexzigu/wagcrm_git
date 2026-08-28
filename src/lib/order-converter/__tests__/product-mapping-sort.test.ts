import { describe, expect, it } from 'vitest';
import { sortProductMappingsByProductName } from '../product-mapping-sort';

describe('sortProductMappingsByProductName', () => {
  it('sorts mapping rows by product name with stable deterministic tie-breakers', () => {
    const rows = [
      { id: '3', productName: '비타민', optionName: '2박스', brandCode: 'C', price: 2000 },
      { id: '4', productName: '', optionName: '추가 파우치', brandCode: 'D', price: 500 },
      { id: '2', productName: '콜라겐', optionName: '1박스', brandCode: 'B', price: 1000 },
      { id: '1', productName: '비타민', optionName: '1박스', brandCode: 'A', price: 1000 },
    ];

    expect(sortProductMappingsByProductName(rows).map((row) => row.id)).toEqual(['1', '3', '2', '4']);
    expect(rows.map((row) => row.id)).toEqual(['3', '4', '2', '1']);
  });
});
