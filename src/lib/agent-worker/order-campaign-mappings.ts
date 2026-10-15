/**
 * 봇(agent worker)의 `get_order_campaign_mappings`(2026-10-15) — 주문캠페인과 그 상품 매핑을 읽는다.
 * 봇이 매핑 변경 기안을 올리기 전에 **지금 값**을 보려는 조회다(쓰기는 여기 없다).
 *
 * ⛔ 워커 역할은 `OrderCampaign` · `ProductMapping` 에 **칸 단위** SELECT 만 받는다
 *    (20261016120000_grant_agent_worker_order_campaign_mapping_reads). 그래서 여기 Prisma 호출은 전부
 *    명시 `select` 이고, 그 칸은 마이그레이션의 GRANT 목록 안에 있어야 한다 — 기본 select 는 `toEmail`
 *    같은 닫힌 칸에 닿아 운영에서 권한 거부(DB_PERMISSION_DENIED)로 끝난다. 관계를 중첩 select 로
 *    읽지 않는 것도 같은 이유다(Prisma 가 덧붙이는 칸을 여기서 통제하지 못한다).
 * ⛔ 행을 펼쳐(`...row`) 넘기지 말 것 — 원본에 칸이 늘면 검토 없이 슬랙·클라우드 모델로 따라간다.
 *    매핑의 `campaignDealId` 는 값 대신 연결 여부(`linkedToDeal`)만 내보낸다.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { containsSearch, normalizedForms } from "@/lib/prisma-search";
import { sortProductMappingsByProductName } from "@/lib/order-converter/product-mapping-sort";
import { MAX_ORDER_CAMPAIGN_MATCHES } from "./contracts";
import { buildBoundedSummary, flattenLineBreaks } from "./read-projections";

export type OrderCampaignMappingsInput = { orderCampaignId?: string; query?: string };

export type OrderCampaignMappingView = {
  productName: string;
  optionName: string;
  brandCode: string;
  price: number;
  linkedToDeal: boolean;
};

export type OrderCampaignMappingsResult = {
  campaigns: Array<{
    id: string;
    name: string;
    sellerName: string;
    isActive: boolean;
    startDate: string | null; // ISO
    endDate: string | null;
    // 이 주문캠페인에 연결된 판매캠페인 id(SalesCampaign.orderCampaignId = id, 이미 SELECT 권한 있음).
    // 봇이 get_order_snapshot(campaignId=…) 로 실제 주문 옵션명을 읽을 때 쓴다.
    salesCampaignIds: string[];
    mappings: OrderCampaignMappingView[];
  }>;
  truncated: boolean; // query 일치가 MAX_ORDER_CAMPAIGN_MATCHES 를 넘었으면 true
};

// 칸 목록 = 마이그레이션 GRANT 목록. 여기에 칸을 더하려면 마이그레이션부터 더한다.
const ORDER_CAMPAIGN_SELECT = {
  id: true,
  name: true,
  sellerName: true,
  isActive: true,
  startDate: true,
  endDate: true,
} satisfies Prisma.OrderCampaignSelect;

const PRODUCT_MAPPING_SELECT = {
  id: true, // 정렬의 마지막 동률 깨기(sortProductMappingsByProductName)에만 쓰고 내보내지 않는다.
  campaignId: true,
  productName: true,
  optionName: true,
  brandCode: true,
  price: true,
  campaignDealId: true,
} satisfies Prisma.ProductMappingSelect;

const SALES_CAMPAIGN_SELECT = { id: true, orderCampaignId: true } satisfies Prisma.SalesCampaignSelect;

function campaignWhere(input: OrderCampaignMappingsInput): Prisma.OrderCampaignWhereInput {
  const orderCampaignId = input.orderCampaignId?.trim() ?? "";
  const query = input.query?.trim() ?? "";
  // 계약(orderCampaignMappingsInputSchema)이 이미 막지만, 둘 다 비면 where 가 「전부」가 된다 — 두 번째 관문.
  if (Boolean(orderCampaignId) === Boolean(query)) {
    throw new Error("get_order_campaign_mappings needs exactly one of orderCampaignId / query");
  }
  if (orderCampaignId) return { id: orderCampaignId };
  // 한글이 조합형(NFD)으로 저장된 이름도 맞도록 두 정규화 형태를 OR 로 묶는다.
  return { OR: normalizedForms(query).map((form) => ({ name: containsSearch(form) })) };
}

export async function readOrderCampaignMappings(
  input: OrderCampaignMappingsInput,
  client: Prisma.TransactionClient | PrismaClient,
): Promise<OrderCampaignMappingsResult> {
  const rows = await client.orderCampaign.findMany({
    where: campaignWhere(input),
    select: ORDER_CAMPAIGN_SELECT,
    orderBy: [{ isActive: "desc" }, { startDate: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: MAX_ORDER_CAMPAIGN_MATCHES + 1,
  });
  const truncated = rows.length > MAX_ORDER_CAMPAIGN_MATCHES;
  const campaigns = rows.slice(0, MAX_ORDER_CAMPAIGN_MATCHES);
  if (campaigns.length === 0) return { campaigns: [], truncated };

  const ids = campaigns.map((row) => row.id);
  const [mappingRows, salesRows] = await Promise.all([
    client.productMapping.findMany({ where: { campaignId: { in: ids } }, select: PRODUCT_MAPPING_SELECT }),
    client.salesCampaign.findMany({
      where: { orderCampaignId: { in: ids } },
      select: SALES_CAMPAIGN_SELECT,
      orderBy: { id: "asc" },
    }),
  ]);

  const mappingsByCampaign = new Map<string, Array<(typeof mappingRows)[number]>>();
  for (const row of mappingRows) {
    const list = mappingsByCampaign.get(row.campaignId) ?? [];
    list.push(row);
    mappingsByCampaign.set(row.campaignId, list);
  }
  const salesByCampaign = new Map<string, string[]>();
  for (const row of salesRows) {
    if (!row.orderCampaignId) continue;
    const list = salesByCampaign.get(row.orderCampaignId) ?? [];
    list.push(row.id);
    salesByCampaign.set(row.orderCampaignId, list);
  }

  return {
    truncated,
    campaigns: campaigns.map((row) => ({
      id: row.id,
      name: row.name,
      sellerName: row.sellerName,
      isActive: row.isActive,
      startDate: row.startDate ? row.startDate.toISOString() : null,
      endDate: row.endDate ? row.endDate.toISOString() : null,
      salesCampaignIds: [...(salesByCampaign.get(row.id) ?? [])].sort(),
      mappings: sortProductMappingsByProductName(mappingsByCampaign.get(row.id) ?? []).map((mapping) => ({
        productName: mapping.productName,
        optionName: mapping.optionName,
        brandCode: mapping.brandCode,
        price: mapping.price,
        linkedToDeal: mapping.campaignDealId != null,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// 봇에게 가는 글
// ---------------------------------------------------------------------------

const text = (value: string) => flattenLineBreaks(value) || "(비어 있음)";

/**
 * 머리줄 하나 + 캠페인마다 `CAMPAIGN #n …` 한 줄과 그 매핑 `  #n 상품 | 옵션 | code= | price= | linkedToDeal=`
 * 줄들. 결과 글자 상한을 넘으면 뒤에서부터 줄을 덜어 내고 머리줄의 `shownLines=보인 줄/전체 줄` 로 알린다.
 */
export function buildOrderCampaignMappingsSummary(result: OrderCampaignMappingsResult): {
  summary: string;
  mappingCount: number;
} {
  const lines: string[] = [];
  result.campaigns.forEach((campaign, index) => {
    const tag = `#${index + 1}`;
    lines.push(
      `CAMPAIGN ${tag} id=${campaign.id} name=${text(campaign.name)} seller=${text(campaign.sellerName)} ` +
        `active=${campaign.isActive ? "yes" : "no"} start=${campaign.startDate ?? "none"} end=${campaign.endDate ?? "none"} ` +
        `salesCampaignIds=${campaign.salesCampaignIds.length > 0 ? campaign.salesCampaignIds.join(",") : "none"} ` +
        `mappings=${campaign.mappings.length}`,
    );
    for (const mapping of campaign.mappings) {
      lines.push(
        `  ${tag} ${text(mapping.productName)} | ${text(mapping.optionName)} | code=${text(mapping.brandCode)} | ` +
          `price=${mapping.price} | linkedToDeal=${mapping.linkedToDeal ? "yes" : "no"}`,
      );
    }
  });
  const mappingCount = result.campaigns.reduce((sum, campaign) => sum + campaign.mappings.length, 0);
  const { summary } = buildBoundedSummary(
    (shown) =>
      `get_order_campaign_mappings campaigns=${result.campaigns.length} mappings=${mappingCount} truncated=${result.truncated} shownLines=${shown}/${lines.length}`,
    lines,
  );
  return { summary, mappingCount };
}
