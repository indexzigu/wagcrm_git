import { getPrisma } from "@/lib/prisma";
import { apiRequest } from "@/lib/order-converter/naver-commerce-client";
import { searchNaverProducts } from "@/lib/order-converter/naver-commerce-api";
import { buildStoreMappingRows } from "@/lib/order-converter/store-option-rows";
import { findCampaignChannelProduct } from "@/lib/order-converter/store-channel-product";
import { deriveOrderCampaignFieldsFromProduct } from "@/lib/order-converter/order-campaign-create";
import { listOrderBrands, type OrderBrand } from "@/lib/order-converter/order-brand";
import {
  MAX_ORDER_CAMPAIGN_DRAFT_ROWS,
  MAX_MAPPING_BRAND_CODE_CHARS,
  MAX_SAME_PRODUCT_CAMPAIGNS,
  normalizeMappingOptionName,
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
 * ## 상품코드 이어받기(2026-11-14)
 * 상품코드는 거래처 코드표에서 오므로 네이버에 없다. 같은 상품을 회차마다 다시 파는 일이 흔해, 지난 주문캠페인에서
 * **옵션명이 같은 줄**의 코드를 가져온다(`inheritBrandCodes`). 출처는 하나만 쓴다:
 *  ① 같은 스토어 상품(상품번호)의 지난 주문캠페인 중 코드가 있는 가장 최근 것.
 *  ② ①이 없을 때만 — 과거 전체 매핑에서 같은 옵션명에 코드가 **하나로 정해진** 줄. 같은 옵션명이라도 다른 스토어
 *     상품에서 코드가 달랐던 실례가 있어(운영 실측) 갈리면 비운다. 결재함에 출처 종류를 따로 보인다.
 * 가격은 가져오지 않는다(언제나 스토어 값). 모두 DB 조회라 Fixie 요청은 늘지 않는다.
 *
 * ⛔ 상품명 일부가 여러 상품에 걸리면 **고르지 않는다** — 후보 이름·번호를 돌려줘 오너가 고르게 한다(봇이 사람
 *    확인 없이 쓰므로 `findCampaignChannelProduct` 와 같이 추측하지 않는다). 상품명이 질의와 정확히 같은 후보가
 *    하나뿐일 때만 그 하나를 고른다.
 */
export type SameProductCampaign = { id: string; name: string; isActive: boolean };

/** 코드가 있는 지난 매핑 줄. */
export type CodedMappingRow = { optionName: string; brandCode: string };

export type BrandCodeSource = {
  kind: "SAME_PRODUCT" | "SAME_OPTION";
  orderCampaignId: string | null;
  orderCampaignName: string | null;
  inheritedRows: number;
};

export type OrderCampaignDraftDeps = {
  /** 상품 목록 원소 배열(`searchNaverProducts().contents`). */
  listProducts: () => Promise<ReadonlyArray<unknown>>;
  /** 채널상품 상세 응답 본문. */
  fetchChannelProduct: (channelProductNo: string) => Promise<unknown>;
  listOrderBrands: () => Promise<ReadonlyArray<Pick<OrderBrand, "slug" | "displayName" | "toEmail" | "ccEmail">>>;
  findCampaignsByProductNos: (productNos: ReadonlyArray<string>) => Promise<SameProductCampaign[]>;
  /** 같은 상품번호의 주문캠페인 중 코드 있는 줄이 있는 가장 최근 것과 그 코드 줄. */
  findLatestCodedCampaign: (
    productNos: ReadonlyArray<string>,
  ) => Promise<{ id: string; name: string; rows: CodedMappingRow[] } | null>;
  /** 이 옵션명(저장 글자 그대로)들의 코드 있는 매핑 줄 — 모든 주문캠페인에서. */
  findCodedRowsByOptionNames: (optionNames: ReadonlyArray<string>) => Promise<CodedMappingRow[]>;
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
  findLatestCodedCampaign: async (productNos) => {
    const campaign = await getPrisma().orderCampaign.findFirst({
      where: { productId: { in: [...productNos] }, mappings: { some: { brandCode: { not: "" } } } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        mappings: { where: { brandCode: { not: "" } }, select: { optionName: true, brandCode: true } },
      },
    });
    return campaign ? { id: campaign.id, name: campaign.name, rows: campaign.mappings } : null;
  },
  // 저장 글자 그대로 비교되는 조회라 NFC·NFD 두 표기를 함께 찾는다(맥 입력 한글은 NFD 로 저장될 수 있다). 옵션명·코드
  // 짝만 필요하므로 distinct 로 회차 반복을 접고, 상한으로 이력이 길어져도 한 번에 읽는 양을 묶는다.
  findCodedRowsByOptionNames: (optionNames) =>
    getPrisma().productMapping.findMany({
      where: {
        optionName: { in: [...new Set(optionNames.flatMap((name) => [name.normalize("NFC"), name.normalize("NFD")]))] },
        brandCode: { not: "" },
      },
      select: { optionName: true, brandCode: true },
      distinct: ["optionName", "brandCode"],
      take: MAX_CODED_ROWS_LOOKUP,
    }),
};

/** 다른 상품에서 찾는 조회 상한 — 기안 줄 상한(200) × 옵션당 코드 여럿을 넉넉히 덮는다. */
const MAX_CODED_ROWS_LOOKUP = 2000;

/** 옵션명 비교 키 → 코드. 한 키에 코드가 둘 이상이면 그 키는 뺀다(추측하지 않는다). */
function uniqueCodesByOption(rows: ReadonlyArray<CodedMappingRow>): Map<string, string> {
  const codes = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = normalizeMappingOptionName(row.optionName);
    const code = row.brandCode.trim();
    // 공백뿐이거나 계약 상한을 넘는 코드는 쓸 수 없다 — 하나 때문에 기안 전체가 막히지 않게 건너뛴다.
    if (!key || !code || code.length > MAX_MAPPING_BRAND_CODE_CHARS) continue;
    const set = codes.get(key) ?? new Set<string>();
    set.add(code);
    codes.set(key, set);
  }
  const unique = new Map<string, string>();
  for (const [key, set] of codes) if (set.size === 1) unique.set(key, [...set][0]);
  return unique;
}

/**
 * 지난 매핑에서 옵션명이 같은 줄의 상품코드를 붙인다 — 머리 주석의 ①→② 순서. 옵션명이 빈 줄(옵션 없는 상품)은
 * 이어받지 않는다. 붙은 줄이 없으면 출처 null.
 */
export async function inheritBrandCodes<Row extends { optionName: string }>(
  rows: ReadonlyArray<Row>,
  productNos: ReadonlyArray<string>,
  deps: Pick<OrderCampaignDraftDeps, "findLatestCodedCampaign" | "findCodedRowsByOptionNames">,
): Promise<{ rows: Array<Row & { brandCode?: string }>; source: BrandCodeSource | null }> {
  const optionNames = [...new Set(rows.map((row) => row.optionName).filter((name) => name.trim() !== ""))];
  if (optionNames.length === 0) return { rows: [...rows], source: null };

  // 같은 상품 캠페인에 쓸 수 있는 코드가 하나도 없으면(공백뿐 등) 「없음」으로 보고 ②로 넘어간다.
  const latest = await deps.findLatestCodedCampaign(productNos);
  const latestCodes = latest ? uniqueCodesByOption(latest.rows) : new Map<string, string>();
  const sameProduct = latest && latestCodes.size > 0 ? latest : null;
  const kind = sameProduct ? "SAME_PRODUCT" : "SAME_OPTION";
  const codes = sameProduct ? latestCodes : uniqueCodesByOption(await deps.findCodedRowsByOptionNames(optionNames));

  let inheritedRows = 0;
  const withCodes = rows.map((row) => {
    const code = row.optionName.trim() === "" ? undefined : codes.get(normalizeMappingOptionName(row.optionName));
    if (code === undefined) return { ...row };
    inheritedRows += 1;
    return { ...row, brandCode: code };
  });
  if (inheritedRows === 0) return { rows: withCodes, source: null };
  return {
    rows: withCodes,
    source: {
      kind,
      orderCampaignId: sameProduct?.id ?? null,
      orderCampaignName: sameProduct?.name ?? null,
      inheritedRows,
    },
  };
}

/** 후보 안내 문구에 싣는 후보 수와 이름 길이 — 실패 문구 상한(300자) 안에 들어가게 한다. */
const MAX_LISTED_CANDIDATES = 4;
const MAX_LISTED_NAME_CHARS = 40;

/** 비교 키 — 유니코드 정규화 + 소문자 + 공백 제거(사람이 띄어쓰기를 다르게 불러도 같은 상품). */
export function productMatchKey(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

/**
 * 질의가 상품명에 걸리는가 — 띄어쓰기를 지운 통째 부분일치, 또는 질의의 낱말이 순서 무관하게 모두 들어 있으면 건다.
 * 사람은 「셀러 브랜드」로 부르지만 상품명 머리는 「[셀러 X 브랜드]」라 통째 일치만으로는 영영 못 찾는다(실사용 실패).
 */
export function productQueryMatches(name: string, query: string): boolean {
  const nameKey = productMatchKey(name);
  if (nameKey.includes(productMatchKey(query))) return true;
  const words = query.normalize("NFC").toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every((word) => nameKey.includes(word));
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

function hasChannel(product: unknown, channelProductNo: string): boolean {
  const channels = (product as { channelProducts?: unknown } | null)?.channelProducts;
  return (
    Array.isArray(channels) &&
    channels.some((c) => {
      const no = (c as { channelProductNo?: unknown } | null)?.channelProductNo;
      return no !== undefined && no !== null && String(no) === channelProductNo;
    })
  );
}

/**
 * 상품 하나 → 기안 후보. `matchedChannelNo` 를 주면(상품번호로 지목한 경우) 그 채널을 쓴다 — 채널이 여럿인 상품에서
 * 첫 채널로 바꿔 치면 지목하지 않은 채널의 옵션을 불러온다(GPT 검수 2026-11-13). 이름·기간 같은 표시 칸은 등록 창과
 * 같게 `deriveOrderCampaignFieldsFromProduct`(첫 채널 기준)에서 온다.
 */
function toCandidate(product: unknown, matchedChannelNo?: string): ProductCandidate | null {
  const first = firstChannel(product);
  if (!first) return null;
  const channel = matchedChannelNo ? { ...first, channelProductNo: matchedChannelNo } : first;
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
    const product = channel ? products.find((p) => hasChannel(p, channel.channelProductNo)) : undefined;
    const candidate = product === undefined || !channel ? null : toCandidate(product, channel.channelProductNo);
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
    if (!productQueryMatches(candidate.name, request.productQuery ?? "")) continue;
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
  let inherited: Awaited<ReturnType<typeof inheritBrandCodes<(typeof mappings)[number]>>>;
  try {
    inherited = await inheritBrandCodes(mappings, productNos, deps);
  } catch (error) {
    console.error("[agent-internal] order campaign draft brand code lookup failed:", describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `지난 주문캠페인 상품코드 조회에 실패했습니다: ${describeError(error)}`);
  }
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
    mappings: inherited.rows,
    sameProductCampaigns,
    brandCodeSource: inherited.source,
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
