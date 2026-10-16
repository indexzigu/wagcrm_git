/**
 * 주문캠페인의 `productId` 로 스토어 상품 목록에서 채널상품 하나를 고른다 — 순수 함수(client-safe).
 *
 * 캠페인 설정 창(「스토어 옵션 불러오기」, `CampaignEditModal.tsx`)과 봇 내부 창구
 * (`src/lib/agent-internal/store-product-options.ts`)가 같은 판정을 쓴다. 두 곳에 손으로 두면 한쪽만
 * 원상품번호를 아는 상태가 생긴다 — 생성 창(`CampaignCreateModal.tsx`)은 `productId` 에 **원상품번호**를
 * 저장하지만, 옛 캠페인에는 채널상품번호가 들어 있을 수 있어 둘 다 받아야 한다.
 *
 * `products` 는 상품 목록 조회(`searchNaverProducts().contents`)의 원소 모양 그대로다:
 * `{ originProductNo, channelProducts: [{ channelProductNo, name, ... }] }`.
 *
 * ⚠️ 상품명 폴백은 여기 없다. 설정 창은 일치하는 번호가 없으면 상품명으로 한 번 더 찾지만(사람이 결과를 보고
 *    고친다), 봇은 그 결과를 사람 확인 없이 쓰므로 번호가 맞을 때만 고른다.
 */
export type StoreChannelProduct = {
  channelProductNo: string;
  originProductNo: string | null;
  name: string;
};

export function findCampaignChannelProduct(
  products: ReadonlyArray<unknown>,
  productId: string | null | undefined,
): StoreChannelProduct | null {
  const wanted = typeof productId === "string" ? productId.trim() : "";
  if (wanted === "") return null;
  for (const product of products) {
    if (product === null || typeof product !== "object") continue;
    const origin = (product as { originProductNo?: unknown }).originProductNo;
    const originNo = origin === undefined || origin === null ? null : String(origin);
    const channels = (product as { channelProducts?: unknown }).channelProducts;
    if (!Array.isArray(channels)) continue;
    for (const channel of channels) {
      if (channel === null || typeof channel !== "object") continue;
      const rawNo = (channel as { channelProductNo?: unknown }).channelProductNo;
      if (rawNo === undefined || rawNo === null) continue;
      const channelNo = String(rawNo);
      if (channelNo === wanted || originNo === wanted) {
        const name = (channel as { name?: unknown }).name;
        return { channelProductNo: channelNo, originProductNo: originNo, name: typeof name === "string" ? name : "" };
      }
    }
  }
  return null;
}
