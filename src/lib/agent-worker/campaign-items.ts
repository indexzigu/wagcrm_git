/**
 * 봇(agent worker)의 `get_campaign_items`(2026-10-27 · T-271) — 판매캠페인과 그 품목·하위품목을 읽는다.
 * 봇이 `add_campaign_items` 기안(판매캠페인 품목에 하위품목 덧붙이기)을 올리기 전에 **지금 상태**를 보려는 조회다
 * (쓰기는 여기 없다 — 기존 결재 파이프라인이 앱 권한으로 한다).
 *
 * 읽는 표: SalesCampaign · Deal · Seller(20260902080000 에서 표 단위 SELECT) + CampaignDeal(칸 단위 SELECT —
 * 20261027120000_grant_agent_worker_campaign_item_reads 의 id·campaignId·dealId 만).
 * ⛔ 그래서 CampaignDeal 호출은 명시 `select` 이고 그 칸은 GRANT 목록 안에 있어야 한다 — 수량·매출·요율 칸은 닫혀
 *    있어 기본 select 는 운영에서 권한 거부(DB_PERMISSION_DENIED)로 끝난다. 관계를 중첩 select 로 읽지 않는 것도 같은
 *    이유다(Prisma 가 덧붙이는 칸을 여기서 통제하지 못한다).
 * ⛔ 행을 펼쳐(`...row`) 넘기지 말 것 — 원가·마진 칸이 검토 없이 슬랙·클라우드 모델로 따라간다. 판매 조건은 이름·
 *    판매가만 내보낸다(원가·수수료율은 싣지 않는다).
 */
import type { PrismaClient } from "@prisma/client";
import { containsSearch, normalizedForms } from "@/lib/prisma-search";
import { sellerDisplayName } from "@/lib/seller-display-name";
import { toKstYmd } from "@/lib/date-utils";
import { buildBoundedSummary, flattenLineBreaks } from "./read-projections";

export type CampaignItemsInput = { campaignId?: string; query?: string };

/** `query` 로 찾을 때 싣는 판매캠페인 수 상한(최근 시작일 순). */
export const MAX_CAMPAIGN_ITEMS_MATCHES = 5;
/** 판매 조건 하나에 싣는 하위품목 수 상한 — 넘으면 정렬 순서 앞쪽을 남기고 `optionsTruncated` 를 켠다. */
export const MAX_OPTIONS_PER_CAMPAIGN = 40;
/** `query` 가 맞힌 판매 조건·셀러 후보 상한 — 너무 넓은 검색어가 캠페인 조회의 IN 목록을 키우지 않게 한다. */
const MAX_QUERY_CANDIDATES = 200;

export type CampaignItemDealView = {
  id: string;
  name: string;
  sellingPrice: number;
  /** 이 판매캠페인의 품목(매출 상세내역 줄)에 이미 있는가. */
  inCampaign: boolean;
};

export type CampaignItemsView = {
  id: string;
  sellerName: string;
  roundNumber: number | null;
  status: string;
  startDate: string;
  endDate: string;
  mainDeal: CampaignItemDealView | null;
  options: CampaignItemDealView[];
  optionsTruncated: boolean;
  /** 품목 줄 수(상위 판매 조건·하위품목 밖의 딜 줄 포함). */
  itemCount: number;
};

export type CampaignItemsResult = { campaigns: CampaignItemsView[]; truncated: boolean };

type Client = Pick<PrismaClient, "salesCampaign" | "deal" | "seller" | "campaignDeal">;

const toPrice = (value: unknown): number => Number(value ?? 0);

export async function readCampaignItems(input: CampaignItemsInput, client: Client): Promise<CampaignItemsResult> {
  const campaignSelect = {
    id: true,
    dealId: true,
    sellerId: true,
    roundNumber: true,
    status: true,
    startDate: true,
    endDate: true,
  } as const;

  let campaigns;
  let truncated = false;
  if (input.campaignId) {
    const row = await client.salesCampaign.findUnique({ where: { id: input.campaignId }, select: campaignSelect });
    campaigns = row ? [row] : [];
  } else {
    // 판매 조건 이름·셀러 이름(별칭 포함) 일부로 찾는다. 관계 필터 대신 id 를 먼저 모은다 — 관계 select 를 쓰지 않는
    // 이 모듈의 규칙과 같은 이유(위 머리 주석). 한글이 조합형(NFD)으로 저장된 이름도 맞도록 두 정규화 형태를 OR 로 묶는다
    // (`order-campaign-mappings.ts` 와 같은 규칙).
    const forms = normalizedForms((input.query ?? "").trim());
    const [deals, sellers] = await Promise.all([
      client.deal.findMany({
        where: { OR: forms.map((form) => ({ dealName: containsSearch(form) })) },
        select: { id: true, parentDealId: true },
        take: MAX_QUERY_CANDIDATES,
      }),
      client.seller.findMany({
        where: { OR: forms.flatMap((form) => [{ name: containsSearch(form) }, { alias: containsSearch(form) }]) },
        select: { id: true },
        take: MAX_QUERY_CANDIDATES,
      }),
    ]);
    // 하위품목 이름으로 찾았으면 그 상위 판매 조건의 캠페인이 대상이다(캠페인은 상위 판매 조건에 걸린다).
    const dealIds = [...new Set(deals.map((deal) => deal.parentDealId ?? deal.id))];
    const sellerIds = sellers.map((seller) => seller.id);
    if (dealIds.length === 0 && sellerIds.length === 0) return { campaigns: [], truncated: false };
    const rows = await client.salesCampaign.findMany({
      where: {
        OR: [
          ...(dealIds.length > 0 ? [{ dealId: { in: dealIds } }] : []),
          ...(sellerIds.length > 0 ? [{ sellerId: { in: sellerIds } }] : []),
        ],
      },
      select: campaignSelect,
      orderBy: [{ startDate: "desc" }, { id: "asc" }],
      take: MAX_CAMPAIGN_ITEMS_MATCHES + 1,
    });
    truncated = rows.length > MAX_CAMPAIGN_ITEMS_MATCHES;
    campaigns = rows.slice(0, MAX_CAMPAIGN_ITEMS_MATCHES);
  }
  if (campaigns.length === 0) return { campaigns: [], truncated };

  const campaignIds = campaigns.map((campaign) => campaign.id);
  const mainDealIds = [...new Set(campaigns.map((campaign) => campaign.dealId))];
  const [items, mainDeals, options, sellers] = await Promise.all([
    // GRANT 칸(id·campaignId·dealId)만.
    client.campaignDeal.findMany({ where: { campaignId: { in: campaignIds } }, select: { campaignId: true, dealId: true } }),
    client.deal.findMany({ where: { id: { in: mainDealIds } }, select: { id: true, dealName: true, sellingPrice: true } }),
    client.deal.findMany({
      where: { parentDealId: { in: mainDealIds }, dealType: "OPTION" },
      select: { id: true, parentDealId: true, dealName: true, sellingPrice: true },
      orderBy: [{ optionSortOrder: "asc" }, { createdAt: "asc" }],
    }),
    client.seller.findMany({
      where: { id: { in: [...new Set(campaigns.map((campaign) => campaign.sellerId))] } },
      select: { id: true, name: true, alias: true },
    }),
  ]);

  const itemsByCampaign = new Map<string, Set<string>>();
  for (const item of items) {
    const set = itemsByCampaign.get(item.campaignId) ?? new Set<string>();
    set.add(item.dealId);
    itemsByCampaign.set(item.campaignId, set);
  }
  const mainById = new Map(mainDeals.map((deal) => [deal.id, deal]));
  const sellerById = new Map(sellers.map((seller) => [seller.id, seller]));

  const views = campaigns.map((campaign): CampaignItemsView => {
    const inCampaign = itemsByCampaign.get(campaign.id) ?? new Set<string>();
    const main = mainById.get(campaign.dealId);
    const childOptions = options.filter((option) => option.parentDealId === campaign.dealId);
    const seller = sellerById.get(campaign.sellerId);
    return {
      id: campaign.id,
      sellerName: seller ? flattenLineBreaks(sellerDisplayName(seller)) : "",
      roundNumber: campaign.roundNumber,
      status: campaign.status,
      startDate: toKstYmd(campaign.startDate),
      endDate: toKstYmd(campaign.endDate),
      mainDeal: main
        ? {
            id: main.id,
            name: flattenLineBreaks(main.dealName),
            sellingPrice: toPrice(main.sellingPrice),
            inCampaign: inCampaign.has(main.id),
          }
        : null,
      options: childOptions.slice(0, MAX_OPTIONS_PER_CAMPAIGN).map((option) => ({
        id: option.id,
        name: flattenLineBreaks(option.dealName),
        sellingPrice: toPrice(option.sellingPrice),
        inCampaign: inCampaign.has(option.id),
      })),
      optionsTruncated: childOptions.length > MAX_OPTIONS_PER_CAMPAIGN,
      itemCount: inCampaign.size,
    };
  });
  return { campaigns: views, truncated };
}

const won = (value: number): string => `${value.toLocaleString("ko-KR")}원`;
const itemMark = (view: CampaignItemDealView): string => (view.inCampaign ? "품목에 있음" : "품목에 없음");

/** 첫 줄에 싣는 판매 조건 이름 상한 — 첫 줄은 봇에게 가는 알림 한 줄(약 200자, 머리·링크 제외 약 87자)에 들어가야 한다. */
const HEADER_DEAL_NAME_CHARS = 16;

/**
 * 봇이 받는 결과 요약. ⚠️ **첫 줄이 봇이 실제로 받는 전부다** — hermes 작업 완료 알림은 첫 줄(머리)과 들어가는 만큼의
 * 행만 약 200자 안에 싣고 나머지는 슬랙 첨부 파일로 보내는데, 봇은 그 파일을 못 읽는다(2026-10-27 실사용에서 봇이
 * 캠페인 id 를 몰라 오너에게 되물었다). 그래서 첫 줄에 기안에 필요한 값을 싣는다:
 *  - 1건: `campaign=<id>` + 판매 조건 이름 + 하위품목 수 — 봇은 이 id 로 바로 기안한다(판매 조건 id 는 CRM 이 채운다).
 *  - 여러 건: 앞 두 건의 id 와 「좁혀 다시 조회」 안내 — 어느 캠페인인지는 사람이 골라야 한다.
 * 둘째 줄부터는 사람(첨부 파일·결재함 기록)을 위한 상세다. 이름은 「…」로 감싼다(자유 글이라 값처럼 꾸밀 수 있다).
 */
export function buildCampaignItemsSummary(result: CampaignItemsResult): { summary: string; optionCount: number } {
  const lines: string[] = [];
  let optionCount = 0;
  for (const campaign of result.campaigns) {
    const round = campaign.roundNumber != null ? ` ${campaign.roundNumber}차` : "";
    lines.push(
      `campaign=${campaign.id} 셀러「${campaign.sellerName}」${round} status=${campaign.status} ` +
        `${campaign.startDate}~${campaign.endDate} 품목 ${campaign.itemCount}줄`,
    );
    if (campaign.mainDeal) {
      const main = campaign.mainDeal;
      lines.push(`  mainDeal=${main.id} 판매 조건「${main.name}」 ${won(main.sellingPrice)} (${itemMark(main)})`);
    } else {
      lines.push("  mainDeal=없음");
    }
    for (const option of campaign.options) {
      optionCount += 1;
      lines.push(`  하위품목 dealId=${option.id} 「${option.name}」 ${won(option.sellingPrice)} (${itemMark(option)})`);
    }
    if (campaign.optionsTruncated) lines.push(`  (하위품목 ${MAX_OPTIONS_PER_CAMPAIGN}개까지만 표시)`);
  }
  const header = buildBotHeader(result);
  const { summary } = buildBoundedSummary(
    (shown) => header + (shown < lines.length ? ` (상세 ${shown}/${lines.length}줄)` : ""),
    lines,
  );
  return { summary, optionCount };
}

function buildBotHeader(result: CampaignItemsResult): string {
  const [first, second] = result.campaigns;
  if (!first) return "get_campaign_items campaigns=0";
  if (result.campaigns.length === 1 && !result.truncated) {
    const dealName = first.mainDeal ? Array.from(first.mainDeal.name).slice(0, HEADER_DEAL_NAME_CHARS).join("") : "없음";
    return `campaign=${first.id} 판매조건「${dealName}」 하위품목 ${first.options.length}개`;
  }
  const more = result.truncated ? `${MAX_CAMPAIGN_ITEMS_MATCHES}+` : String(result.campaigns.length);
  return `campaigns=${more} ids=${first.id}${second ? `,${second.id}` : ""} 좁혀서 다시 조회`;
}
