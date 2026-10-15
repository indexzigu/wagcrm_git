/**
 * get_order_campaign_mappings(2026-10-15) — 주문캠페인과 그 상품 매핑 읽기.
 *
 * 워커 역할은 이 두 표에 **칸 단위** SELECT 만 받는다(20261016120000). 그래서 이 조회의 Prisma 호출은
 * 모두 명시 `select` 여야 하고, 고른 칸이 마이그레이션의 GRANT 목록 안에 있어야 한다 — 기본 select 는
 * `toEmail` 같은 닫힌 칸에 닿아 운영에서 권한 거부로 끝난다. 이름은 전부 가짜다(공개 레포).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";

const { m, fakeClient } = vi.hoisted(() => {
  const m = {
    orderCampaignFindMany: vi.fn(),
    productMappingFindMany: vi.fn(),
    salesCampaignFindMany: vi.fn(),
    snapshotFindMany: vi.fn(),
    proposalCreate: vi.fn(),
    proposalEventCreate: vi.fn(),
  };
  const fakeClient = {
    orderCampaign: { findMany: (args: unknown) => m.orderCampaignFindMany(args) },
    productMapping: { findMany: (args: unknown) => m.productMappingFindMany(args) },
    salesCampaign: { findMany: (args: unknown) => m.salesCampaignFindMany(args) },
    naverOrderSnapshot: { findMany: (args: unknown) => m.snapshotFindMany(args) },
  };
  return { m, fakeClient };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    ...fakeClient,
    $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        actionProposal: { create: (args: unknown) => m.proposalCreate(args) },
        actionProposalEvent: { create: (args: unknown) => m.proposalEventCreate(args) },
      }),
  }),
}));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));

import { executeAgentJob, type ExecutionDeps } from "../executor";
import {
  MAX_AGENT_JOB_JSON_BYTES,
  MAX_ORDER_CAMPAIGN_MATCHES,
  MAX_RESULT_SUMMARY_CHARS,
  MAX_STRUCTURED_DATA_BYTES,
  orderCampaignMappingsStructuredDataSchema,
  serializeAgentJobJson,
} from "../contracts";
import {
  MAX_STORE_OPTIONS_PER_CAMPAIGN,
  buildOrderCampaignMappingsStructuredData,
  readOrderCampaignMappings,
  type OrderCampaignMappingsResult,
} from "../order-campaign-mappings";
import { MAX_FRAME_BYTES } from "../socket-server";
import { MAX_READ_RESULT_BYTES } from "../read-result-record";

const client = fakeClient as unknown as PrismaClient;
const NOW = new Date("2026-10-15T03:00:00.000Z");

type CampaignRow = {
  id: string;
  name: string;
  sellerName: string;
  isActive: boolean;
  startDate: Date | null;
  endDate: Date | null;
};
type MappingRow = {
  id: string;
  campaignId: string;
  productName: string;
  optionName: string;
  brandCode: string;
  price: number;
  campaignDealId: string | null;
};

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "oc-1",
    name: "가짜셀러(김가짜) - 가짜크림 캠페인",
    sellerName: "가짜셀러(김가짜)",
    isActive: true,
    startDate: new Date("2026-10-01T00:00:00.000Z"),
    endDate: new Date("2026-10-31T00:00:00.000Z"),
    ...overrides,
  };
}

function mapping(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    id: "pm-1",
    campaignId: "oc-1",
    productName: "가짜크림",
    optionName: "1개",
    brandCode: "FAKE-001",
    price: 19_900,
    campaignDealId: null,
    ...overrides,
  };
}

/** 칸 이름은 마이그레이션의 GRANT 목록과 같아야 한다 — 마이그레이션 파일에서 직접 읽는다. */
const MIGRATION = readFileSync(
  path.join(
    process.cwd(),
    "prisma/migrations/20261016120000_grant_agent_worker_order_campaign_mapping_reads/migration.sql",
  ),
  "utf8",
);
function grantedColumns(table: string): string[] {
  const match = MIGRATION.match(new RegExp(`GRANT SELECT \\(([^)]*)\\) ON TABLE "${table}" TO wag_agent_worker`));
  if (!match) throw new Error(`no column grant for ${table}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((column) => column[1]);
}

function selectedColumns(args: unknown): string[] {
  const select = (args as { select?: Record<string, unknown> }).select;
  expect(select, "every worker-role query needs an explicit select").toBeDefined();
  for (const value of Object.values(select!)) expect(value, "no nested relation select").toBe(true);
  return Object.keys(select!);
}

beforeEach(() => {
  m.orderCampaignFindMany.mockReset();
  m.productMappingFindMany.mockReset();
  m.salesCampaignFindMany.mockReset();
  m.snapshotFindMany.mockReset();
  m.proposalCreate.mockReset();
  m.proposalEventCreate.mockReset();
  m.orderCampaignFindMany.mockResolvedValue([]);
  m.productMappingFindMany.mockResolvedValue([]);
  m.salesCampaignFindMany.mockResolvedValue([]);
  m.snapshotFindMany.mockResolvedValue([]);
  m.proposalCreate.mockResolvedValue({ id: "read-1" });
  m.proposalEventCreate.mockResolvedValue({});
});

describe("readOrderCampaignMappings", () => {
  it("(a) reads one campaign by id with its mappings sorted by product name", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign()]);
    m.productMappingFindMany.mockResolvedValue([
      mapping({ id: "pm-3", productName: "나중크림", optionName: "2개", brandCode: "FAKE-003", price: 30_000 }),
      mapping({ id: "pm-2", productName: "가짜크림", optionName: "2개", brandCode: "FAKE-002", price: 35_000 }),
      mapping({ id: "pm-1" }),
    ]);

    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client);

    expect(m.orderCampaignFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "oc-1" },
        orderBy: [{ isActive: "desc" }, { startDate: { sort: "desc", nulls: "last" } }, { id: "asc" }],
        take: MAX_ORDER_CAMPAIGN_MATCHES + 1,
      }),
    );
    expect(m.productMappingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { campaignId: { in: ["oc-1"] } } }));
    expect(result).toEqual({
      truncated: false,
      campaigns: [
        {
          id: "oc-1",
          name: "가짜셀러(김가짜) - 가짜크림 캠페인",
          sellerName: "가짜셀러(김가짜)",
          isActive: true,
          startDate: "2026-10-01T00:00:00.000Z",
          endDate: "2026-10-31T00:00:00.000Z",
          salesCampaignIds: [],
          storeOptions: [],
          storeOptionsTruncated: false,
          storeOptionsWindowTruncated: false,
          mappings: [
            { productName: "가짜크림", optionName: "1개", brandCode: "FAKE-001", price: 19_900, linkedToDeal: false },
            { productName: "가짜크림", optionName: "2개", brandCode: "FAKE-002", price: 35_000, linkedToDeal: false },
            { productName: "나중크림", optionName: "2개", brandCode: "FAKE-003", price: 30_000, linkedToDeal: false },
          ],
        },
      ],
    });
  });

  it("(b) matches the query as a case-insensitive partial name match", async () => {
    await readOrderCampaignMappings({ query: "  Fake크림 " }, client);
    const args = m.orderCampaignFindMany.mock.calls[0][0] as { where: { OR: unknown[] } };
    expect(args.where.OR).toContainEqual({ name: { contains: "Fake크림", mode: "insensitive" } });
    for (const branch of args.where.OR) {
      expect(branch).toEqual({ name: expect.objectContaining({ mode: "insensitive" }) });
    }
  });

  it("(b) also matches Hangul stored decomposed (NFD)", async () => {
    await readOrderCampaignMappings({ query: "샘플 공구" }, client);
    const args = m.orderCampaignFindMany.mock.calls[0][0] as { where: { OR: unknown[] } };
    expect(args.where.OR).toEqual([
      { name: { contains: "샘플 공구".normalize("NFC"), mode: "insensitive" } },
      { name: { contains: "샘플 공구".normalize("NFD"), mode: "insensitive" } },
    ]);
  });

  it("(c) returns ten of eleven matches and marks the result truncated", async () => {
    const rows = Array.from({ length: MAX_ORDER_CAMPAIGN_MATCHES + 1 }, (_, index) => campaign({ id: `oc-${index}` }));
    m.orderCampaignFindMany.mockResolvedValue(rows);

    const result = await readOrderCampaignMappings({ query: "가짜" }, client);

    expect(result.truncated).toBe(true);
    expect(result.campaigns).toHaveLength(MAX_ORDER_CAMPAIGN_MATCHES);
    expect(result.campaigns.map((row) => row.id)).toEqual(rows.slice(0, MAX_ORDER_CAMPAIGN_MATCHES).map((row) => row.id));
    // 잘린 열한 번째 캠페인의 매핑·판매캠페인은 묻지도 않는다.
    expect(m.productMappingFindMany.mock.calls[0][0]).toMatchObject({ where: { campaignId: { in: expect.not.arrayContaining(["oc-10"]) } } });
  });

  it("(c) exactly ten matches are not truncated", async () => {
    m.orderCampaignFindMany.mockResolvedValue(
      Array.from({ length: MAX_ORDER_CAMPAIGN_MATCHES }, (_, index) => campaign({ id: `oc-${index}` })),
    );
    const result = await readOrderCampaignMappings({ query: "가짜" }, client);
    expect(result.truncated).toBe(false);
    expect(result.campaigns).toHaveLength(MAX_ORDER_CAMPAIGN_MATCHES);
  });

  it("(d) an unknown id answers with no campaigns, not an error, and reads nothing else", async () => {
    const result = await readOrderCampaignMappings({ orderCampaignId: "missing" }, client);
    expect(result).toEqual({ campaigns: [], truncated: false });
    expect(m.productMappingFindMany).not.toHaveBeenCalled();
    expect(m.salesCampaignFindMany).not.toHaveBeenCalled();
  });

  it("(e) linkedToDeal is campaignDealId != null", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign()]);
    m.productMappingFindMany.mockResolvedValue([
      mapping({ id: "pm-1", optionName: "1개", campaignDealId: "cd-1" }),
      mapping({ id: "pm-2", optionName: "2개", campaignDealId: null }),
    ]);
    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client);
    expect(result.campaigns[0].mappings.map((row) => [row.optionName, row.linkedToDeal])).toEqual([
      ["1개", true],
      ["2개", false],
    ]);
    expect(JSON.stringify(result)).not.toContain("cd-1");
  });

  it("(f) salesCampaignIds holds only the sales campaigns linked through orderCampaignId", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign({ id: "oc-1" }), campaign({ id: "oc-2", isActive: false })]);
    m.productMappingFindMany.mockResolvedValue([
      mapping({ id: "pm-1", campaignId: "oc-1" }),
      mapping({ id: "pm-2", campaignId: "oc-2", productName: "둘째크림" }),
    ]);
    m.salesCampaignFindMany.mockResolvedValue([
      { id: "sc-2", orderCampaignId: "oc-1", startDate: new Date("2026-10-01T00:00:00.000Z") },
      { id: "sc-9", orderCampaignId: "oc-2", startDate: new Date("2026-10-01T00:00:00.000Z") },
      { id: "sc-1", orderCampaignId: "oc-1", startDate: new Date("2026-10-01T00:00:00.000Z") },
    ]);

    const result = await readOrderCampaignMappings({ query: "가짜" }, client);

    expect(m.salesCampaignFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderCampaignId: { in: ["oc-1", "oc-2"] } } }),
    );
    expect(result.campaigns.map((row) => [row.id, row.salesCampaignIds, row.mappings.map((x) => x.productName)])).toEqual([
      ["oc-1", ["sc-1", "sc-2"], ["가짜크림"]],
      ["oc-2", ["sc-9"], ["둘째크림"]],
    ]);
  });

  it("keeps null dates as null", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign({ startDate: null, endDate: null })]);
    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client);
    expect(result.campaigns[0]).toMatchObject({ startDate: null, endDate: null });
  });

  it("selects only columns the worker role is granted (explicit select on every call)", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign()]);
    await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client);

    const campaignColumns = selectedColumns(m.orderCampaignFindMany.mock.calls[0][0]);
    const mappingColumns = selectedColumns(m.productMappingFindMany.mock.calls[0][0]);
    const salesColumns = selectedColumns(m.salesCampaignFindMany.mock.calls[0][0]);

    expect(grantedColumns("OrderCampaign")).toEqual(expect.arrayContaining(campaignColumns));
    expect(grantedColumns("ProductMapping")).toEqual(expect.arrayContaining(mappingColumns));
    expect(campaignColumns).not.toContain("toEmail");
    expect(salesColumns.sort()).toEqual(["id", "orderCampaignId", "startDate"]);
  });

  it("refuses an input with neither or both selectors (the contract already does; this is the second gate)", async () => {
    await expect(readOrderCampaignMappings({}, client)).rejects.toThrow();
    await expect(readOrderCampaignMappings({ orderCampaignId: "oc-1", query: "가짜" }, client)).rejects.toThrow();
    expect(m.orderCampaignFindMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// storeOptions — 스토어 실제 옵션명(NaverOrderSnapshot.dailyAggregate 품목, 2026-10-16)
// ---------------------------------------------------------------------------

type ItemFixture = { name: string; quantity: number };
/** dailyAggregate v1 한 행 — 리프의 품목만 의미 있게 채운다. 이름은 전부 가짜다. */
function aggregateRow(
  snapshotDate: string,
  leaves: Record<string, ItemFixture[]>,
  campaignIds: string[] = Object.keys(leaves),
) {
  const day: Record<string, unknown> = {};
  for (const [salesCampaignId, items] of Object.entries(leaves)) {
    day[salesCampaignId] = {
      orderKeys: [],
      validLines: items.length,
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      revenue: 0,
      statusBreakdown: { newOrderBefore: 0, newOrderAfter: 0, pending: 0, shipping: 0, completed: 0 },
      poCandidates: { newBefore: [], newAfter: [], other: [] },
      claims: { canceled: 0, returned: 0, exchanged: 0 },
      items: items.map((item) => ({ name: item.name, orderKeys: [], quantity: item.quantity, revenue: 0 })),
    };
  }
  return { snapshotDate, dailyAggregate: { v: 1, campaignIds, days: { [snapshotDate]: day } } };
}

const SALES_START = new Date("2026-10-01T00:00:00.000Z");

describe("readOrderCampaignMappings — storeOptions", () => {
  beforeEach(() => {
    m.orderCampaignFindMany.mockResolvedValue([campaign()]);
    m.salesCampaignFindMany.mockResolvedValue([{ id: "sc-1", orderCampaignId: "oc-1", startDate: SALES_START }]);
    m.productMappingFindMany.mockResolvedValue([mapping()]); // 「가짜크림 / 1개」 하나
  });

  it("reads only dailyAggregate (never the orders blob) over the sales campaign window, with an explicit select", async () => {
    await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client, NOW);
    expect(m.snapshotFindMany).toHaveBeenCalledTimes(1);
    expect(m.snapshotFindMany).toHaveBeenCalledWith({
      where: { snapshotDate: { gte: "2026-10-01", lte: "2026-10-15" } },
      orderBy: { snapshotDate: "asc" },
      select: { snapshotDate: true, dailyAggregate: true },
    });
  });

  it("splits labels: one separator = single, none = option only, more = ambiguous; skips 「기타」", async () => {
    m.snapshotFindMany.mockResolvedValue([
      aggregateRow("2026-10-02", {
        "sc-1": [
          { name: "샘플 공구 상품 · 1개", quantity: 5 },
          { name: "단독 옵션", quantity: 4 },
          { name: "가짜 · 세트 · 2개", quantity: 3 },
          { name: "기타", quantity: 9 },
        ],
      }),
    ]);
    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client, NOW);
    expect(result.campaigns[0].storeOptions).toEqual([
      { label: "샘플 공구 상품 · 1개", productName: "샘플 공구 상품", optionName: "1개", split: "single", quantity: 5, mappingIndex: 0 },
      { label: "단독 옵션", productName: null, optionName: "단독 옵션", split: "none", quantity: 4, mappingIndex: null },
      { label: "가짜 · 세트 · 2개", productName: null, optionName: null, split: "ambiguous", quantity: 3, mappingIndex: null },
    ]);
    expect(result.campaigns[0].storeOptionsTruncated).toBe(false);
  });

  it("merges one label across days and sales campaigns, sums quantity, sorts by quantity desc", async () => {
    m.salesCampaignFindMany.mockResolvedValue([
      { id: "sc-1", orderCampaignId: "oc-1", startDate: SALES_START },
      { id: "sc-2", orderCampaignId: "oc-1", startDate: new Date("2026-10-05T00:00:00.000Z") },
    ]);
    m.snapshotFindMany.mockResolvedValue([
      aggregateRow("2026-10-02", { "sc-1": [{ name: "샘플 상품 · A", quantity: 2 }, { name: "샘플 상품 · B", quantity: 5 }] }, ["sc-1", "sc-2"]),
      aggregateRow("2026-10-06", { "sc-1": [{ name: "샘플 상품 · A", quantity: 3 }], "sc-2": [{ name: "샘플 상품 · A", quantity: 4 }] }),
    ]);
    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client, NOW);
    expect(result.campaigns[0].storeOptions.map((option) => [option.label, option.quantity])).toEqual([
      ["샘플 상품 · A", 9],
      ["샘플 상품 · B", 5],
    ]);
  });

  it("skips aggregate rows that do not cover the campaign's sales campaigns (no blob fallback)", async () => {
    m.snapshotFindMany.mockResolvedValue([
      aggregateRow("2026-10-02", { "sc-1": [{ name: "샘플 상품 · A", quantity: 2 }] }),
      aggregateRow("2026-10-03", { "sc-other": [{ name: "샘플 상품 · Z", quantity: 7 }] }),
      { snapshotDate: "2026-10-04", dailyAggregate: { v: 0 } },
    ]);
    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client, NOW);
    expect(result.campaigns[0].storeOptions.map((option) => option.label)).toEqual(["샘플 상품 · A"]);
  });

  it("points mappingIndex at the mapping whose normalized option name matches (NFD / extra spaces)", async () => {
    m.productMappingFindMany.mockResolvedValue([
      mapping({ id: "pm-1", productName: "가짜크림", optionName: "1개" }),
      mapping({ id: "pm-2", productName: "가짜크림", optionName: " 샘플  2개 ".normalize("NFD") }),
    ]);
    m.snapshotFindMany.mockResolvedValue([
      aggregateRow("2026-10-02", {
        "sc-1": [
          { name: "가짜크림 · 샘플 2개", quantity: 3 },
          { name: "가짜크림 · 3개", quantity: 1 },
        ],
      }),
    ]);
    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client, NOW);
    const [first] = result.campaigns;
    expect(first.storeOptions.map((option) => [option.optionName, option.mappingIndex])).toEqual([
      ["샘플 2개", 1],
      ["3개", null],
    ]);
    expect(first.mappings[1].optionName).toBe(" 샘플  2개 ".normalize("NFD"));
  });

  it(`caps at ${MAX_STORE_OPTIONS_PER_CAMPAIGN} options per campaign and flags the cut`, async () => {
    m.snapshotFindMany.mockResolvedValue([
      aggregateRow("2026-10-02", {
        "sc-1": Array.from({ length: MAX_STORE_OPTIONS_PER_CAMPAIGN + 5 }, (_, index) => ({
          name: `샘플 상품 · 옵션 ${String(index).padStart(3, "0")}`,
          quantity: index + 1,
        })),
      }),
    ]);
    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client, NOW);
    const options = result.campaigns[0].storeOptions;
    expect(MAX_STORE_OPTIONS_PER_CAMPAIGN).toBe(100);
    expect(options).toHaveLength(MAX_STORE_OPTIONS_PER_CAMPAIGN);
    expect(options[0].quantity).toBe(MAX_STORE_OPTIONS_PER_CAMPAIGN + 5);
    expect(result.campaigns[0].storeOptionsTruncated).toBe(true);
  });

  describe("90-day window guard", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("flags storeOptionsWindowTruncated per campaign and warns at most once per read", async () => {
      m.orderCampaignFindMany.mockResolvedValue([campaign({ id: "oc-1" }), campaign({ id: "oc-2" }), campaign({ id: "oc-3" })]);
      m.salesCampaignFindMany.mockResolvedValue([
        { id: "sc-1", orderCampaignId: "oc-1", startDate: new Date("2026-04-01T00:00:00.000Z") },
        { id: "sc-2", orderCampaignId: "oc-2", startDate: new Date("2026-05-01T00:00:00.000Z") },
        { id: "sc-3", orderCampaignId: "oc-3", startDate: SALES_START },
      ]);
      const result = await readOrderCampaignMappings({ query: "가짜" }, client, NOW);
      expect(result.campaigns.map((row) => [row.id, row.storeOptionsWindowTruncated])).toEqual([
        ["oc-1", true],
        ["oc-2", true],
        ["oc-3", false],
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("2");
    });

    it("does not warn when no campaign hits the guard", async () => {
      await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client, NOW);
      expect(warn).not.toHaveBeenCalled();
    });

    it("carries the flag into structuredData", () => {
      const result = heavyResult();
      result.campaigns[1].storeOptionsWindowTruncated = true;
      const structured = buildOrderCampaignMappingsStructuredData(result)!;
      expect(structured.campaigns.map((row) => row.storeOptionsWindowTruncated)).toEqual([false, true]);
      expect(orderCampaignMappingsStructuredDataSchema.safeParse(structured).success).toBe(true);
    });
  });

  it("does not read snapshots when no campaign has a linked sales campaign", async () => {
    m.salesCampaignFindMany.mockResolvedValue([]);
    const result = await readOrderCampaignMappings({ orderCampaignId: "oc-1" }, client, NOW);
    expect(m.snapshotFindMany).not.toHaveBeenCalled();
    expect(result.campaigns[0]).toMatchObject({ storeOptions: [], storeOptionsTruncated: false, storeOptionsWindowTruncated: false });
  });

  it("keeps each campaign's options to its own sales campaigns and window", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign({ id: "oc-1" }), campaign({ id: "oc-2" })]);
    m.salesCampaignFindMany.mockResolvedValue([
      { id: "sc-1", orderCampaignId: "oc-1", startDate: SALES_START },
      { id: "sc-2", orderCampaignId: "oc-2", startDate: new Date("2026-10-10T00:00:00.000Z") },
    ]);
    m.snapshotFindMany.mockResolvedValue([
      aggregateRow("2026-10-02", { "sc-1": [{ name: "첫째 · 옵션", quantity: 1 }], "sc-2": [{ name: "둘째 · 이른 옵션", quantity: 1 }] }),
      aggregateRow("2026-10-11", { "sc-1": [], "sc-2": [{ name: "둘째 · 옵션", quantity: 2 }] }),
    ]);
    const result = await readOrderCampaignMappings({ query: "가짜" }, client, NOW);
    expect(m.snapshotFindMany.mock.calls[0][0]).toMatchObject({ where: { snapshotDate: { gte: "2026-10-01", lte: "2026-10-15" } } });
    expect(result.campaigns.map((row) => row.storeOptions.map((option) => option.label))).toEqual([
      ["첫째 · 옵션"],
      ["둘째 · 옵션"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// structuredData — 봇이 읽는 바이트 상한 안의 구조화 결과(2026-10-16)
// ---------------------------------------------------------------------------

function heavyResult(): OrderCampaignMappingsResult {
  return {
    truncated: false,
    campaigns: ["oc-1", "oc-2"].map((id) => ({
      id,
      name: `[샘플 공구] 테스트 기획전 ${id}`,
      sellerName: "샘플셀러",
      isActive: true,
      startDate: null,
      endDate: null,
      salesCampaignIds: [`sc-${id}`],
      mappings: Array.from({ length: 10 }, (_, index) => ({
        productName: "샘플 상품",
        optionName: `옵션 ${index}`,
        brandCode: `TC0001${String(index).padStart(2, "0")}`,
        price: 10_000 + index,
        linkedToDeal: false,
      })),
      storeOptions: Array.from({ length: 20 }, (_, index) => ({
        label: `샘플 상품 · 스토어 옵션 ${index}`,
        productName: "샘플 상품",
        optionName: `스토어 옵션 ${index}`,
        split: "single" as const,
        quantity: 100 - index,
        mappingIndex: null,
      })),
      storeOptionsTruncated: false,
      storeOptionsWindowTruncated: false,
    })),
  };
}
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("buildOrderCampaignMappingsStructuredData", () => {
  it("keeps a small result whole, with every truncation flag off", () => {
    const result = heavyResult();
    const structured = buildOrderCampaignMappingsStructuredData(result);
    expect(structured).toEqual({
      kind: "order_campaign_mappings",
      version: 1,
      truncated: false,
      campaigns: result.campaigns.map((row) => ({ ...row, mappingsTruncated: false })),
    });
    expect(orderCampaignMappingsStructuredDataSchema.safeParse(structured).success).toBe(true);
  });

  it("drops store options from the tail first (last campaign's last options), flagging the cut", () => {
    const full = buildOrderCampaignMappingsStructuredData(heavyResult())!;
    const limit = bytesOf(full) - 200;
    const structured = buildOrderCampaignMappingsStructuredData(heavyResult(), limit)!;
    expect(bytesOf(structured)).toBeLessThanOrEqual(limit);
    expect(structured.truncated).toBe(true);
    const [first, second] = structured.campaigns;
    expect(first.storeOptions).toHaveLength(20);
    expect(first.storeOptionsTruncated).toBe(false);
    expect(second.storeOptions.length).toBeLessThan(20);
    expect(second.storeOptions.length).toBeGreaterThan(0);
    expect(second.storeOptions.at(-1)?.label).toBe(`샘플 상품 · 스토어 옵션 ${second.storeOptions.length - 1}`);
    expect(second.storeOptionsTruncated).toBe(true);
    expect(second.mappings).toHaveLength(10);
    expect(second.mappingsTruncated).toBe(false);
  });

  it("drops mappings from the tail only after every store option is gone", () => {
    const withoutOptions = heavyResult();
    for (const row of withoutOptions.campaigns) row.storeOptions = [];
    const limit = bytesOf(buildOrderCampaignMappingsStructuredData(withoutOptions)!) - 150;
    const structured = buildOrderCampaignMappingsStructuredData(heavyResult(), limit)!;
    expect(bytesOf(structured)).toBeLessThanOrEqual(limit);
    for (const row of structured.campaigns) {
      expect(row.storeOptions).toEqual([]);
      expect(row.storeOptionsTruncated).toBe(true);
    }
    expect(structured.campaigns[0].mappings).toHaveLength(10);
    expect(structured.campaigns[0].mappingsTruncated).toBe(false);
    expect(structured.campaigns[1].mappings.length).toBeLessThan(10);
    expect(structured.campaigns[1].mappingsTruncated).toBe(true);
    expect(structured.truncated).toBe(true);
  });

  it("drops whole campaigns from the tail as the last resort, and gives up (null) only when nothing fits", () => {
    const structured = buildOrderCampaignMappingsStructuredData(heavyResult(), 120)!;
    expect(bytesOf(structured)).toBeLessThanOrEqual(120);
    expect(structured).toEqual({ kind: "order_campaign_mappings", version: 1, campaigns: [], truncated: true });
    expect(buildOrderCampaignMappingsStructuredData(heavyResult(), 10)).toBeNull();
  });

  it("never exceeds the default 12KB cap", () => {
    const result = heavyResult();
    for (const row of result.campaigns) {
      row.storeOptions = Array.from({ length: MAX_STORE_OPTIONS_PER_CAMPAIGN }, (_, index) => ({
        label: `${"가".repeat(40)} · ${index}`,
        productName: "가".repeat(40),
        optionName: String(index),
        split: "single" as const,
        quantity: 1,
        mappingIndex: null,
      }));
    }
    const structured = buildOrderCampaignMappingsStructuredData(result)!;
    expect(bytesOf(structured)).toBeLessThanOrEqual(MAX_STRUCTURED_DATA_BYTES);
    expect(orderCampaignMappingsStructuredDataSchema.safeParse(structured).success).toBe(true);
  });

  it("carries the campaign-match truncation through", () => {
    const structured = buildOrderCampaignMappingsStructuredData({ ...heavyResult(), truncated: true })!;
    expect(structured.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executor — 봇에게 가는 글과 결재함 기록
// ---------------------------------------------------------------------------

function job(input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: "job-ocm",
    idempotencyKey: "key-ocm",
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "none",
      operation: "get_order_campaign_mappings",
      input,
      origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
    },
    status: "RUNNING",
    workerId: "worker-1",
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    heartbeatAt: NOW,
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const deps: ExecutionDeps = {
  decideRoute: async () => ({ status: "ACCEPTED", route: "python", model: "python", reason: "deterministic" }),
  now: () => NOW,
};

async function run(input: AgentJobPayload["input"]) {
  const outcome = await executeAgentJob(job(input), deps);
  if (outcome.kind !== "terminal") throw new Error(`expected terminal, got ${outcome.kind}`);
  return outcome;
}

describe("get_order_campaign_mappings through the executor", () => {
  it("answers with a bounded summary, campaign evidence and a READ record", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign(), campaign({ id: "oc-2", name: "가짜셀러 - 둘째\n캠페인", isActive: false })]);
    m.productMappingFindMany.mockResolvedValue([
      mapping({ id: "pm-1", campaignDealId: "cd-1" }),
      mapping({ id: "pm-2", optionName: "2개", brandCode: "FAKE-002", price: 35_000 }),
      mapping({ id: "pm-3", campaignId: "oc-2", productName: "둘째크림" }),
    ]);
    m.salesCampaignFindMany.mockResolvedValue([
      { id: "sc-1", orderCampaignId: "oc-1", startDate: new Date("2026-10-01T00:00:00.000Z") },
    ]);

    const outcome = await run({ query: "가짜" });

    expect(outcome.toStatus).toBe("SUCCEEDED");
    const summary = outcome.result.resultSummary;
    expect(summary).toMatch(
      /^get_order_campaign_mappings campaigns=2 first=oc-1 name=가짜셀러\(김가짜\) - 가짜크림 캠페인\nget_order_campaign_mappings campaigns=2 mappings=3 truncated=false shownLines=5\/5\n/,
    );
    expect(summary).toContain("CAMPAIGN #1 id=oc-1 name=가짜셀러(김가짜) - 가짜크림 캠페인 seller=가짜셀러(김가짜) active=yes");
    expect(summary).toContain("salesCampaignIds=sc-1 mappings=2");
    expect(summary).toContain("  #1 가짜크림 | 1개 | code=FAKE-001 | price=19900 | linkedToDeal=yes");
    expect(summary).toContain("  #1 가짜크림 | 2개 | code=FAKE-002 | price=35000 | linkedToDeal=no");
    expect(summary).toContain("CAMPAIGN #2 id=oc-2 name=가짜셀러 - 둘째 캠페인");
    expect(summary).toContain("salesCampaignIds=none mappings=1");
    expect(outcome.result.evidenceRefs).toEqual(["oc-1", "oc-2"]);

    expect(m.proposalCreate).toHaveBeenCalledTimes(1);
    const recorded = m.proposalCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    const recordedJson = JSON.stringify(recorded);
    expect(recordedJson).toContain("주문캠페인 2건 · 매핑 3줄");
    expect(recordedJson).toContain("OrderCampaign");
    expect(recordedJson).toContain("ProductMapping");
    expect(recordedJson).toContain("SalesCampaign");
    expect(recordedJson).not.toContain("cd-1");
  });

  it("an unknown id succeeds with zero campaigns", async () => {
    const outcome = await run({ orderCampaignId: "missing" });
    expect(outcome.toStatus).toBe("SUCCEEDED");
    expect(outcome.result.resultSummary).toBe(
      "get_order_campaign_mappings campaigns=0 first=none name=none\n" +
        "get_order_campaign_mappings campaigns=0 mappings=0 truncated=false shownLines=0/0",
    );
    expect(outcome.result.structuredData).toEqual({ kind: "order_campaign_mappings", version: 1, campaigns: [], truncated: false });
    expect(outcome.result.evidenceRefs).toEqual([]);
  });

  it("keeps the summary inside the result limit when mappings are many", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign()]);
    m.productMappingFindMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => mapping({ id: `pm-${index}`, optionName: `옵션 ${index}` })),
    );
    const outcome = await run({ orderCampaignId: "oc-1" });
    expect(outcome.result.resultSummary.length).toBeLessThanOrEqual(MAX_RESULT_SUMMARY_CHARS);
    expect(outcome.result.resultSummary).toMatch(
      /^get_order_campaign_mappings campaigns=1 first=oc-1 name=[^\n]+\nget_order_campaign_mappings campaigns=1 mappings=200 truncated=false shownLines=\d+\/201\n/,
    );
  });

  it("carries the read result as typed structuredData and keeps the first summary line short for the router", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign()]);
    m.productMappingFindMany.mockResolvedValue([mapping()]);
    m.salesCampaignFindMany.mockResolvedValue([{ id: "sc-1", orderCampaignId: "oc-1", startDate: SALES_START }]);
    m.snapshotFindMany.mockResolvedValue([aggregateRow("2026-10-02", { "sc-1": [{ name: "가짜크림 · 1개", quantity: 2 }] })]);

    const outcome = await run({ orderCampaignId: "oc-1" });

    const structured = orderCampaignMappingsStructuredDataSchema.parse(outcome.result.structuredData);
    expect(structured).toEqual({
      kind: "order_campaign_mappings",
      version: 1,
      truncated: false,
      campaigns: [
        {
          id: "oc-1",
          name: "가짜셀러(김가짜) - 가짜크림 캠페인",
          sellerName: "가짜셀러(김가짜)",
          isActive: true,
          startDate: "2026-10-01T00:00:00.000Z",
          endDate: "2026-10-31T00:00:00.000Z",
          salesCampaignIds: ["sc-1"],
          mappings: [{ productName: "가짜크림", optionName: "1개", brandCode: "FAKE-001", price: 19_900, linkedToDeal: false }],
          mappingsTruncated: false,
          storeOptions: [
            { label: "가짜크림 · 1개", productName: "가짜크림", optionName: "1개", split: "single", quantity: 2, mappingIndex: 0 },
          ],
          storeOptionsTruncated: false,
          storeOptionsWindowTruncated: false,
        },
      ],
    });
    const firstLine = outcome.result.resultSummary.split("\n")[0];
    expect(firstLine).toBe("get_order_campaign_mappings campaigns=1 first=oc-1 name=가짜셀러(김가짜) - 가짜크림 캠페인");
  });

  it("truncates the first-line name to 60 characters and the whole first line to 200", async () => {
    const longName = `${"가".repeat(70)}\n둘째 줄`;
    m.orderCampaignFindMany.mockResolvedValue([campaign({ id: `oc-${"x".repeat(120)}`, name: longName })]);
    const outcome = await run({ query: "가" });
    const firstLine = outcome.result.resultSummary.split("\n")[0];
    expect(firstLine.length).toBeLessThanOrEqual(200);
    expect(firstLine).toContain(`name=${"가".repeat(60)}`.slice(0, 200 - firstLine.indexOf("name=")));
    expect(firstLine).not.toContain("가".repeat(61));
  });

  it("never lets the durable result or the RPC frame overflow, even for ten heavy campaigns", async () => {
    const campaigns = Array.from({ length: MAX_ORDER_CAMPAIGN_MATCHES }, (_, index) =>
      campaign({ id: `oc-${index}`, name: `${"가짜".repeat(40)} ${index}` }),
    );
    m.orderCampaignFindMany.mockResolvedValue(campaigns);
    m.productMappingFindMany.mockResolvedValue(
      campaigns.flatMap((row) =>
        Array.from({ length: 60 }, (_, index) =>
          mapping({ id: `${row.id}-pm-${index}`, campaignId: row.id, productName: "가짜크림 대용량 세트", optionName: `옵션 ${"나".repeat(30)} ${index}` }),
        ),
      ),
    );
    m.salesCampaignFindMany.mockResolvedValue(
      campaigns.map((row) => ({ id: `sc-${row.id}`, orderCampaignId: row.id, startDate: SALES_START })),
    );
    m.snapshotFindMany.mockResolvedValue([
      aggregateRow(
        "2026-10-02",
        Object.fromEntries(
          campaigns.map((row) => [
            `sc-${row.id}`,
            Array.from({ length: 120 }, (_, index) => ({ name: `가짜크림 대용량 · 옵션 ${"다".repeat(20)} ${index}`, quantity: index + 1 })),
          ]),
        ),
      ),
    ]);

    const outcome = await run({ query: "가짜" });

    expect(outcome.toStatus).toBe("SUCCEEDED");
    const structuredBytes = Buffer.byteLength(JSON.stringify(outcome.result.structuredData), "utf8");
    expect(structuredBytes).toBeLessThanOrEqual(MAX_STRUCTURED_DATA_BYTES);
    expect(() => serializeAgentJobJson(outcome.result, false)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(outcome.result), "utf8")).toBeLessThanOrEqual(MAX_AGENT_JOB_JSON_BYTES);
    const structured = orderCampaignMappingsStructuredDataSchema.parse(outcome.result.structuredData);
    expect(structured.truncated).toBe(true);
    // 앞 캠페인이 뒤 캠페인보다 먼저 남는다(뒤에서부터 덜어 낸다).
    expect(structured.campaigns[0].id).toBe("oc-0");
    // RPC 응답(toView 모양 + 봉투)도 소켓 프레임 상한 안이다.
    const frame = JSON.stringify({
      id: "rpc-1",
      result: {
        jobId: "job-ocm",
        status: "SUCCEEDED",
        attempt: 0,
        failureCode: null,
        result: outcome.result,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        settled: true,
      },
    });
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThan(MAX_FRAME_BYTES);
  });

  it("keeps the READ record's mapping table when store options push it past 64KB (options are trimmed first)", async () => {
    const campaigns = Array.from({ length: MAX_ORDER_CAMPAIGN_MATCHES }, (_, index) => campaign({ id: `oc-${index}` }));
    m.orderCampaignFindMany.mockResolvedValue(campaigns);
    m.productMappingFindMany.mockResolvedValue(
      campaigns.flatMap((row) =>
        Array.from({ length: 20 }, (_, index) =>
          mapping({ id: `${row.id}-pm-${index}`, campaignId: row.id, optionName: `옵션 ${index}` }),
        ),
      ),
    );
    m.salesCampaignFindMany.mockResolvedValue(
      campaigns.map((row) => ({ id: `sc-${row.id}`, orderCampaignId: row.id, startDate: SALES_START })),
    );
    m.snapshotFindMany.mockResolvedValue([
      aggregateRow(
        "2026-10-02",
        Object.fromEntries(
          campaigns.map((row) => [
            `sc-${row.id}`,
            Array.from({ length: MAX_STORE_OPTIONS_PER_CAMPAIGN }, (_, index) => ({
              name: `가짜크림 대용량 · 옵션 ${"라".repeat(30)} ${index}`,
              quantity: index + 1,
            })),
          ]),
        ),
      ),
    ]);

    const outcome = await run({ query: "가짜" });
    expect(outcome.toStatus).toBe("SUCCEEDED");

    const recorded = m.proposalCreate.mock.calls[0][0] as {
      data: { structuredResult: { truncated: boolean; data: OrderCampaignMappingsResult & { truncated: boolean } } };
    };
    const { structuredResult } = recorded.data;
    // 마커({truncated, bytes})로 통째로 바뀌지 않았다 — 표가 남는다.
    expect(structuredResult.truncated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(structuredResult.data), "utf8")).toBeLessThanOrEqual(MAX_READ_RESULT_BYTES);
    expect(structuredResult.data.truncated).toBe(true);
    for (const row of structuredResult.data.campaigns) expect(row.mappings).toHaveLength(20);
    expect(structuredResult.data.campaigns.at(-1)?.storeOptionsTruncated).toBe(true);
    expect(structuredResult.data.campaigns[0].storeOptions.length).toBeGreaterThan(0);
  });

  it("reports a denied column as DB_PERMISSION_DENIED instead of an empty answer", async () => {
    m.orderCampaignFindMany.mockRejectedValue(Object.assign(new Error("permission denied for table OrderCampaign"), { code: "42501" }));
    const outcome = await run({ orderCampaignId: "oc-1" });
    expect(outcome).toMatchObject({ toStatus: "FAILED_FINAL", errorClass: "DB_PERMISSION_DENIED" });
  });
});
