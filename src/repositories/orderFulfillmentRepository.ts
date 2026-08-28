import { prisma } from '@/lib/order-converter/prisma';

// 상품주문 1건 단위 자체 이행 상태 저장소.
// "배송대기 = 발주요청(발주서 메일) 발송됨"을 productOrderId 단위로 영속하고, 대시보드 판정에서
// 조인해 쓴다. 판정 규칙 자체는 lib/order-converter/order-fulfillment.ts에 있다.

function uniqIds(productOrderIds: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set((productOrderIds || []).map((id) => String(id ?? '').trim()).filter(Boolean)),
  );
}

// 대량 IN 조회 시 파라미터 폭주를 막는 청크 크기.
const QUERY_CHUNK = 500;

export const orderFulfillmentRepository = {
  /**
   * 발주요청 이메일 발송 성공 시, 그 발주서에 실린 상품주문번호들에 poRequestedAt을 찍는다.
   * 멱등: 이미 있으면 poRequestedAt/campaignId만 갱신(재발송 시 최신 시각으로 이동).
   */
  async stampPoRequested(productOrderIds: Array<string | null | undefined>, campaignId?: string | null) {
    const ids = uniqIds(productOrderIds);
    if (ids.length === 0) return { stamped: 0 };
    const now = new Date();
    const cid = campaignId && campaignId.trim() ? campaignId.trim() : null;

    await Promise.all(
      ids.map((productOrderId) =>
        prisma.orderFulfillmentState.upsert({
          where: { productOrderId },
          update: { poRequestedAt: now, ...(cid ? { campaignId: cid } : {}) },
          create: { productOrderId, campaignId: cid, poRequestedAt: now },
        }),
      ),
    );
    return { stamped: ids.length };
  },

  /**
   * 주어진 상품주문번호들 중 발주요청이 발송된(poRequestedAt != null) 것들의 집합을 돌려준다.
   * 대시보드 판정에서 deriveOrderPipelineBucket의 poRequested 인자로 쓴다.
   */
  async getPoRequestedSet(productOrderIds: Array<string | null | undefined>): Promise<Set<string>> {
    const ids = uniqIds(productOrderIds);
    const result = new Set<string>();
    if (ids.length === 0) return result;

    for (let i = 0; i < ids.length; i += QUERY_CHUNK) {
      const chunk = ids.slice(i, i + QUERY_CHUNK);
      const rows = await prisma.orderFulfillmentState.findMany({
        where: { productOrderId: { in: chunk }, poRequestedAt: { not: null } },
        select: { productOrderId: true },
      });
      for (const r of rows) result.add(r.productOrderId);
    }
    return result;
  },

  /**
   * getPoRequestedSet의 상위호환: 집합(발주요청 여부)뿐 아니라 발주요청 시각(poRequestedAt)까지
   * productOrderId → Date 로 돌려준다. 배송대기 목록에서 "발주요청 후 경과일"(독촉 판단의 핵심 값)을
   * 계산하는 데 쓴다. keys()로 집합을 파생하면 getPoRequestedSet과 동일 결과라 판정 로직은 무회귀.
   */
  async getPoRequestedMap(productOrderIds: Array<string | null | undefined>): Promise<Map<string, Date>> {
    const ids = uniqIds(productOrderIds);
    const result = new Map<string, Date>();
    if (ids.length === 0) return result;

    for (let i = 0; i < ids.length; i += QUERY_CHUNK) {
      const chunk = ids.slice(i, i + QUERY_CHUNK);
      const rows = await prisma.orderFulfillmentState.findMany({
        where: { productOrderId: { in: chunk }, poRequestedAt: { not: null } },
        select: { productOrderId: true, poRequestedAt: true },
      });
      for (const r of rows) {
        if (r.poRequestedAt) result.set(r.productOrderId, r.poRequestedAt);
      }
    }
    return result;
  },
};
