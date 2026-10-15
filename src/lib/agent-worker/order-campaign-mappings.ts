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
import {
  MAX_LIVE_WINDOW_DAYS,
  aggregateCoversCampaigns,
  composeSalesDetailFromAggregates,
  parseSnapshotDailyAggregate,
  resolveLiveWindowKeys,
  type SnapshotDailyAggregate,
} from "@/lib/order-converter/daily-aggregate";
import {
  MAX_ORDER_CAMPAIGN_MATCHES,
  MAX_STRUCTURED_DATA_BYTES,
  normalizeMappingOptionName,
  type OrderCampaignMappingsStructuredData,
} from "./contracts";
import { buildBoundedSummary, flattenLineBreaks } from "./read-projections";

export type OrderCampaignMappingsInput = { orderCampaignId?: string; query?: string };

export type OrderCampaignMappingView = {
  productName: string;
  optionName: string;
  brandCode: string;
  price: number;
  linkedToDeal: boolean;
};

/** 캠페인마다 싣는 스토어 옵션 수 상한 — 넘으면 수량이 큰 쪽을 남기고 `storeOptionsTruncated` 를 켠다. */
export const MAX_STORE_OPTIONS_PER_CAMPAIGN = 100;

/** 품목 표시명(「상품명 · 옵션명」)의 구분자 — `daily-aggregate.ts` 의 `resolveItemName` 과 같은 글자. */
const ITEM_NAME_SEPARATOR = " · ";
/** 상품명·옵션명이 둘 다 없는 주문의 품목 이름 — 매핑할 옵션이 아니라서 싣지 않는다. */
const UNNAMED_ITEM_LABEL = "기타";

/**
 * 스토어 실제 옵션 하나(2026-10-16) — 이 캠페인의 판매캠페인 주문 집계(`NaverOrderSnapshot.dailyAggregate`)의
 * 품목 이름을 그대로 싣고, 「상품명 · 옵션명」을 나눌 수 있으면 나눠 준다.
 * - `single`: 구분자가 정확히 하나 — 앞이 상품명, 뒤가 옵션명.
 * - `none`: 구분자가 없다 — 이름 전체를 옵션명으로 본다(상품명 null).
 * - `ambiguous`: 구분자가 둘 이상 — 상품명·옵션명 어느 쪽에 들어 있었는지 알 수 없어 둘 다 null.
 * `mappingIndex` 는 같은 캠페인 `mappings` 에서 옵션명 비교 키가 같은 첫 줄의 위치(없으면 null)다.
 */
export type OrderCampaignStoreOption = {
  label: string;
  productName: string | null;
  optionName: string | null;
  split: "single" | "none" | "ambiguous";
  quantity: number;
  mappingIndex: number | null;
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
    // 스토어 실제 옵션(수량 내림차순, 최대 MAX_STORE_OPTIONS_PER_CAMPAIGN). 판매캠페인이 없으면 빈 배열.
    storeOptions: OrderCampaignStoreOption[];
    storeOptionsTruncated: boolean;
    // 조회 창이 절대 상한(MAX_LIVE_WINDOW_DAYS)에 걸려 판매캠페인 시작 이후 일부 날짜를 못 읽었는가.
    // true 면 빠진 옵션은 「주문 없음」이 아니라 「읽지 않음」이다.
    storeOptionsWindowTruncated: boolean;
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

// startDate: 스토어 옵션 조회 창의 시작(get_order_snapshot 의 캠페인 창과 같은 규칙).
const SALES_CAMPAIGN_SELECT = { id: true, orderCampaignId: true, startDate: true } satisfies Prisma.SalesCampaignSelect;

// 주문 원본(orders 블롭)은 읽지 않는다 — 품목별 사전 집계만 고른다(egress 절감 계약, daily-aggregate.ts 헤더).
const SNAPSHOT_SELECT = { snapshotDate: true, dailyAggregate: true } satisfies Prisma.NaverOrderSnapshotSelect;

function splitStoreOptionLabel(label: string): Pick<OrderCampaignStoreOption, "productName" | "optionName" | "split"> {
  const parts = label.split(ITEM_NAME_SEPARATOR);
  if (parts.length === 1) return { productName: null, optionName: label, split: "none" };
  if (parts.length === 2) return { productName: parts[0], optionName: parts[1], split: "single" };
  return { productName: null, optionName: null, split: "ambiguous" };
}

/**
 * 한 주문캠페인의 스토어 옵션 — 그 캠페인에 걸린 판매캠페인들의 품목 집계를 이름별로 합쳐 수량 내림차순으로 싣는다.
 *
 * 판매캠페인 **하나씩** 집계한다: 집계 행이 그 판매캠페인을 덮을 때만 그 판매캠페인 몫으로 쓴다(블롭 폴백 없음).
 * 묶음 전체로 덮기를 따지면, 나중에 연결된 판매캠페인이 없는 날(그 집계를 쓸 때 아직 없던 캠페인)의 행이 통째로
 * 빠져 먼저 있던 판매캠페인의 옵션까지 사라진다.
 *
 * 수량은 판매캠페인별 합을 그대로 더한다 — `composeSalesDetailFromAggregates` 가 여러 대상을 한 번에 합칠 때와 같은
 * 셈이다. 품목 리프는 주문키(orderKeys)는 갖지만 줄별 수량은 갖지 않아 수량을 주문키로 중복 제거할 수 없다:
 * 한 상품주문 줄이 두 판매캠페인에 함께 귀속되는 경우(조합 캠페인)에는 그 줄 수량이 두 번 들어간다. 이 잔여는
 * 모바일 매출 상세의 품목 수량과 같은 성질이다.
 */
function buildStoreOptions(
  rows: ReadonlyArray<{ snapshotDate: string; aggregate: SnapshotDailyAggregate | null }>,
  salesCampaignIds: string[],
  window: { startKey: string; todayKey: string },
  mappings: ReadonlyArray<{ optionName: string }>,
): { storeOptions: OrderCampaignStoreOption[]; storeOptionsTruncated: boolean } {
  const inWindow = rows.filter((row) => row.snapshotDate >= window.startKey && row.snapshotDate <= window.todayKey);
  const quantityByLabel = new Map<string, number>();
  for (const salesCampaignId of salesCampaignIds) {
    const target = new Set([salesCampaignId]);
    const aggregates: SnapshotDailyAggregate[] = [];
    for (const row of inWindow) {
      if (row.aggregate && aggregateCoversCampaigns(row.aggregate, target)) aggregates.push(row.aggregate);
    }
    const { detail } = composeSalesDetailFromAggregates(aggregates, window.todayKey, target);
    for (const item of detail.items) {
      quantityByLabel.set(item.name, (quantityByLabel.get(item.name) ?? 0) + item.quantity);
    }
  }
  const mappingKeys = mappings.map((mapping) => normalizeMappingOptionName(mapping.optionName));
  const options = [...quantityByLabel]
    .filter(([label]) => label !== UNNAMED_ITEM_LABEL)
    .map(([label, quantity]): OrderCampaignStoreOption => {
      const split = splitStoreOptionLabel(label);
      const index = split.optionName === null ? -1 : mappingKeys.indexOf(normalizeMappingOptionName(split.optionName));
      return { label, ...split, quantity, mappingIndex: index >= 0 ? index : null };
    })
    .sort((a, b) => b.quantity - a.quantity || a.label.localeCompare(b.label, "ko"));
  return {
    storeOptions: options.slice(0, MAX_STORE_OPTIONS_PER_CAMPAIGN),
    storeOptionsTruncated: options.length > MAX_STORE_OPTIONS_PER_CAMPAIGN,
  };
}

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
  now: Date = new Date(),
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
  const earliestSalesStartMs = new Map<string, number>();
  for (const row of salesRows) {
    if (!row.orderCampaignId) continue;
    const list = salesByCampaign.get(row.orderCampaignId) ?? [];
    list.push(row.id);
    salesByCampaign.set(row.orderCampaignId, list);
    const startMs = new Date(row.startDate).getTime();
    earliestSalesStartMs.set(row.orderCampaignId, Math.min(earliestSalesStartMs.get(row.orderCampaignId) ?? Infinity, startMs));
  }

  // 조회 창 = get_order_snapshot(campaignId) 와 같은 규칙(판매캠페인 시작일 ~ 오늘, 절대 상한 MAX_LIVE_WINDOW_DAYS).
  // 캠페인이 여럿이면 가장 이른 창부터 한 번만 읽고 캠페인마다 자기 창으로 거른다.
  const windows = new Map<string, { startKey: string; todayKey: string; truncated: boolean }>();
  for (const [orderCampaignId, startMs] of earliestSalesStartMs) {
    windows.set(orderCampaignId, resolveLiveWindowKeys(startMs, now, "agent-worker", { silent: true }));
  }
  // 창 잘림은 캠페인마다 결과 칸(storeOptionsWindowTruncated)으로 알리고, 로그는 조회 한 번에 한 줄만 남긴다
  // (오래 열린 캠페인은 매 조회마다 잘리므로 캠페인마다 남기면 로그가 같은 경고로 덮인다).
  const windowTruncatedCount = [...windows.values()].filter((window) => window.truncated).length;
  if (windowTruncatedCount > 0) {
    console.warn(
      `[agent-worker] get_order_campaign_mappings: 주문캠페인 ${windowTruncatedCount}건의 스토어 옵션 조회 창이 ` +
        `절대 상한(${MAX_LIVE_WINDOW_DAYS}일)에 걸려 잘렸습니다 — 그 이전 주문의 옵션은 읽지 않았습니다.`,
    );
  }
  let snapshotRows: Array<{ snapshotDate: string; aggregate: SnapshotDailyAggregate | null }> = [];
  if (windows.size > 0) {
    const keys = [...windows.values()];
    const startKey = keys.reduce((min, window) => (window.startKey < min ? window.startKey : min), keys[0].startKey);
    const todayKey = keys[0].todayKey;
    const rawRows = await client.naverOrderSnapshot.findMany({
      where: { snapshotDate: { gte: startKey, lte: todayKey } },
      orderBy: { snapshotDate: "asc" },
      select: SNAPSHOT_SELECT,
    });
    snapshotRows = rawRows.map((row) => ({
      snapshotDate: row.snapshotDate,
      aggregate: parseSnapshotDailyAggregate(row.dailyAggregate),
    }));
  }

  return {
    truncated,
    campaigns: campaigns.map((row) => {
      const salesCampaignIds = [...(salesByCampaign.get(row.id) ?? [])].sort();
      const mappings = sortProductMappingsByProductName(mappingsByCampaign.get(row.id) ?? []).map((mapping) => ({
        productName: mapping.productName,
        optionName: mapping.optionName,
        brandCode: mapping.brandCode,
        price: mapping.price,
        linkedToDeal: mapping.campaignDealId != null,
      }));
      const window = windows.get(row.id);
      const store = window
        ? {
            ...buildStoreOptions(snapshotRows, salesCampaignIds, window, mappings),
            storeOptionsWindowTruncated: window.truncated,
          }
        : { storeOptions: [], storeOptionsTruncated: false, storeOptionsWindowTruncated: false };
      return {
        id: row.id,
        name: row.name,
        sellerName: row.sellerName,
        isActive: row.isActive,
        startDate: row.startDate ? row.startDate.toISOString() : null,
        endDate: row.endDate ? row.endDate.toISOString() : null,
        salesCampaignIds,
        mappings,
        ...store,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 봇에게 가는 글
// ---------------------------------------------------------------------------

const text = (value: string) => flattenLineBreaks(value) || "(비어 있음)";

/** 첫 줄에 싣는 캠페인 이름 글자 수 · 첫 줄 전체 글자 수 — 봇 라우터는 결과 요약의 앞 200자 정도만 본다. */
const FIRST_LINE_NAME_CHARS = 60;
const FIRST_LINE_MAX_CHARS = 200;

/** 코드포인트 단위로 자른다(한글·이모지가 반으로 갈리지 않게). */
function takeChars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

/** 봇 라우터용 첫 줄 — `get_order_campaign_mappings campaigns=N first=<id> name=<이름 60자>`, 200자 이내. */
function buildFirstLine(result: OrderCampaignMappingsResult): string {
  const first = result.campaigns[0];
  const line =
    `get_order_campaign_mappings campaigns=${result.campaigns.length} ` +
    (first ? `first=${first.id} name=${takeChars(text(first.name), FIRST_LINE_NAME_CHARS)}` : "first=none name=none");
  return takeChars(line, FIRST_LINE_MAX_CHARS);
}

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
  const firstLine = buildFirstLine(result);
  const { summary } = buildBoundedSummary(
    (shown) =>
      `${firstLine}\n` +
      `get_order_campaign_mappings campaigns=${result.campaigns.length} mappings=${mappingCount} truncated=${result.truncated} shownLines=${shown}/${lines.length}`,
    lines,
  );
  return { summary, mappingCount };
}

// ---------------------------------------------------------------------------
// 봇이 읽는 구조화 결과(AgentJobResult.structuredData, 2026-10-16)
// ---------------------------------------------------------------------------

const utf8Bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
/** 배열에서 원소 하나를 뺄 때 줄어드는 바이트 — 원소 + 남은 원소가 있으면 쉼표 하나. */
const removedBytes = (value: unknown, remaining: number) => utf8Bytes(value) + (remaining > 0 ? 1 : 0);

type TrimmableCampaign = {
  mappings: unknown[];
  mappingsTruncated: boolean;
  storeOptions: unknown[];
  storeOptionsTruncated: boolean;
};

/**
 * 캠페인 목록을 `limit` 바이트(UTF-8 JSON) 안에 맞춘다(제자리 수정). 넘치면 뒤에서부터 ① 스토어 옵션(마지막 캠페인의
 * 마지막 옵션부터) ② 매핑 ③ 캠페인 순으로 덜어 내고, 덜어 낸 캠페인의 `storeOptionsTruncated` /
 * `mappingsTruncated` 와 최상위 `truncated` 를 켠다. 캠페인을 다 덜어도 안 들어가면 null.
 */
function trimCampaignPayload<T extends { campaigns: TrimmableCampaign[]; truncated: boolean }>(data: T, limit: number): T | null {
  // 어림셈: 덜어 낸 원소의 바이트만 뺀다. 플래그가 false → true 로 바뀌면 1바이트씩 줄 뿐이라 어림이 실제보다
  // 작아지지 않는다(덜 덜어 내는 일은 없다). 마지막에 실제 바이트로 한 번 더 확인한다.
  let bytes = utf8Bytes(data);
  if (bytes <= limit) return data;
  data.truncated = true;
  const campaigns = data.campaigns;
  for (let index = campaigns.length - 1; index >= 0 && bytes > limit; index -= 1) {
    const row = campaigns[index];
    while (row.storeOptions.length > 0 && bytes > limit) {
      const removed = row.storeOptions.pop();
      bytes -= removedBytes(removed, row.storeOptions.length);
      row.storeOptionsTruncated = true;
    }
  }
  for (let index = campaigns.length - 1; index >= 0 && bytes > limit; index -= 1) {
    const row = campaigns[index];
    while (row.mappings.length > 0 && bytes > limit) {
      const removed = row.mappings.pop();
      bytes -= removedBytes(removed, row.mappings.length);
      row.mappingsTruncated = true;
    }
  }
  while (campaigns.length > 0 && utf8Bytes(data) > limit) campaigns.pop();
  return utf8Bytes(data) <= limit ? data : null;
}

/** 캠페인 칸을 하나씩 골라 새 객체로 옮긴다 — 읽기 결과에 칸이 늘어도 검토 없이 따라가지 않게. */
function copyCampaignsForPayload(result: OrderCampaignMappingsResult): OrderCampaignMappingsStructuredData["campaigns"] {
  return result.campaigns.map((row) => ({
    id: row.id,
    name: row.name,
    sellerName: row.sellerName,
    isActive: row.isActive,
    startDate: row.startDate,
    endDate: row.endDate,
    salesCampaignIds: [...row.salesCampaignIds],
    mappings: row.mappings.map((mapping) => ({
      productName: mapping.productName,
      optionName: mapping.optionName,
      brandCode: mapping.brandCode,
      price: mapping.price,
      linkedToDeal: mapping.linkedToDeal,
    })),
    mappingsTruncated: false,
    storeOptions: row.storeOptions.map((option) => ({
      label: option.label,
      productName: option.productName,
      optionName: option.optionName,
      split: option.split,
      quantity: option.quantity,
      mappingIndex: option.mappingIndex,
    })),
    storeOptionsTruncated: row.storeOptionsTruncated,
    storeOptionsWindowTruncated: row.storeOptionsWindowTruncated,
  }));
}

/** 읽기 결과를 `maxBytes`(최대 `MAX_STRUCTURED_DATA_BYTES`) 안의 구조화 데이터(봇용)로 옮긴다. 못 맞추면 null. */
export function buildOrderCampaignMappingsStructuredData(
  result: OrderCampaignMappingsResult,
  maxBytes: number = MAX_STRUCTURED_DATA_BYTES,
): OrderCampaignMappingsStructuredData | null {
  return trimCampaignPayload(
    {
      kind: "order_campaign_mappings" as const,
      version: 1 as const,
      campaigns: copyCampaignsForPayload(result),
      truncated: result.truncated,
    },
    Math.min(maxBytes, MAX_STRUCTURED_DATA_BYTES),
  );
}

/**
 * 결재함 READ 기록의 표 데이터 — 읽기 결과 모양(+ 캠페인별 `mappingsTruncated`)을 `maxBytes` 안에 맞춘다.
 * 기록 상한(MAX_READ_RESULT_BYTES)을 넘기면 기록 모듈이 데이터 전체를 마커로 바꿔 매핑 표까지 사라지므로,
 * 여기서 스토어 옵션부터 덜어 매핑 표를 남긴다. 못 맞추면 null.
 */
export function buildOrderCampaignMappingsRecordPayload(
  result: OrderCampaignMappingsResult,
  maxBytes: number,
): { campaigns: OrderCampaignMappingsStructuredData["campaigns"]; truncated: boolean } | null {
  return trimCampaignPayload({ campaigns: copyCampaignsForPayload(result), truncated: result.truncated }, maxBytes);
}
