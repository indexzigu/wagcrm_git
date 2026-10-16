import { getPrisma } from "@/lib/prisma";
import { apiRequest } from "@/lib/order-converter/naver-commerce-client";
import { searchNaverProducts } from "@/lib/order-converter/naver-commerce-api";
import { buildStoreMappingRows, type StoreMappingRow } from "@/lib/order-converter/store-option-rows";
import { findCampaignChannelProduct } from "@/lib/order-converter/store-channel-product";
import {
  MAX_STRUCTURED_DATA_BYTES,
  normalizeMappingOptionName,
  storeProductOptionsStructuredDataSchema,
  type StoreProductOptionsStructuredData,
} from "@/lib/agent-worker/contracts";
import { agentInternalFailure, type AgentInternalFailure } from "./api-contract";

/**
 * 주문캠페인 하나의 **네이버 등록 옵션**(캠페인 설정 창 「스토어 옵션 불러오기」와 같은 자료) — 봇 내부 창구용.
 *
 * 순서는 설정 창과 같다: 상품 목록(`searchNaverProducts`, 60초 TTL 공유 캐시) → 캠페인 `productId` 로 채널상품
 * 고르기(`findCampaignChannelProduct`, 설정 창과 같은 판정) → 채널상품 상세 → `buildStoreMappingRows`.
 *
 * ## Fixie(네이버 프록시) 요청 수
 * - 옵션 조회(`loadStoreOptionsFresh`): 상세 1건 + 상품 목록 0~1건(60초 안에 대시보드·설정 창이 이미 불렀으면 0).
 * - 즉시 저장(`loadStoreOptionsForApply`): 같은 캠페인을 `STORE_OPTIONS_REUSE_MS`(10분) 안에 조회했으면 **0건**
 *   — 그 조회 결과로 옵션 글자를 대조한다. 지났으면 조회와 같은 0~2건.
 * ⇒ 봇 매핑 요청 1회(조회 → 「응」 → 저장)는 보통 1~2건이다.
 *
 * ⚠️ 저장 쪽 재사용은 옵션 **글자 대조**에만 쓴다(무엇이 네이버 등록 옵션인가). 지금 매핑 값은 매번 DB 에서 새로
 *    읽는다(`apply-product-mappings.ts`). 10분 안에 스토어 옵션 글자를 바꾸면 옛 글자로 대조된다 — 봇은 그 사이
 *    옛 표를 보여 줬으므로 오너가 본 것과 같은 기준이다.
 */
export const STORE_OPTIONS_REUSE_MS = 10 * 60 * 1000;

export type StoreOptionsSnapshot = {
  orderCampaign: { id: string; name: string };
  productId: string;
  channelProductNo: string;
  productName: string;
  /** 옵션명이 있는 줄만(옵션 없는 상품의 빈 옵션명 줄은 봇이 다룰 수 없어 뺀다). */
  rows: StoreMappingRow[];
};

type CacheEntry = { snapshot: StoreOptionsSnapshot; fetchedAt: number };

export type StoreOptionsDeps = {
  /** 상품 목록 원소 배열(`searchNaverProducts().contents`). */
  listProducts: () => Promise<ReadonlyArray<unknown>>;
  /** 채널상품 상세 응답 본문. */
  fetchChannelProduct: (channelProductNo: string) => Promise<unknown>;
  findOrderCampaign: (id: string) => Promise<{ id: string; name: string; productId: string | null } | null>;
  now: () => number;
};

const defaultDeps: StoreOptionsDeps = {
  listProducts: async () => {
    const data = await searchNaverProducts();
    return Array.isArray(data?.contents) ? data.contents : [];
  },
  fetchChannelProduct: async (channelProductNo) => {
    const res = await apiRequest("GET", `/v2/products/channel-products/${channelProductNo}`, undefined, undefined);
    return res?.data ?? res;
  },
  findOrderCampaign: (id) =>
    getPrisma().orderCampaign.findUnique({ where: { id }, select: { id: true, name: true, productId: true } }),
  now: () => Date.now(),
};

/**
 * 프로세스 안 보관함 — 모듈 지역 변수가 아니라 `globalThis` 인 이유는 `searchNaverProducts` 와 같다: 두 창구는
 * 서로 다른 라우트 번들이라 모듈 인스턴스가 갈릴 수 있고, 갈리면 저장 창구가 조회 창구의 결과를 못 본다.
 * 셀프호스트 앱은 프로세스 하나라 이 보관이 성립한다(여러 인스턴스면 저장 쪽이 다시 조회할 뿐 틀리지 않는다).
 */
function cache(): Map<string, CacheEntry> {
  const g = globalThis as typeof globalThis & { __agentStoreOptionsCache?: Map<string, CacheEntry> };
  if (!g.__agentStoreOptionsCache) g.__agentStoreOptionsCache = new Map();
  return g.__agentStoreOptionsCache;
}

/** 테스트 전용 — 보관함 비우기. */
export function resetStoreOptionsCacheForTest(): void {
  cache().clear();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LoadResult = { ok: true; snapshot: StoreOptionsSnapshot } | AgentInternalFailure;

async function fetchSnapshot(orderCampaignId: string, deps: StoreOptionsDeps): Promise<LoadResult> {
  const campaign = await deps.findOrderCampaign(orderCampaignId);
  if (!campaign) return agentInternalFailure("CAMPAIGN_NOT_FOUND", "주문캠페인을 찾을 수 없습니다.");
  const productId = campaign.productId?.trim() ?? "";
  if (productId === "") {
    return agentInternalFailure(
      "NO_STORE_OPTIONS",
      "캠페인에 스토어 상품이 연결돼 있지 않습니다. CRM 캠페인 설정 창에서 상품을 먼저 연결해 주세요.",
    );
  }

  let detailBody: unknown;
  let channelProductNo: string;
  try {
    const products = await deps.listProducts();
    const target = findCampaignChannelProduct(products, productId);
    if (!target) {
      return agentInternalFailure(
        "NO_STORE_OPTIONS",
        "캠페인에 연결된 상품을 스토어 상품 목록에서 찾지 못했습니다. CRM 캠페인 설정 창에서 상품 연결을 확인해 주세요.",
      );
    }
    channelProductNo = target.channelProductNo;
    detailBody = await deps.fetchChannelProduct(channelProductNo);
  } catch (error) {
    console.error("[agent-internal] store options fetch failed:", describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `스토어 옵션 조회에 실패했습니다: ${describeError(error)}`);
  }

  const { productName, rows } = buildStoreMappingRows(detailBody);
  const named = rows.filter((row) => normalizeMappingOptionName(row.optionName) !== "");
  if (named.length === 0) {
    return agentInternalFailure(
      "NO_STORE_OPTIONS",
      "스토어 상품에 옵션이 없습니다. 옵션 없는 상품의 매핑은 CRM 캠페인 설정 창에서 넣어 주세요.",
    );
  }
  return {
    ok: true,
    snapshot: {
      orderCampaign: { id: campaign.id, name: campaign.name },
      productId,
      channelProductNo,
      productName,
      rows: named,
    },
  };
}

/** 옵션 조회 창구 — 늘 네이버에서 새로 읽고, 저장 창구가 쓰도록 보관한다. */
export async function loadStoreOptionsFresh(
  orderCampaignId: string,
  deps: StoreOptionsDeps = defaultDeps,
): Promise<LoadResult> {
  const result = await fetchSnapshot(orderCampaignId, deps);
  if (result.ok) cache().set(orderCampaignId, { snapshot: result.snapshot, fetchedAt: deps.now() });
  return result;
}

/**
 * 저장 창구 — `STORE_OPTIONS_REUSE_MS` 안의 조회 결과가 있고 캠페인 이름·연결 상품이 그대로면 재사용, 아니면 새로 읽는다.
 * 캠페인 행은 언제나 새로 읽는다(DB 조회, 네이버 호출 아님) — 그 사이 상품 연결을 바꿨으면 보관본을 버린다.
 */
export async function loadStoreOptionsForApply(
  orderCampaignId: string,
  deps: StoreOptionsDeps = defaultDeps,
): Promise<LoadResult> {
  const entry = cache().get(orderCampaignId);
  if (entry && deps.now() - entry.fetchedAt < STORE_OPTIONS_REUSE_MS) {
    const campaign = await deps.findOrderCampaign(orderCampaignId);
    if (!campaign) return agentInternalFailure("CAMPAIGN_NOT_FOUND", "주문캠페인을 찾을 수 없습니다.");
    if ((campaign.productId?.trim() ?? "") === entry.snapshot.productId) {
      return { ok: true, snapshot: { ...entry.snapshot, orderCampaign: { id: campaign.id, name: campaign.name } } };
    }
  }
  return loadStoreOptionsFresh(orderCampaignId, deps);
}

type CurrentMappingRow = { optionName: string; brandCode: string; price: number };

/**
 * 봇에게 줄 표 — 옵션 줄마다 지금 매핑 값(옵션명 비교 키로 맞춤)을 붙인다. 상한을 넘으면 null(호출부가
 * OPTIONS_TOO_LARGE 로 실패시킨다 — 잘라서 주지 않는다).
 */
export function buildStoreProductOptionsData(
  snapshot: StoreOptionsSnapshot,
  currentMappings: ReadonlyArray<CurrentMappingRow>,
): StoreProductOptionsStructuredData | null {
  const byKey = new Map<string, CurrentMappingRow[]>();
  for (const row of currentMappings) {
    const key = normalizeMappingOptionName(row.optionName);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const storeKeys = new Set(snapshot.rows.map((row) => normalizeMappingOptionName(row.optionName)));
  const options = snapshot.rows.map((row) => {
    const matches = byKey.get(normalizeMappingOptionName(row.optionName)) ?? [];
    const single = matches.length === 1 ? matches[0] : null;
    return {
      optionName: row.optionName,
      price: row.price,
      currentBrandCode: single ? single.brandCode : null,
      currentPrice: single ? single.price : null,
      duplicateMappings: matches.length >= 2,
    };
  });
  const mappingsNotInStore = currentMappings.filter(
    (row) => !storeKeys.has(normalizeMappingOptionName(row.optionName)),
  ).length;
  const data = {
    kind: "store_product_options" as const,
    version: 1 as const,
    orderCampaign: snapshot.orderCampaign,
    channelProductNo: snapshot.channelProductNo,
    productName: snapshot.productName,
    options,
    mappingsNotInStore,
  };
  const parsed = storeProductOptionsStructuredDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** 옵션 조회 창구 본체 — 표를 만들어 돌려준다. */
export async function getStoreProductOptions(
  orderCampaignId: string,
  deps: StoreOptionsDeps = defaultDeps,
  readMappings: (campaignId: string) => Promise<CurrentMappingRow[]> = (campaignId) =>
    getPrisma().productMapping.findMany({
      where: { campaignId },
      select: { optionName: true, brandCode: true, price: true },
    }),
): Promise<{ ok: true; data: StoreProductOptionsStructuredData } | AgentInternalFailure> {
  const loaded = await loadStoreOptionsFresh(orderCampaignId, deps);
  if (!loaded.ok) return loaded;
  const data = buildStoreProductOptionsData(loaded.snapshot, await readMappings(orderCampaignId));
  if (!data) {
    return agentInternalFailure(
      "OPTIONS_TOO_LARGE",
      `스토어 옵션 ${loaded.snapshot.rows.length}줄이 봇이 한 번에 받을 수 있는 크기(${MAX_STRUCTURED_DATA_BYTES}바이트)를 넘습니다. CRM 캠페인 설정 창에서 넣어 주세요.`,
    );
  }
  return { ok: true, data };
}
