/**
 * get_order_campaign_mappings(2026-10-15) — 주문캠페인과 그 상품 매핑 읽기.
 *
 * 워커 역할은 이 두 표에 **칸 단위** SELECT 만 받는다(20261016120000). 그래서 이 조회의 Prisma 호출은
 * 모두 명시 `select` 여야 하고, 고른 칸이 마이그레이션의 GRANT 목록 안에 있어야 한다 — 기본 select 는
 * `toEmail` 같은 닫힌 칸에 닿아 운영에서 권한 거부로 끝난다. 이름은 전부 가짜다(공개 레포).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";

const { m, fakeClient } = vi.hoisted(() => {
  const m = {
    orderCampaignFindMany: vi.fn(),
    productMappingFindMany: vi.fn(),
    salesCampaignFindMany: vi.fn(),
    proposalCreate: vi.fn(),
    proposalEventCreate: vi.fn(),
  };
  const fakeClient = {
    orderCampaign: { findMany: (args: unknown) => m.orderCampaignFindMany(args) },
    productMapping: { findMany: (args: unknown) => m.productMappingFindMany(args) },
    salesCampaign: { findMany: (args: unknown) => m.salesCampaignFindMany(args) },
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
import { MAX_ORDER_CAMPAIGN_MATCHES, MAX_RESULT_SUMMARY_CHARS } from "../contracts";
import { readOrderCampaignMappings } from "../order-campaign-mappings";

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
  m.proposalCreate.mockReset();
  m.proposalEventCreate.mockReset();
  m.orderCampaignFindMany.mockResolvedValue([]);
  m.productMappingFindMany.mockResolvedValue([]);
  m.salesCampaignFindMany.mockResolvedValue([]);
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
      { id: "sc-2", orderCampaignId: "oc-1" },
      { id: "sc-9", orderCampaignId: "oc-2" },
      { id: "sc-1", orderCampaignId: "oc-1" },
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
    expect(salesColumns.sort()).toEqual(["id", "orderCampaignId"]);
  });

  it("refuses an input with neither or both selectors (the contract already does; this is the second gate)", async () => {
    await expect(readOrderCampaignMappings({}, client)).rejects.toThrow();
    await expect(readOrderCampaignMappings({ orderCampaignId: "oc-1", query: "가짜" }, client)).rejects.toThrow();
    expect(m.orderCampaignFindMany).not.toHaveBeenCalled();
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
    m.salesCampaignFindMany.mockResolvedValue([{ id: "sc-1", orderCampaignId: "oc-1" }]);

    const outcome = await run({ query: "가짜" });

    expect(outcome.toStatus).toBe("SUCCEEDED");
    const summary = outcome.result.resultSummary;
    expect(summary).toMatch(/^get_order_campaign_mappings campaigns=2 mappings=3 truncated=false shownLines=5\/5\n/);
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
      "get_order_campaign_mappings campaigns=0 mappings=0 truncated=false shownLines=0/0",
    );
    expect(outcome.result.evidenceRefs).toEqual([]);
  });

  it("keeps the summary inside the result limit when mappings are many", async () => {
    m.orderCampaignFindMany.mockResolvedValue([campaign()]);
    m.productMappingFindMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => mapping({ id: `pm-${index}`, optionName: `옵션 ${index}` })),
    );
    const outcome = await run({ orderCampaignId: "oc-1" });
    expect(outcome.result.resultSummary.length).toBeLessThanOrEqual(MAX_RESULT_SUMMARY_CHARS);
    expect(outcome.result.resultSummary).toMatch(/^get_order_campaign_mappings campaigns=1 mappings=200 truncated=false shownLines=\d+\/201\n/);
  });

  it("reports a denied column as DB_PERMISSION_DENIED instead of an empty answer", async () => {
    m.orderCampaignFindMany.mockRejectedValue(Object.assign(new Error("permission denied for table OrderCampaign"), { code: "42501" }));
    const outcome = await run({ orderCampaignId: "oc-1" });
    expect(outcome).toMatchObject({ toStatus: "FAILED_FINAL", errorClass: "DB_PERMISSION_DENIED" });
  });
});
