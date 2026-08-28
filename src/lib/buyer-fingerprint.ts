import { createHash } from "node:crypto";
import { INVALID_ORDER_STATUSES } from "@/lib/order-converter/group-orders";
import {
  attributeOrders,
  type PulseOrderLike,
  type PulseSalesCampaignSource,
} from "@/lib/mobile-pulse-data";

/**
 * 구매자 지문(buyer fingerprint) — 순수 로직만. DB 로더/스위프는 cross-campaign-repurchase.ts.
 *
 * 배경(2026-07-11 소유자 결정): NaverOrderSnapshot은 최근 ~30일만 보관되므로, 수개월 간격의
 * 회차간 재구매("보조배터리 1회차 구매자가 2회차에 돌아왔나")는 앞 회차 구매자를 영영 알 수 없어
 * 집계 불가였다. 회차(SalesCampaign)별 구매자 식별키를 해시로 영구 저장해 이 한계를 넘는다.
 * 포워드 전용 — 스냅샷이 이미 만료된 과거 회차는 소급 복구 불가.
 *
 * PII 계약: 원문 ordererNo(네이버 회원번호)는 절대 저장하지 않는다. sha256(pepper+키) 해시만
 * 저장하며, 해시는 카운트 집계(재구매 대조) 전용이다. 응답에는 개수만 노출(§0-1과 동일 기조).
 */

/**
 * 해시 pepper — 절대 변경 금지. 변경하면 기존 저장 지문과 신규 해시가 어긋나 과거 회차
 * 구매자 대조가 전부 깨진다(재구매 0으로 오집계). env 주입 대신 코드 상수로 고정한 이유:
 * env 로테이션/누락이 조용한 데이터 단절을 만들기 때문(결정성 > 은닉성. DB 단독 유출 시
 * 코드 없이는 역산 불가한 pseudonymization 수준은 유지된다).
 */
const BUYER_HASH_PEPPER = "wagcrm-buyer-fp-v1";

/** 구매자 식별키 원문 — ordererNo(회원 9자리, per-person 실증) 우선, 폴백 ordererId. 없으면 null. */
export function buyerKeyOf(order: PulseOrderLike): string | null {
  const raw = order.ordererNo ?? order.ordererId;
  if (raw === null || raw === undefined || raw === "") return null;
  return String(raw);
}

/** 결정적 해시 — 같은 사람은 캠페인·시간 무관 같은 해시. 64자 hex. */
export function hashBuyerKey(rawKey: string): string {
  return createHash("sha256").update(`${BUYER_HASH_PEPPER}:${rawKey}`).digest("hex");
}

/** buyerKeyOf + hashBuyerKey 합성 — 집계·저장 양쪽이 동일 키공간을 쓰게 하는 단일 진입점. */
export function hashedBuyerKeyOf(order: PulseOrderLike): string | null {
  const raw = buyerKeyOf(order);
  return raw === null ? null : hashBuyerKey(raw);
}

/**
 * 스냅샷 주문을 캠페인에 귀속시켜 SalesCampaign별 구매자 해시 집합을 만든다(순수).
 * 유효주문만(INVALID_ORDER_STATUSES 제외), 식별키 없는 주문(비회원 등)은 제외 — 하한값.
 * 반환: Map<salesCampaignId, Set<buyerHash>>.
 */
export function collectCampaignBuyerHashes(
  campaigns: PulseSalesCampaignSource[],
  orders: PulseOrderLike[],
): Map<string, Set<string>> {
  const byCampaign = new Map<string, Set<string>>();
  attributeOrders(campaigns, orders, (order, targetSc) => {
    const status = order.productOrderStatus ?? "";
    if (INVALID_ORDER_STATUSES.includes(status)) return;
    const hash = hashedBuyerKeyOf(order);
    if (!hash) return;
    let set = byCampaign.get(targetSc.id);
    if (!set) {
      set = new Set<string>();
      byCampaign.set(targetSc.id, set);
    }
    set.add(hash);
  });
  return byCampaign;
}
