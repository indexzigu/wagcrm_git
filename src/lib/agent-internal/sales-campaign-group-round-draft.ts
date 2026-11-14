import { getPrisma } from "@/lib/prisma";
import { deriveOrderCampaignFieldsFromProduct } from "@/lib/order-converter/order-campaign-create";
import { buildSmartstoreProductUrl } from "@/lib/order-converter/naver-review-scrape";
import { generateCampaignName } from "@/lib/campaign-name";
import { toKstYmd } from "@/lib/date-utils";
import { toKstDateStr } from "@/lib/campaign-row";
import {
  MAX_SALES_GROUP_ROUND_MEMBERS,
  MAX_SALES_GROUP_ROUND_OTHER_LINKED,
  MAX_SALES_ROUND_CAMPAIGN_ITEMS,
  SALES_ROUND_CHANNELS,
} from "@/lib/agent-worker/contracts";
import { pickProduct } from "./order-campaign-draft";
import {
  expectedRoundNumber,
  listRoundsFromDb,
  listStoreProducts,
  parseStoreSalePeriod,
  previousRoundSelect,
  statusForPeriod,
  toPreviousRound,
  type PreviousRound,
  type RoundSummary,
} from "./sales-campaign-round-draft";
import {
  agentInternalFailure,
  salesCampaignGroupRoundDraftDataSchema,
  type AgentInternalFailure,
  type SalesCampaignGroupRoundDraftData,
  type SalesCampaignGroupRoundDraftRequest,
} from "./api-contract";

/**
 * 판매캠페인 **그룹** 다음 회차 기안의 초안 — 봇 내부 창구용(2026-11-14). **읽기만 한다**.
 *
 * 지난 회차가 캠페인 그룹(셀러 1명 × 판매 조건 여럿)이면 그룹 안 캠페인마다 판매 조건·채널·마진·하위품목을 잇고,
 * 이번 회차의 스토어 상품 하나에서 기간·링크를 읽어 모두에 같이 쓴다(조합 캠페인은 스토어 상품 하나를 함께 판다).
 *
 * 지난 그룹 찾기 — `previousCampaignId`(그룹 안 아무 캠페인)가 있으면 그 그룹, 없으면 **같은 스토어 상품번호의
 * 주문캠페인에 연결된 가장 최근 그룹**이다. 오너가 「이 주문캠페인 참고, 이전 회차 그룹 참고」라고 말할 때 봇은
 * 그룹 id 를 볼 길이 없으므로(조회 결과에 없다) 상품으로 찾는다. 같은 상품번호를 회차마다 다시 쓰는 운영이라
 * 이 연결이 지난 회차를 가리킨다.
 *
 * 연결할 주문캠페인은 같은 상품번호의 판매 중 주문캠페인 중 가장 최근 것이다 — 단건 회차와 달리 **이미 다른
 * 판매캠페인에 붙어 있어도** 고른다(그룹은 한 주문캠페인을 여럿이 함께 쓰고, 오너가 미리 만든 자리 캠페인이 붙어 있을
 * 수 있다). 이미 붙은 판매캠페인은 `otherLinkedCampaigns` 로 승인자에게 보여 준다. 단 **그 주문캠페인에 이전 그룹 캠페인이
 * 붙어 있으면 연결하지 않는다**(`linkOrderCampaign` null, 붙은 캠페인은 그대로 `otherLinkedCampaigns` 로 보여 준다) —
 * 이번 회차용 주문캠페인이 아직 없다는 뜻이고, 승인 뒤 자동 연결이 그 주문캠페인을 다시 채점하면 새 캠페인이 옵션을
 * 가져가 이전 회차 캠페인의 주문 연결이 풀릴 수 있다(코드 리뷰 2026-11-14). 더 오래된 주문캠페인으로 내려가 고르지도
 * 않는다 — 그것은 더 이전 회차의 것이다. 실제 연결은 승인 뒤 옵션 점수 자동 연결(`autoMapOrderCampaign`)이
 * 한다 — 화면 등록과 같은 경로다.
 *
 * ## Fixie(네이버 프록시) 요청 수 — 기안 1건당 0~1건
 * 상품 목록 1건(`searchNaverProducts`, 60초 공유 캐시). 그룹 멤버 수와 무관하다.
 */

export type PreviousGroup = { id: string; name: string | null; members: PreviousRound[] };

export type LinkedCampaign = { id: string; name: string | null; startDate: string; endDate: string };

export type SalesCampaignGroupRoundDraftDeps = {
  /** 캠페인의 그룹 id. 캠페인이 없으면 undefined, 그룹이 없으면 null. */
  findGroupIdOfCampaign: (campaignId: string) => Promise<string | null | undefined>;
  /** 이 상품번호들의 주문캠페인에 연결된 판매캠페인이 속한 가장 최근(시작일) 그룹 id. */
  findLatestGroupIdByProduct: (productNos: ReadonlyArray<string>) => Promise<string | null>;
  loadGroup: (groupId: string) => Promise<PreviousGroup | null>;
  listProducts: () => Promise<ReadonlyArray<unknown>>;
  listRounds: (dealId: string, sellerId: string) => Promise<RoundSummary[]>;
  /** 이 상품번호들의 판매 중 주문캠페인 중 가장 최근 것(연결 여부 무관). */
  findOrderCampaign: (productNos: ReadonlyArray<string>) => Promise<{ id: string; name: string } | null>;
  /** 이 주문캠페인에 이미 연결된 판매캠페인(최근 시작일 먼저, 상한까지). */
  listLinkedCampaigns: (orderCampaignId: string) => Promise<LinkedCampaign[]>;
  today: () => string;
};

const defaultDeps: SalesCampaignGroupRoundDraftDeps = {
  findGroupIdOfCampaign: async (campaignId) => {
    const row = await getPrisma().salesCampaign.findUnique({ where: { id: campaignId }, select: { groupId: true } });
    return row ? row.groupId : undefined;
  },
  findLatestGroupIdByProduct: async (productNos) => {
    const row = await getPrisma().salesCampaign.findFirst({
      where: { groupId: { not: null }, orderCampaign: { productId: { in: [...productNos] } } },
      select: { groupId: true },
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    });
    return row?.groupId ?? null;
  },
  loadGroup: async (groupId) => {
    const group = await getPrisma().campaignGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        members: {
          select: previousRoundSelect,
          orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
          take: MAX_SALES_GROUP_ROUND_MEMBERS + 1,
        },
      },
    });
    if (!group) return null;
    return { id: group.id, name: group.name, members: group.members.map(toPreviousRound) };
  },
  listProducts: listStoreProducts,
  listRounds: listRoundsFromDb,
  findOrderCampaign: async (productNos) =>
    getPrisma().orderCampaign.findFirst({
      where: { productId: { in: [...productNos] }, isActive: true },
      select: { id: true, name: true },
      orderBy: { createdAt: "desc" },
    }),
  listLinkedCampaigns: async (orderCampaignId) => {
    const rows = await getPrisma().salesCampaign.findMany({
      where: { orderCampaignId },
      select: { id: true, campaignName: true, startDate: true, endDate: true },
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      take: MAX_SALES_GROUP_ROUND_OTHER_LINKED,
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.campaignName,
      startDate: toKstDateStr(row.startDate) ?? "",
      endDate: toKstDateStr(row.endDate) ?? "",
    }));
  },
  today: () => toKstYmd(new Date()),
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ProductPick = Extract<ReturnType<typeof pickProduct>, { ok: true }>;

const SALES_CHANNEL_SET = new Set<string>(SALES_ROUND_CHANNELS);

export type SalesCampaignGroupRoundDraftResult =
  | { ok: true; data: SalesCampaignGroupRoundDraftData }
  | AgentInternalFailure;

export async function buildSalesCampaignGroupRoundDraft(
  request: SalesCampaignGroupRoundDraftRequest,
  deps: SalesCampaignGroupRoundDraftDeps = defaultDeps,
): Promise<SalesCampaignGroupRoundDraftResult> {
  const fail = (step: string, error: unknown): AgentInternalFailure => {
    console.error(`[agent-internal] sales group round draft ${step} failed:`, describeError(error));
    return agentInternalFailure("STORE_FETCH_FAILED", `${step} 조회에 실패했습니다: ${describeError(error)}`);
  };
  const inputTarget = request.productQuery
    ? { productQuery: request.productQuery }
    : request.productId
      ? { productId: request.productId }
      : null;

  // 상품 목록은 지목이 있으면 그룹 찾기 전에 필요하고, 없어도 지난 그룹 상품으로 고를 때 필요하다 — 한 번만 부른다.
  let products: ReadonlyArray<unknown> | null = null;
  const loadProducts = async (): Promise<ReadonlyArray<unknown>> => {
    products ??= await deps.listProducts();
    return products;
  };

  // 1) 지난 그룹.
  let groupId: string | null | undefined;
  let inputPick: ProductPick | null = null;
  try {
    if (request.previousCampaignId) {
      groupId = await deps.findGroupIdOfCampaign(request.previousCampaignId);
      if (groupId === undefined) {
        return agentInternalFailure(
          "CAMPAIGN_NOT_FOUND",
          `지난 회차 캠페인(${request.previousCampaignId})이 없습니다. get_campaign_items 로 캠페인 id 를 다시 확인해 주세요.`,
        );
      }
      if (groupId === null) {
        return agentInternalFailure(
          "PREVIOUS_GROUP_NOT_FOUND",
          "지목한 지난 회차 캠페인은 캠페인 그룹에 속하지 않습니다. 캠페인 하나만 이을 때는 create_sales_campaign_round 를 쓰세요.",
        );
      }
    } else if (inputTarget) {
      const result = pickProduct(await loadProducts(), inputTarget);
      if (!result.ok) return result;
      inputPick = result;
      const { productId, channelProductNo } = result.candidate;
      groupId = await deps.findLatestGroupIdByProduct([...new Set([productId, channelProductNo])]);
      if (!groupId) {
        return agentInternalFailure(
          "PREVIOUS_GROUP_NOT_FOUND",
          `스토어 상품 「${deriveOrderCampaignFieldsFromProduct(inputPick.candidate.product).name.slice(0, 40)}」를 썼던 지난 캠페인 그룹이 없습니다. get_campaign_items 로 지난 회차 캠페인을 찾아 previousCampaignId 로 넣어 주세요.`,
        );
      }
    }
  } catch (error) {
    return fail(request.previousCampaignId ? "지난 그룹" : "스토어 상품", error);
  }

  let group: PreviousGroup | null;
  try {
    group = groupId ? await deps.loadGroup(groupId) : null;
  } catch (error) {
    return fail("지난 그룹", error);
  }
  if (!group || group.members.length < 2) {
    return agentInternalFailure("PREVIOUS_GROUP_NOT_FOUND", "지난 캠페인 그룹을 찾지 못했거나 그룹에 캠페인이 둘 미만입니다.");
  }
  const dealIds = group.members.map((member) => member.dealId);
  if (new Set(dealIds).size !== dealIds.length) {
    // 같은 판매 조건 캠페인이 그룹에 둘이면 같은 판매 조건·같은 기간 캠페인이 둘 생긴다 — 봇이 고를 수 없다.
    return agentInternalFailure(
      "OPTIONS_TOO_LARGE",
      `지난 그룹 「${group.name ?? group.id}」에 같은 판매 조건 캠페인이 둘 이상 있어 봇이 이을 수 없습니다. 화면에서 등록해 주세요.`,
    );
  }
  if (group.members.length > MAX_SALES_GROUP_ROUND_MEMBERS) {
    return agentInternalFailure(
      "OPTIONS_TOO_LARGE",
      `지난 그룹의 캠페인이 ${MAX_SALES_GROUP_ROUND_MEMBERS}개를 넘어 봇 기안 상한을 넘습니다. 화면에서 등록해 주세요.`,
    );
  }

  // 2) 이번 회차 스토어 상품 — 입력 지목, 없으면 지난 그룹 캠페인에 연결된 상품.
  let pick: ProductPick;
  let productSource: "INPUT" | "PREVIOUS_ROUND" = "INPUT";
  if (inputPick) {
    pick = inputPick;
  } else {
    const fallback = inputTarget ?? (() => {
      const linked = group.members.find((member) => member.linkedProductId)?.linkedProductId;
      return linked ? { productId: linked } : null;
    })();
    if (!fallback) {
      return agentInternalFailure(
        "PRODUCT_REQUIRED",
        `지난 그룹 「${group.name ?? group.id}」에 연결된 스토어 상품이 없습니다. productQuery(상품명 일부)나 productId 로 이번 회차 상품을 지목해 주세요.`,
      );
    }
    productSource = inputTarget ? "INPUT" : "PREVIOUS_ROUND";
    let result: ReturnType<typeof pickProduct>;
    try {
      result = pickProduct(await loadProducts(), fallback);
    } catch (error) {
      return fail("스토어 상품", error);
    }
    if (!result.ok) return result;
    pick = result;
  }
  const candidate = pick.candidate;
  const fields = deriveOrderCampaignFieldsFromProduct(candidate.product);
  const productNos = [...new Set([candidate.productId, candidate.channelProductNo])];

  // 3) 기간.
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

  // 4) 멤버별 회차·중복, 주문캠페인 연결.
  const members = [];
  let linkOrderCampaign: { id: string; name: string } | null;
  let otherLinkedCampaigns: LinkedCampaign[];
  try {
    for (const member of group.members) {
      if (member.items.length > MAX_SALES_ROUND_CAMPAIGN_ITEMS) {
        return agentInternalFailure(
          "OPTIONS_TOO_LARGE",
          `지난 회차 「${member.campaignName ?? member.dealName}」의 하위품목이 ${member.items.length}줄이라 봇 기안 상한(${MAX_SALES_ROUND_CAMPAIGN_ITEMS}줄)을 넘습니다. 화면에서 등록해 주세요.`,
        );
      }
      const rounds = await deps.listRounds(member.dealId, member.sellerId);
      const duplicate = rounds.find((round) => round.startDate === period.startDate && round.endDate === period.endDate);
      if (duplicate) {
        return agentInternalFailure(
          "ROUND_ALREADY_EXISTS",
          `같은 기간(${period.startDate} ~ ${period.endDate})의 캠페인 「${duplicate.name ?? duplicate.id}」가 이미 있습니다.`,
        );
      }
      const round = expectedRoundNumber(rounds, period.startDate);
      members.push({
        previousCampaignId: member.id,
        previousCampaignName: member.campaignName,
        dealId: member.dealId,
        dealName: member.dealName,
        salesChannel: SALES_CHANNEL_SET.has(member.salesChannel) ? member.salesChannel : "UNSPECIFIED",
        isManualMargin: member.isManualMargin,
        totalMarginRate: member.totalMarginRate,
        sellerMarginRate: member.sellerMarginRate,
        campaignItems: member.items,
        expectedRoundNumber: round,
        expectedCampaignName: generateCampaignName(member.dealName, member.sellerName, round),
      });
    }
    const latestOrderCampaign = await deps.findOrderCampaign(productNos);
    otherLinkedCampaigns = latestOrderCampaign ? await deps.listLinkedCampaigns(latestOrderCampaign.id) : [];
    const previousIds = new Set(group.members.map((member) => member.id));
    linkOrderCampaign = otherLinkedCampaigns.some((campaign) => previousIds.has(campaign.id)) ? null : latestOrderCampaign;
  } catch (error) {
    return fail("회차", error);
  }

  const first = group.members[0];
  const parsed = salesCampaignGroupRoundDraftDataSchema.safeParse({
    previousGroupId: group.id,
    previousGroupName: group.name,
    sellerId: first.sellerId,
    sellerName: first.sellerName,
    members,
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
    linkOrderCampaign,
    otherLinkedCampaigns,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    console.error("[agent-internal] sales group round draft failed validation:", issue?.path.join("."), issue?.message);
    return agentInternalFailure(
      "OPTIONS_TOO_LARGE",
      `초안 값이 봇 기안 한도를 넘습니다(${issue?.path.join(".") ?? "?"}). 화면에서 등록해 주세요.`,
    );
  }
  return { ok: true, data: parsed.data };
}
