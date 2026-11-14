import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { searchNaverProducts } from "@/lib/order-converter/naver-commerce-api";
import { deriveOrderCampaignFieldsFromProduct } from "@/lib/order-converter/order-campaign-create";
import { buildSmartstoreProductUrl } from "@/lib/order-converter/naver-review-scrape";
import { generateCampaignName } from "@/lib/campaign-name";
import { toKstYmd } from "@/lib/date-utils";
import { toKstDateStr } from "@/lib/campaign-row";
import {
  MAX_SALES_ROUND_CAMPAIGN_ITEMS,
  MAX_SALES_ROUND_EXISTING_ROUNDS,
  SALES_ROUND_CHANNELS,
} from "@/lib/agent-worker/contracts";
import { pickProduct } from "./order-campaign-draft";
import {
  agentInternalFailure,
  salesCampaignRoundDraftDataSchema,
  type AgentInternalFailure,
  type SalesCampaignRoundDraftData,
  type SalesCampaignRoundDraftRequest,
} from "./api-contract";

/**
 * 판매캠페인 다음 회차 기안의 **초안** — 봇 내부 창구용(2026-11-14). **읽기만 한다**.
 *
 * 이전 회차(판매 조건·셀러·채널·마진·하위품목)를 그대로 잇고, 이번 회차의 스토어 상품에서 기간·링크를 읽는다.
 * 상품 고르기는 주문캠페인 초안과 같은 `pickProduct`(상품명 일부가 여러 상품에 걸리면 고르지 않고 후보를 돌려준다),
 * 기간 판정은 등록 창과 같은 `deriveOrderCampaignFieldsFromProduct().salePeriod`(네이버가 합성한 14일 기본 기간은
 * 「미등록」)이다 — 같은 상품을 두 화면이 다르게 읽지 않게 한다.
 *
 * ## Fixie(네이버 프록시) 요청 수 — 기안 1건당 0~1건
 * 상품 목록 1건(`searchNaverProducts`, 60초 공유 캐시라 화면·다른 기안이 방금 불렀으면 0). 판매 기간은 목록 원소에
 * 이미 있어 채널상품 상세는 부르지 않는다.
 *
 * 회차 번호·이름은 미리보기용 예상치다 — 저장은 승인 때 `recalculateCampaignRounds` 가 시작일 순서로 다시 붙인다.
 */

export type PreviousRound = {
  id: string;
  campaignName: string | null;
  dealId: string;
  sellerId: string;
  salesChannel: string;
  isManualMargin: boolean;
  totalMarginRate: number;
  sellerMarginRate: number;
  dealName: string;
  sellerName: string;
  /** 이전 회차에 연결된 주문캠페인의 스토어 상품번호(없으면 null). */
  linkedProductId: string | null;
  items: ReadonlyArray<{
    dealId: string;
    dealName: string;
    feeRate: number | null;
    sellerMarginRate: number | null;
    costPrice: number | null;
    sellingPrice: number | null;
  }>;
};

export type RoundSummary = { id: string; name: string | null; startDate: string; endDate: string };

export type SalesCampaignRoundDraftDeps = {
  loadPreviousRound: (campaignId: string) => Promise<PreviousRound | null>;
  /** 상품 목록 원소 배열(`searchNaverProducts().contents`). */
  listProducts: () => Promise<ReadonlyArray<unknown>>;
  /** 같은 판매 조건·셀러의 캠페인 전부(시작일 오름차순). */
  listRounds: (dealId: string, sellerId: string) => Promise<RoundSummary[]>;
  /** 이 상품번호들의 판매 중 주문캠페인 중 아직 어느 판매캠페인에도 연결되지 않은 가장 최근 것. */
  findUnlinkedOrderCampaign: (productNos: ReadonlyArray<string>) => Promise<{ id: string; name: string } | null>;
  /** KST 오늘(YYYY-MM-DD). */
  today: () => string;
};

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** 이전 회차 한 건을 읽는 칸 — 그룹 회차 초안(`sales-campaign-group-round-draft.ts`)도 같은 칸으로 멤버를 읽는다. */
export const previousRoundSelect = {
  id: true,
  campaignName: true,
  dealId: true,
  sellerId: true,
  salesChannel: true,
  isManualMargin: true,
  totalMarginRate: true,
  sellerMarginRate: true,
  deal: { select: { dealName: true } },
  seller: { select: { name: true, alias: true } },
  orderCampaign: { select: { productId: true } },
  campaignDeals: {
    orderBy: { createdAt: "asc" },
    select: {
      dealId: true,
      feeRate: true,
      sellerMarginRate: true,
      costPrice: true,
      sellingPrice: true,
      deal: { select: { dealName: true } },
    },
  },
} satisfies Prisma.SalesCampaignSelect;

type PreviousRoundRow = Prisma.SalesCampaignGetPayload<{ select: typeof previousRoundSelect }>;

export function toPreviousRound(row: PreviousRoundRow): PreviousRound {
  return {
    id: row.id,
    campaignName: row.campaignName,
    dealId: row.dealId,
    sellerId: row.sellerId,
    salesChannel: row.salesChannel,
    isManualMargin: row.isManualMargin,
    totalMarginRate: toNumber(row.totalMarginRate) ?? 0,
    sellerMarginRate: toNumber(row.sellerMarginRate) ?? 0,
    dealName: row.deal.dealName,
    // 셀러 표기는 별칭 우선(P2 Seller Alias Priority) — 캠페인 이름 조합과 같다.
    sellerName: row.seller.alias || row.seller.name,
    linkedProductId: row.orderCampaign?.productId?.trim() || null,
    items: row.campaignDeals.map((cd) => ({
      dealId: cd.dealId,
      dealName: cd.deal.dealName,
      feeRate: toNumber(cd.feeRate),
      sellerMarginRate: toNumber(cd.sellerMarginRate),
      costPrice: toNumber(cd.costPrice),
      sellingPrice: toNumber(cd.sellingPrice),
    })),
  };
}

/** 같은 판매 조건·셀러의 캠페인 전부(시작일 오름차순) — 회차 예상·같은 기간 중복 판정용. */
export async function listRoundsFromDb(dealId: string, sellerId: string): Promise<RoundSummary[]> {
  const rows = await getPrisma().salesCampaign.findMany({
    where: { dealId, sellerId },
    select: { id: true, campaignName: true, startDate: true, endDate: true },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.campaignName,
    startDate: toKstDateStr(row.startDate) ?? "",
    endDate: toKstDateStr(row.endDate) ?? "",
  }));
}

/** 스토어 상품 목록 원소 배열(`searchNaverProducts().contents`, 60초 공유 캐시). */
export async function listStoreProducts(): Promise<ReadonlyArray<unknown>> {
  const data = await searchNaverProducts();
  return Array.isArray(data?.contents) ? data.contents : [];
}

const defaultDeps: SalesCampaignRoundDraftDeps = {
  loadPreviousRound: async (campaignId) => {
    const row = await getPrisma().salesCampaign.findUnique({ where: { id: campaignId }, select: previousRoundSelect });
    return row ? toPreviousRound(row) : null;
  },
  listProducts: listStoreProducts,
  listRounds: listRoundsFromDb,
  findUnlinkedOrderCampaign: async (productNos) =>
    getPrisma().orderCampaign.findFirst({
      where: { productId: { in: [...productNos] }, isActive: true, salesCampaigns: { none: {} } },
      select: { id: true, name: true },
      orderBy: { createdAt: "desc" },
    }),
  today: () => toKstYmd(new Date()),
};

/** 등록 창 기간 문구 `YYYY.MM.DD ~ YYYY.MM.DD` → 두 날짜. 「미등록」·「기간 미정」·「~ 계속」은 null(쓸 기간이 없다). */
export function parseStoreSalePeriod(salePeriod: string): { startDate: string; endDate: string } | null {
  const match = salePeriod.match(/^(\d{4})\.(\d{2})\.(\d{2}) ~ (\d{4})\.(\d{2})\.(\d{2})$/);
  if (!match) return null;
  return { startDate: `${match[1]}-${match[2]}-${match[3]}`, endDate: `${match[4]}-${match[5]}-${match[6]}` };
}

/** 새 회차 상태 — 시작 전이면 준비, 기간 안이면 판매 중, 이미 끝났으면 판매 종료(날짜를 직접 받은 경우만 생긴다). */
export function statusForPeriod(startDate: string, endDate: string, today: string): "PREPARATION" | "ACTIVE" | "CLOSED" {
  if (today < startDate) return "PREPARATION";
  if (today <= endDate) return "ACTIVE";
  return "CLOSED";
}

/** 승인 때 `recalculateCampaignRounds` 가 붙일 회차 예상 — 시작일 오름차순, 같은 날이면 먼저 만든 것이 앞(새 회차는 맨 뒤). */
export function expectedRoundNumber(existing: ReadonlyArray<RoundSummary>, startDate: string): number | null {
  if (existing.length === 0) return null;
  return existing.filter((round) => round.startDate <= startDate).length + 1;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SALES_CHANNEL_SET = new Set<string>(SALES_ROUND_CHANNELS);

export type SalesCampaignRoundDraftResult = { ok: true; data: SalesCampaignRoundDraftData } | AgentInternalFailure;

export async function buildSalesCampaignRoundDraft(
  request: SalesCampaignRoundDraftRequest,
  deps: SalesCampaignRoundDraftDeps = defaultDeps,
): Promise<SalesCampaignRoundDraftResult> {
  let previous: PreviousRound | null;
  try {
    previous = await deps.loadPreviousRound(request.previousCampaignId);
  } catch (error) {
    console.error("[agent-internal] sales round draft previous lookup failed:", describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `이전 회차 조회에 실패했습니다: ${describeError(error)}`);
  }
  if (!previous) {
    return agentInternalFailure(
      "CAMPAIGN_NOT_FOUND",
      `이전 회차 캠페인(${request.previousCampaignId})이 없습니다. get_campaign_items 로 캠페인 id 를 다시 확인해 주세요.`,
    );
  }

  // 상품 지목 — 입력이 있으면 그것, 없으면 이전 회차의 주문캠페인 상품.
  const productTarget = request.productQuery
    ? { productQuery: request.productQuery }
    : request.productId
      ? { productId: request.productId }
      : previous.linkedProductId
        ? { productId: previous.linkedProductId }
        : null;
  if (!productTarget) {
    return agentInternalFailure(
      "PRODUCT_REQUIRED",
      `이전 회차 「${previous.campaignName ?? previous.dealName}」에 연결된 스토어 상품이 없습니다. productQuery(상품명 일부)나 productId 로 이번 회차 상품을 지목해 주세요.`,
    );
  }
  const productSource = request.productQuery || request.productId ? "INPUT" : "PREVIOUS_ROUND";

  let products: ReadonlyArray<unknown>;
  try {
    products = await deps.listProducts();
  } catch (error) {
    console.error("[agent-internal] sales round draft product list failed:", describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `스토어 상품 조회에 실패했습니다: ${describeError(error)}`);
  }
  const pick = pickProduct(products, productTarget);
  if (!pick.ok) return pick;
  const candidate = pick.candidate;
  const fields = deriveOrderCampaignFieldsFromProduct(candidate.product);

  // 기간 — 입력 날짜가 있으면 그것, 없으면 스토어 판매 기간(쓸 수 없거나 이미 끝났으면 날짜를 받아 오게 한다).
  const today = deps.today();
  let period: { startDate: string; endDate: string };
  let dateSource: "STORE" | "INPUT";
  if (request.startDate && request.endDate) {
    period = { startDate: request.startDate, endDate: request.endDate };
    dateSource = "INPUT";
  } else {
    const store = parseStoreSalePeriod(fields.salePeriod);
    if (!store || store.endDate < today) {
      return agentInternalFailure(
        "SALE_PERIOD_UNAVAILABLE",
        store
          ? `스토어 상품 「${fields.name.slice(0, 40)}」의 판매 기간(${fields.salePeriod})이 이미 끝났습니다. 이번 회차 날짜를 startDate/endDate 로 넣어 주세요.`
          : `스토어 상품 「${fields.name.slice(0, 40)}」에 쓸 판매 기간이 없습니다(${fields.salePeriod}). 이번 회차 날짜를 startDate/endDate 로 넣어 주세요.`,
      );
    }
    period = store;
    dateSource = "STORE";
  }

  let rounds: RoundSummary[];
  let linkOrderCampaign: { id: string; name: string } | null;
  try {
    rounds = await deps.listRounds(previous.dealId, previous.sellerId);
    linkOrderCampaign = await deps.findUnlinkedOrderCampaign([...new Set([candidate.productId, candidate.channelProductNo])]);
  } catch (error) {
    console.error("[agent-internal] sales round draft round lookup failed:", describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `회차 조회에 실패했습니다: ${describeError(error)}`);
  }
  const duplicate = rounds.find((round) => round.startDate === period.startDate && round.endDate === period.endDate);
  if (duplicate) {
    return agentInternalFailure(
      "ROUND_ALREADY_EXISTS",
      `같은 기간(${period.startDate} ~ ${period.endDate})의 캠페인 「${duplicate.name ?? duplicate.id}」가 이미 있습니다.`,
    );
  }
  if (previous.items.length > MAX_SALES_ROUND_CAMPAIGN_ITEMS) {
    return agentInternalFailure(
      "OPTIONS_TOO_LARGE",
      `이전 회차 하위품목이 ${previous.items.length}줄이라 봇 기안 상한(${MAX_SALES_ROUND_CAMPAIGN_ITEMS}줄)을 넘습니다. 화면에서 등록해 주세요.`,
    );
  }

  const round = expectedRoundNumber(rounds, period.startDate);
  const parsed = salesCampaignRoundDraftDataSchema.safeParse({
    previousCampaignId: previous.id,
    previousCampaignName: previous.campaignName,
    dealId: previous.dealId,
    dealName: previous.dealName,
    sellerId: previous.sellerId,
    sellerName: previous.sellerName,
    salesChannel: SALES_CHANNEL_SET.has(previous.salesChannel) ? previous.salesChannel : "UNSPECIFIED",
    isManualMargin: previous.isManualMargin,
    totalMarginRate: previous.totalMarginRate,
    sellerMarginRate: previous.sellerMarginRate,
    campaignItems: previous.items,
    product: {
      productId: candidate.productId,
      channelProductNo: candidate.channelProductNo,
      name: fields.name,
      productStatus: fields.productStatus || null,
      salePeriod: fields.salePeriod || null,
      source: productSource,
    },
    baseNaverLink: buildSmartstoreProductUrl(candidate.channelProductNo),
    startDate: period.startDate,
    endDate: period.endDate,
    dateSource,
    status: statusForPeriod(period.startDate, period.endDate, today),
    expectedRoundNumber: round,
    expectedCampaignName: generateCampaignName(previous.dealName, previous.sellerName, round),
    existingRounds: rounds.slice(-MAX_SALES_ROUND_EXISTING_ROUNDS),
    linkOrderCampaign,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    console.error("[agent-internal] sales round draft failed validation:", issue?.path.join("."), issue?.message);
    return agentInternalFailure(
      "OPTIONS_TOO_LARGE",
      `초안 값이 봇 기안 한도를 넘습니다(${issue?.path.join(".") ?? "?"}). 화면에서 등록해 주세요.`,
    );
  }
  return { ok: true, data: parsed.data };
}
