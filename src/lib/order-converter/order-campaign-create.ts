import type { Prisma } from '@prisma/client';
import { sortProductMappingsByProductName } from './product-mapping-sort';

/**
 * 주문캠페인(「주문 관리」 캠페인 등록) 생성의 공용 본체 — 순수 함수만(client-safe).
 *
 * 두 입구가 같은 판정을 쓴다. 손으로 두 벌 두면 한쪽만 바뀌어 봇이 만든 캠페인과 화면이 만든 캠페인이
 * 조용히 달라진다(이 저장소에 반복된 사고 유형):
 *  - 화면: 등록 창 `CampaignCreateModal.tsx`(상품 → 칸 파생) → `POST /order-converter/api/campaigns`
 *    (`campaigns-handler.ts`, 저장 칸 조립).
 *  - 봇: 기안 초안 창구 `agent-internal/order-campaign-draft.ts`(상품 → 칸 파생) → 결재함 승인 시
 *    `write-actions/create-order-campaign.ts`(저장 칸 조립).
 */

/** 스토어 상품 목록 원소(`searchNaverProducts().contents[i]`)에서 등록 창이 채우는 칸. */
export type OrderCampaignProductFields = {
  name: string;
  /** 상품명 머리 `[셀러 X 브랜드]` 의 셀러 부분. 없으면 빈 문자열(등록 창은 사람이 채운다). */
  sellerName: string;
  thumbnailUrl: string;
  category: string;
  productStatus: string;
  salePeriod: string;
  /** 캠페인 `productId` 로 저장할 번호 — 원상품번호 우선(`findCampaignChannelProduct` 가 두 번호를 다 받는다). */
  productId: string;
};

const formatYmdDots = (value: string): string => (value ? value.split('T')[0].replace(/-/g, '.') : '');

/** 등록 창 `useEffect`(상품 선택 시 칸 채우기)에서 옮겨 온 판정 — 동작은 옮기기 전과 같다. */
export function deriveOrderCampaignFieldsFromProduct(product: any): OrderCampaignProductFields {
  const cp = product?.channelProducts?.[0];
  const name: string = cp?.name || product?.name || product?.originProduct?.name || '알수없는 상품명';
  const thumbnailUrl: string = cp?.representativeImage?.url || '';
  const category: string =
    cp?.wholeCategoryName?.split('>').pop() ||
    product?.originProduct?.category?.name ||
    product?.category?.name ||
    '카테고리 미지정';

  const match = name.match(/^\[(.*?) X .*?\]/);
  const sellerName = match && match[1] ? match[1].trim() : '';

  let salePeriod = '기간 미정';
  const productStatus: string = cp?.statusType || 'WAIT';
  if (cp?.saleStartDate && cp?.saleEndDate) {
    const start = new Date(cp.saleStartDate);
    const end = new Date(cp.saleEndDate);
    const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    // 네이버가 대기·중지·품절 상품에 14일짜리 기본 기간을 합성해 돌려준다 — 실제 등록 기간이 아니다.
    if (['WAIT', 'SUSPENDED', 'OUTOFSTOCK'].includes(productStatus) && diffDays >= 13 && diffDays <= 15) {
      salePeriod = '미등록';
    } else {
      salePeriod = `${formatYmdDots(cp.saleStartDate)} ~ ${formatYmdDots(cp.saleEndDate)}`;
    }
  } else if (cp?.saleStartDate) {
    salePeriod = `${formatYmdDots(cp.saleStartDate)} ~ 계속`;
  }

  const productId: string =
    cp?.originProductNo?.toString() ||
    cp?.productNo?.toString() ||
    product?.originProduct?.productNo?.toString() ||
    '';

  return { name, sellerName, thumbnailUrl, category, productStatus, salePeriod, productId };
}

export type OrderCampaignCreateMappingInput = {
  productName?: string | null;
  optionName?: string | null;
  brandCode?: string | null;
  price?: number | string | null;
};

export type OrderCampaignCreateInput = {
  name: string;
  sellerName: string;
  template?: string | null;
  toEmail?: string | null;
  ccEmail?: string | null;
  thumbnailUrl?: string | null;
  category?: string | null;
  productStatus?: string | null;
  salePeriod?: string | null;
  productId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  mappings?: ReadonlyArray<OrderCampaignCreateMappingInput> | null;
};

/** `prisma.orderCampaign.create({ data })` 의 data — 등록 라우트 본문에서 옮겨 온 조립(빈 값 → null, 가격 숫자화). */
export function buildOrderCampaignCreateData(input: OrderCampaignCreateInput): Prisma.OrderCampaignCreateInput {
  const mappings = input.mappings ?? [];
  return {
    name: input.name,
    template: input.template || null,
    sellerName: input.sellerName,
    toEmail: input.toEmail || null,
    ccEmail: input.ccEmail || null,
    thumbnailUrl: input.thumbnailUrl || null,
    category: input.category || null,
    productStatus: input.productStatus || null,
    salePeriod: input.salePeriod || null,
    productId: input.productId || null,
    startDate: input.startDate ? new Date(input.startDate) : null,
    endDate: input.endDate ? new Date(input.endDate) : null,
    ...(mappings.length > 0 && {
      mappings: {
        create: sortProductMappingsByProductName([...mappings]).map((m) => ({
          productName: m.productName || '',
          optionName: m.optionName || '',
          brandCode: m.brandCode || '',
          price: Number(m.price) || 0,
        })),
      },
    }),
  };
}
