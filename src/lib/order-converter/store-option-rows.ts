/**
 * 스토어 상품 상세(v2 channel-products 응답)에서 캠페인 매핑 표 행을 생성한다.
 *
 * 배경: 뉴트리원처럼 거래처가 상품코드표를 주는 경우는 붙여넣기로 매핑을 만들지만,
 * 코드표가 없는 일반 거래처는 스토어에 등록된 판매 옵션·가격을 그대로 매핑 기반으로 쓴다.
 * 여기서 만든 optionName은 네이버 주문(productOrder.productOption)의 문구 포맷과 동일하게
 * 조합하므로("그룹1: 옵션1 / 그룹2: 옵션2"), 캠페인 주문 매칭(정규화 includes)이 정확히 걸린다.
 * 상품코드(brandCode)는 코드표 없는 거래처를 위해 빈 값으로 둔다(스키마 허용, 미기입 운영).
 */

export interface StoreMappingRow {
  productName: string;
  optionName: string;
  brandCode: string;
  price: number;
}

/** salePrice에 즉시할인 정책을 적용한 실판매가(스토어 노출 할인가)를 계산한다. */
export function computeDiscountedPrice(salePrice: number, discountMethod?: { value?: number; unitType?: string } | null): number {
  const base = Number(salePrice) || 0;
  const value = Number(discountMethod?.value) || 0;
  if (!value) return base;
  if (discountMethod?.unitType === 'PERCENT') {
    return Math.round((base * (100 - value)) / 100);
  }
  return Math.max(0, base - value);
}

/**
 * v2 상품 상세 응답 본문에서 매핑 행 목록을 만든다.
 * - 옵션 조합(optionCombinations): 주문 productOption 포맷("그룹: 옵션 / 그룹: 옵션")으로 조합,
 *   가격 = 할인 반영가 + 옵션 델타. productName은 채널 상품명(주문 productName과 동일)로 채운다.
 * - 추가구성상품(supplementProducts): 주문 포맷("그룹명: 이름")으로 조합, 가격은 절대가.
 *   추가구성 주문의 productName은 애드온 자체 이름이라(상품명 매칭 강제 시 오히려 탈락)
 *   productName을 비워 옵션명 단독 매칭으로 둔다.
 * - 옵션이 전혀 없으면 상품명+할인 반영가 단일 행.
 */
export function buildStoreMappingRows(detailBody: any): { productName: string; rows: StoreMappingRow[] } {
  const op = detailBody?.originProduct;
  const productName: string =
    detailBody?.smartstoreChannelProduct?.name || op?.name || '';

  const discounted = computeDiscountedPrice(
    op?.salePrice || 0,
    op?.customerBenefit?.immediateDiscountPolicy?.discountMethod
  );

  const rows: StoreMappingRow[] = [];
  const optionInfo = op?.detailAttribute?.optionInfo;
  const groupNames = optionInfo?.optionCombinationGroupNames || {};
  const combos: any[] = Array.isArray(optionInfo?.optionCombinations) ? optionInfo.optionCombinations : [];

  for (const combo of combos) {
    if (combo?.usable === false) continue;
    const parts: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const name = combo?.[`optionName${i}`];
      if (!name) continue;
      const group = groupNames?.[`optionGroupName${i}`];
      parts.push(group ? `${group}: ${name}` : String(name));
    }
    if (parts.length === 0) continue;
    rows.push({
      productName,
      optionName: parts.join(' / '),
      brandCode: '',
      price: discounted + (Number(combo?.price) || 0),
    });
  }

  const supplements: any[] =
    op?.detailAttribute?.supplementProductInfo?.supplementProducts || [];
  for (const sp of supplements) {
    if (sp?.usable === false) continue;
    const name = sp?.name || '';
    if (!name) continue;
    rows.push({
      productName: '',
      optionName: sp?.groupName ? `${sp.groupName}: ${name}` : String(name),
      brandCode: '',
      price: Number(sp?.price) || 0,
    });
  }

  if (rows.length === 0 && productName) {
    rows.push({ productName, optionName: '', brandCode: '', price: discounted });
  }

  return { productName, rows };
}
