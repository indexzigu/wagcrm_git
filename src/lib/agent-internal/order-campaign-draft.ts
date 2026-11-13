import { getPrisma } from "@/lib/prisma";
import { apiRequest } from "@/lib/order-converter/naver-commerce-client";
import { searchNaverProducts } from "@/lib/order-converter/naver-commerce-api";
import { buildStoreMappingRows } from "@/lib/order-converter/store-option-rows";
import { findCampaignChannelProduct } from "@/lib/order-converter/store-channel-product";
import { deriveOrderCampaignFieldsFromProduct } from "@/lib/order-converter/order-campaign-create";
import { listOrderBrands, type OrderBrand } from "@/lib/order-converter/order-brand";
import {
  MAX_ORDER_CAMPAIGN_DRAFT_ROWS,
  MAX_SAME_PRODUCT_CAMPAIGNS,
} from "@/lib/agent-worker/contracts";
import {
  agentInternalFailure,
  orderCampaignDraftDataSchema,
  type AgentInternalFailure,
  type OrderCampaignDraftData,
  type OrderCampaignDraftRequest,
} from "./api-contract";

/**
 * 주문캠페인 새로 만들기 기안의 **초안** — 봇 내부 창구용(2026-11-13).
 *
 * 화면 등록 창과 같은 순서다: 상품 목록(`searchNaverProducts`, 60초 공유 캐시) → 상품 하나 고르기 → 칸 파생
 * (`deriveOrderCampaignFieldsFromProduct`, 등록 창과 같은 본체) → 채널상품 상세 → 「스토어 옵션 불러오기」와 같은
 * `buildStoreMappingRows`. 거래처 양식은 등록 창 드롭다운과 같은 `listOrderBrands` 에서 고른다(수신·참조 메일 상속).
 *
 * ## Fixie(네이버 프록시) 요청 수 — 기안 1건당 1~2건
 * 상품 목록 0~1건(60초 안에 화면이 이미 불렀으면 0) + 채널상품 상세 1건. 후보가 여럿이거나 없으면 상세를 부르지 않아
 * 0~1건이다.
 *
 * ⛔ 상품명 일부가 여러 상품에 걸리면 **고르지 않는다** — 후보 이름·번호를 돌려줘 오너가 고르게 한다(봇이 사람
 *    확인 없이 쓰므로 `findCampaignChannelProduct` 와 같이 추측하지 않는다). 상품명이 질의와 정확히 같은 후보가
 *    하나뿐일 때만 그 하나를 고른다.
 */
export type SameProductCampaign = { id: string; name: string; isActive: boolean };

export type OrderCampaignDraftDeps = {
  /** 상품 목록 원소 배열(`searchNaverProducts().contents`). */
  listProducts: () => Promise<ReadonlyArray<unknown>>;
  /** 채널상품 상세 응답 본문. */
  fetchChannelProduct: (channelProductNo: string) => Promise<unknown>;
  listOrderBrands: () => Promise<ReadonlyArray<Pick<OrderBrand, "slug" | "displayName" | "toEmail" | "ccEmail">>>;
  findCampaignsByProductNos: (productNos: ReadonlyArray<string>) => Promise<SameProductCampaign[]>;
};

const defaultDeps: OrderCampaignDraftDeps = {
  listProducts: async () => {
    const data = await searchNaverProducts();
    return Array.isArray(data?.contents) ? data.contents : [];
  },
  fetchChannelProduct: async (channelProductNo) => {
    const res = await apiRequest("GET", `/v2/products/channel-products/${channelProductNo}`, undefined, undefined);
    return res?.data ?? res;
  },
  listOrderBrands: () => listOrderBrands(),
  findCampaignsByProductNos: (productNos) =>
    getPrisma().orderCampaign.findMany({
      where: { productId: { in: [...productNos] } },
      select: { id: true, name: true, isActive: true },
      orderBy: { createdAt: "desc" },
      take: MAX_SAME_PRODUCT_CAMPAIGNS,
    }),
};

/** 후보 안내 문구에 싣는 후보 수와 이름 길이 — 실패 문구 상한(300자) 안에 들어가게 한다. */
const MAX_LISTED_CANDIDATES = 4;
const MAX_LISTED_NAME_CHARS = 40;

/** 비교 키 — 유니코드 정규화 + 소문자 + 공백 제거(사람이 띄어쓰기를 다르게 불러도 같은 상품). */
export function productMatchKey(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

type ProductCandidate = {
  product: unknown;
  name: string;
  productId: string;
  channelProductNo: string;
  status: string;
};

function firstChannel(product: unknown): { channelProductNo: string; name: string; statusType: string } | null {
  const channels = (product as { channelProducts?: unknown } | null)?.channelProducts;
  if (!Array.isArray(channels) || channels.length === 0) return null;
  const channel = channels[0] as { channelProductNo?: unknown; name?: unknown; statusType?: unknown } | null;
  if (!channel || channel.channelProductNo === undefined || channel.channelProductNo === null) return null;
  return {
    channelProductNo: String(channel.channelProductNo),
    name: typeof channel.name === "string" ? channel.name : "",
    statusType: typeof channel.statusType === "string" ? channel.statusType : "",
  };
}

function toCandidate(product: unknown): ProductCandidate | null {
  const channel = firstChannel(product);
  if (!channel) return null;
  const fields = deriveOrderCampaignFieldsFromProduct(product);
  return {
    product,
    name: fields.name,
    productId: fields.productId || channel.channelProductNo,
    channelProductNo: channel.channelProductNo,
    status: channel.statusType,
  };
}

/** 판매중을 앞에 — 화면 상품 고르기 목록과 같은 우선(지금 팔고 있는 상품이 가장 흔한 대상). */
function bySaleFirst(a: ProductCandidate, b: ProductCandidate): number {
  return Number(b.status === "SALE") - Number(a.status === "SALE");
}

function describeCandidates(candidates: ReadonlyArray<ProductCandidate>): string {
  const shown = candidates
    .slice(0, MAX_LISTED_CANDIDATES)
    .map((c) => `「${c.name.slice(0, MAX_LISTED_NAME_CHARS)}」(상품번호 ${c.productId})`)
    .join(", ");
  const rest = candidates.length - MAX_LISTED_CANDIDATES;
  return shown + (rest > 0 ? ` 외 ${rest}개` : "");
}

type PickResult = { ok: true; candidate: ProductCandidate } | AgentInternalFailure;

export function pickProduct(products: ReadonlyArray<unknown>, request: OrderCampaignDraftRequest): PickResult {
  if (request.productId) {
    const channel = findCampaignChannelProduct(products, request.productId);
    const product = channel
      ? products.find((p) => firstChannel(p)?.channelProductNo === channel.channelProductNo)
      : undefined;
    const candidate = product === undefined ? null : toCandidate(product);
    if (!candidate) {
      return agentInternalFailure(
        "PRODUCT_NOT_FOUND",
        `스토어 상품 목록에서 상품번호 ${request.productId} 를 찾지 못했습니다(첫 번째 채널상품만 봅니다).`,
      );
    }
    return { ok: true, candidate };
  }

  const query = productMatchKey(request.productQuery ?? "");
  const seen = new Set<string>();
  const matches: ProductCandidate[] = [];
  for (const product of products) {
    const candidate = toCandidate(product);
    if (!candidate || seen.has(candidate.productId)) continue;
    if (!productMatchKey(candidate.name).includes(query)) continue;
    seen.add(candidate.productId);
    matches.push(candidate);
  }
  if (matches.length === 0) {
    return agentInternalFailure("PRODUCT_NOT_FOUND", `상품명에 「${request.productQuery}」가 든 스토어 상품이 없습니다.`);
  }
  if (matches.length === 1) return { ok: true, candidate: matches[0] };
  const exact = matches.filter((c) => productMatchKey(c.name) === query);
  if (exact.length === 1) return { ok: true, candidate: exact[0] };
  return agentInternalFailure(
    "PRODUCT_AMBIGUOUS",
    `상품이 ${matches.length}개 걸립니다. 상품번호(productId)로 다시 지목해 주세요: ${describeCandidates([...matches].sort(bySaleFirst))}`,
  );
}

type BrandPick =
  | { ok: true; brand: Pick<OrderBrand, "slug" | "displayName" | "toEmail" | "ccEmail"> | null }
  | AgentInternalFailure;

/** 발주 거래처 고르기 — 표시명·양식 키가 정확히 같은 것 하나, 없으면 일부가 걸리는 것 하나. 여럿·없음은 실패. */
export function pickOrderBrand(
  brands: ReadonlyArray<Pick<OrderBrand, "slug" | "displayName" | "toEmail" | "ccEmail">>,
  wanted: string | undefined,
): BrandPick {
  if (!wanted) return { ok: true, brand: null };
  const key = productMatchKey(wanted);
  const exact = brands.filter((b) => productMatchKey(b.displayName) === key || productMatchKey(b.slug) === key);
  if (exact.length === 1) return { ok: true, brand: exact[0] };
  const partial = exact.length === 0 ? brands.filter((b) => productMatchKey(b.displayName).includes(key)) : exact;
  if (partial.length === 1) return { ok: true, brand: partial[0] };
  const names = brands.map((b) => b.displayName).slice(0, 8).join(", ");
  return agentInternalFailure(
    "ORDER_BRAND_NOT_FOUND",
    partial.length === 0
      ? `발주 거래처 「${wanted}」를 찾지 못했습니다. 등록된 거래처 양식: ${names}`
      : `발주 거래처 「${wanted}」가 ${partial.length}곳에 걸립니다: ${partial.map((b) => b.displayName).join(", ")}`,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type OrderCampaignDraftResult = { ok: true; data: OrderCampaignDraftData } | AgentInternalFailure;

export async function buildOrderCampaignDraft(
  request: OrderCampaignDraftRequest,
  deps: OrderCampaignDraftDeps = defaultDeps,
): Promise<OrderCampaignDraftResult> {
  let brands: Awaited<ReturnType<OrderCampaignDraftDeps["listOrderBrands"]>>;
  try {
    brands = await deps.listOrderBrands();
  } catch (error) {
    console.error("[agent-internal] order campaign draft brand lookup failed:", describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `발주 거래처 양식 조회에 실패했습니다: ${describeError(error)}`);
  }
  const brandPick = pickOrderBrand(brands, request.orderBrand);
  if (!brandPick.ok) return brandPick;

  let detailBody: unknown;
  let candidate: ProductCandidate;
  try {
    const pick = pickProduct(await deps.listProducts(), request);
    if (!pick.ok) return pick;
    candidate = pick.candidate;
    detailBody = await deps.fetchChannelProduct(candidate.channelProductNo);
  } catch (error) {
    console.error("[agent-internal] order campaign draft fetch failed:", describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `스토어 상품 조회에 실패했습니다: ${describeError(error)}`);
  }

  const fields = deriveOrderCampaignFieldsFromProduct(candidate.product);
  const sellerName = request.sellerName?.trim() || fields.sellerName;
  if (!sellerName) {
    return agentInternalFailure(
      "SELLER_NAME_REQUIRED",
      `상품명 「${fields.name.slice(0, MAX_LISTED_NAME_CHARS)}」에서 셀러 이름을 찾지 못했습니다. sellerName 을 넣어 주세요.`,
    );
  }

  const { rows } = buildStoreMappingRows(detailBody);
  // 옵션이 하나도 없으면 등록 창 기본값(상품명 한 줄, 가격 0)과 같게 둔다.
  const mappings =
    rows.length > 0
      ? rows.map(({ productName, optionName, price }) => ({ productName, optionName, price }))
      : [{ productName: fields.name, optionName: "", price: 0 }];
  if (mappings.length > MAX_ORDER_CAMPAIGN_DRAFT_ROWS) {
    return agentInternalFailure(
      "OPTIONS_TOO_LARGE",
      `스토어 옵션이 ${mappings.length}줄이라 봇 기안 상한(${MAX_ORDER_CAMPAIGN_DRAFT_ROWS}줄)을 넘습니다. 화면에서 등록해 주세요.`,
    );
  }

  const productNos = [...new Set([candidate.productId, candidate.channelProductNo])];
  let sameProductCampaigns: Awaited<ReturnType<OrderCampaignDraftDeps["findCampaignsByProductNos"]>>;
  try {
    sameProductCampaigns = await deps.findCampaignsByProductNos(productNos);
  } catch (error) {
    console.error("[agent-internal] order campaign draft same-product lookup failed:", describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `같은 상품 캠페인 조회에 실패했습니다: ${describeError(error)}`);
  }
  const brand = brandPick.brand;
  const parsed = orderCampaignDraftDataSchema.safeParse({
    productId: candidate.productId,
    channelProductNo: candidate.channelProductNo,
    name: fields.name,
    sellerName,
    template: brand?.slug ?? null,
    templateName: brand?.displayName ?? null,
    toEmail: brand?.toEmail ?? null,
    ccEmail: brand?.ccEmail ?? null,
    thumbnailUrl: fields.thumbnailUrl || null,
    category: fields.category || null,
    productStatus: fields.productStatus || null,
    salePeriod: fields.salePeriod || null,
    mappings,
    sameProductCampaigns,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return agentInternalFailure(
      "OPTIONS_TOO_LARGE",
      `스토어 값이 봇 기안 한도를 넘습니다(${issue?.path.join(".") ?? "?"}). 화면에서 등록해 주세요.`,
    );
  }
  return { ok: true, data: parsed.data };
}
