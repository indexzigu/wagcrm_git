/**
 * 판매캠페인 품목(T-271) — 봇 조회 `get_campaign_items` 와 기안 `add_campaign_items` 의 기안 시점 확인.
 *
 * 워커 역할은 CampaignDeal 에 **칸 단위** SELECT 만 받는다(20261027120000). 그래서 그 표의 Prisma 호출은 모두 명시
 * `select` 여야 하고, 고른 칸(과 where 가 닿는 칸)이 마이그레이션의 GRANT 목록 안에 있어야 한다 — 기본 select 는 수량·
 * 원가 같은 닫힌 칸에 닿아 운영에서 권한 거부로 끝난다. 이름은 전부 가짜다(공개 레포).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";

const { m, fakeClient } = vi.hoisted(() => {
  const m = {
    salesCampaignFindUnique: vi.fn(),
    salesCampaignFindMany: vi.fn(),
    dealFindUnique: vi.fn(),
    dealFindMany: vi.fn(),
    sellerFindMany: vi.fn(),
    campaignDealFindMany: vi.fn(),
    proposalCreate: vi.fn(),
    proposalEventCreate: vi.fn(),
  };
  const fakeClient = {
    salesCampaign: {
      findUnique: (args: unknown) => m.salesCampaignFindUnique(args),
      findMany: (args: unknown) => m.salesCampaignFindMany(args),
    },
    deal: { findUnique: (args: unknown) => m.dealFindUnique(args), findMany: (args: unknown) => m.dealFindMany(args) },
    seller: { findMany: (args: unknown) => m.sellerFindMany(args) },
    campaignDeal: { findMany: (args: unknown) => m.campaignDealFindMany(args) },
    actionProposal: { create: (args: unknown) => m.proposalCreate(args) },
    actionProposalEvent: { create: (args: unknown) => m.proposalEventCreate(args) },
  };
  return { m, fakeClient };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    ...fakeClient,
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => callback(fakeClient),
  }),
}));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));

import { executeAgentJob, type ExecutionDeps } from "../executor";
import { buildCampaignItemsSummary, readCampaignItems, MAX_OPTIONS_PER_CAMPAIGN } from "../campaign-items";
import { AgentJobPayloadSchema, createActionProposalInputSchema } from "../contracts";
import { describeCampaignItemsProposal } from "@/lib/agent/tools/add-campaign-items";

const client = fakeClient as unknown as PrismaClient;
const NOW = new Date("2026-10-27T03:00:00.000Z");

const MIGRATION = readFileSync(
  path.join(process.cwd(), "prisma/migrations/20261027120000_grant_agent_worker_campaign_item_reads/migration.sql"),
  "utf8",
);
function grantedColumns(table: string): string[] {
  const match = MIGRATION.match(new RegExp(`GRANT SELECT \\(([^)]*)\\) ON TABLE "${table}" TO wag_agent_worker`));
  if (!match) throw new Error(`no column grant for ${table}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((column) => column[1]);
}

/** CampaignDeal 호출마다: 명시 select · 중첩 관계 없음 · select·where 칸이 모두 GRANT 안. */
function expectCampaignDealCallsWithinGrant(): void {
  const granted = grantedColumns("CampaignDeal");
  expect(m.campaignDealFindMany).toHaveBeenCalled();
  for (const [args] of m.campaignDealFindMany.mock.calls) {
    const { select, where } = args as { select?: Record<string, unknown>; where?: Record<string, unknown> };
    expect(select, "every worker-role query needs an explicit select").toBeDefined();
    for (const value of Object.values(select!)) expect(value, "no nested relation select").toBe(true);
    for (const column of [...Object.keys(select!), ...Object.keys(where ?? {})]) expect(granted).toContain(column);
  }
}

const campaignRow = {
  id: "sc-1",
  dealId: "main-1",
  sellerId: "slr-1",
  roundNumber: 2,
  status: "ACTIVE",
  startDate: new Date("2026-10-01T00:00:00.000Z"),
  endDate: new Date("2026-10-07T00:00:00.000Z"),
};

beforeEach(() => {
  for (const mock of Object.values(m)) mock.mockReset();
  m.salesCampaignFindUnique.mockResolvedValue(campaignRow);
  m.salesCampaignFindMany.mockResolvedValue([campaignRow]);
  m.dealFindUnique.mockResolvedValue({ id: "main-1", dealName: "가짜크림", dealType: "MAIN" });
  m.dealFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if ("parentDealId" in args.where) {
      return [
        { id: "opt-1", parentDealId: "main-1", dealName: "가짜크림 1개", sellingPrice: 10_000 },
        { id: "opt-2", parentDealId: "main-1", dealName: "가짜크림 2개입", sellingPrice: 19_000 },
        ...(args.where.dealType === "OPTION" && !("in" in Object(args.where.parentDealId))
          ? [{ id: "opt-3", parentDealId: "main-1", dealName: "가짜크림 - 3개입", sellingPrice: 27_000 }]
          : []),
      ];
    }
    if ("id" in args.where) return [{ id: "main-1", dealName: "가짜크림", sellingPrice: 10_000 }];
    return [{ id: "opt-2", parentDealId: "main-1" }];
  });
  m.sellerFindMany.mockResolvedValue([{ id: "slr-1", name: "가짜셀러", alias: "가짜별칭" }]);
  m.campaignDealFindMany.mockResolvedValue([{ campaignId: "sc-1", dealId: "opt-1" }]);
  m.proposalCreate.mockResolvedValue({ id: "proposal-1" });
  m.proposalEventCreate.mockResolvedValue({});
});

describe("readCampaignItems", () => {
  it("reads one campaign by id: main deal, its options with in-campaign marks, seller alias first", async () => {
    const result = await readCampaignItems({ campaignId: "sc-1" }, client);

    expect(result).toEqual({
      truncated: false,
      campaigns: [
        {
          id: "sc-1",
          sellerName: "가짜별칭",
          roundNumber: 2,
          status: "ACTIVE",
          startDate: "2026-10-01",
          endDate: "2026-10-07",
          mainDeal: { id: "main-1", name: "가짜크림", sellingPrice: 10_000, inCampaign: false },
          options: [
            { id: "opt-1", name: "가짜크림 1개", sellingPrice: 10_000, inCampaign: true },
            { id: "opt-2", name: "가짜크림 2개입", sellingPrice: 19_000, inCampaign: false },
          ],
          optionsTruncated: false,
          itemCount: 1,
        },
      ],
    });
    expectCampaignDealCallsWithinGrant();
  });

  it("query matches deal or seller names in both Hangul forms, and an option name finds its main deal's campaign", async () => {
    await readCampaignItems({ query: " 샘플 공구 " }, client);

    const dealQuery = m.dealFindMany.mock.calls[0][0] as { where: { OR: unknown[] } };
    expect(dealQuery.where.OR).toEqual([
      { dealName: { contains: "샘플 공구".normalize("NFC"), mode: "insensitive" } },
      { dealName: { contains: "샘플 공구".normalize("NFD"), mode: "insensitive" } },
    ]);
    const campaignQuery = m.salesCampaignFindMany.mock.calls[0][0] as { where: { OR: unknown[] } };
    // 하위품목(opt-2)이 맞으면 그 상위 판매 조건(main-1)의 캠페인을 찾는다.
    expect(campaignQuery.where.OR).toEqual([{ dealId: { in: ["main-1"] } }, { sellerId: { in: ["slr-1"] } }]);
  });

  it("caps options per campaign and marks the cut", async () => {
    m.dealFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      "parentDealId" in args.where
        ? Array.from({ length: MAX_OPTIONS_PER_CAMPAIGN + 1 }, (_, index) => ({
            id: `opt-${index}`,
            parentDealId: "main-1",
            dealName: `가짜 ${index}`,
            sellingPrice: 1_000,
          }))
        : [{ id: "main-1", dealName: "가짜크림", sellingPrice: 10_000 }],
    );
    const result = await readCampaignItems({ campaignId: "sc-1" }, client);
    expect(result.campaigns[0].options).toHaveLength(MAX_OPTIONS_PER_CAMPAIGN);
    expect(result.campaigns[0].optionsTruncated).toBe(true);
  });
});

describe("buildCampaignItemsSummary", () => {
  it("lists the campaign, its main deal and each option with ids the bot can reuse", async () => {
    const { summary, optionCount } = buildCampaignItemsSummary(await readCampaignItems({ campaignId: "sc-1" }, client));
    expect(optionCount).toBe(2);
    expect(summary).toBe(
      [
        "get_campaign_items: 1 campaign(s)",
        "campaign=sc-1 셀러「가짜별칭」 2차 status=ACTIVE 2026-10-01~2026-10-07 품목 1줄",
        "  mainDeal=main-1 판매 조건「가짜크림」 10,000원 (품목에 없음)",
        "  하위품목 dealId=opt-1 「가짜크림 1개」 10,000원 (품목에 있음)",
        "  하위품목 dealId=opt-2 「가짜크림 2개입」 19,000원 (품목에 없음)",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// executor — 조회 · 기안 시점 확인
// ---------------------------------------------------------------------------

function job(operation: AgentJobPayload["operation"], input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: "job-ci",
    idempotencyKey: "key-ci",
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "none",
      operation,
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

async function run(operation: AgentJobPayload["operation"], input: AgentJobPayload["input"]) {
  const outcome = await executeAgentJob(job(operation, input), deps);
  if (outcome.kind !== "terminal") throw new Error(`expected terminal, got ${outcome.kind}`);
  return outcome;
}

describe("get_campaign_items through the executor", () => {
  it("answers with the summary, campaign evidence and a READ record", async () => {
    const outcome = await run("get_campaign_items", { campaignId: "sc-1" });
    expect(outcome.toStatus).toBe("SUCCEEDED");
    expect(outcome.result.resultSummary).toContain("하위품목 dealId=opt-2 「가짜크림 2개입」 19,000원 (품목에 없음)");
    expect(outcome.result.evidenceRefs).toEqual(["sc-1"]);
    const recorded = JSON.stringify(m.proposalCreate.mock.calls[0][0]);
    expect(recorded).toContain("판매캠페인 1건 · 하위품목 2개");
    expect(recorded).toContain("CampaignDeal");
  });

  it("the job envelope accepts exactly one of campaignId / query (checked at submit, before the executor)", () => {
    const parses = (input: Record<string, unknown>) =>
      AgentJobPayloadSchema.safeParse({ ...job("get_campaign_items", {}).payload, input }).success;
    expect(parses({ campaignId: "sc-1" })).toBe(true);
    expect(parses({ query: "가짜" })).toBe(true);
    expect(parses({})).toBe(false);
    expect(parses({ campaignId: "sc-1", query: "가짜" })).toBe(false);
  });
});

describe("create_action_proposal — add_campaign_items (기안 시점 확인)", () => {
  const base = { action: "add_campaign_items", campaignId: "sc-1", mainDealId: "main-1" } as const;

  it("creates a PENDING_APPROVAL proposal targeting the campaign with an id-free title", async () => {
    const outcome = await run("create_action_proposal", {
      ...base,
      items: [{ dealName: "가짜크림 3개입", sellingPrice: 27_000 }, { dealId: "opt-2" }],
    });

    expect(outcome.toStatus).toBe("NEEDS_APPROVAL");
    const created = m.proposalCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({
      status: "PENDING_APPROVAL",
      targetEntityType: "CAMPAIGN",
      targetEntityId: "sc-1",
      title: "캠페인 품목 2건 추가: 새 하위품목 「가짜크림 3개입」 27,000원 / 기존 하위품목 연결 1건",
    });
    expect(String(created.data.title)).not.toContain("opt-2");
    expectCampaignDealCallsWithinGrant();
  });

  it.each([
    ["mainDealId 가 지금 판매 조건과 다름", { mainDealId: "main-9", items: [{ dealId: "opt-2" }] }, /지금 판매 조건과 다릅니다/],
    ["판매 조건 밑이 아닌 하위품목", { items: [{ dealId: "opt-other" }] }, /하위품목이 아닙니다/],
    ["이미 품목에 있는 하위품목", { items: [{ dealId: "opt-1" }] }, /이미 판매캠페인 품목에 있습니다/],
    ["같은 이름 하위품목이 이미 있음", { items: [{ dealName: "가짜크림  2개입", sellingPrice: 1 }] }, /dealId opt-2.*dealId 로 연결/],
    // 화면이 저장한 「판매 조건 이름 - 옵션 이름」과 옵션 이름만 보낸 줄도 같은 하위품목이다(`campaignOptionNameKey`).
    ["옵션 이름만 보냈는데 「판매 조건 - 옵션」이 이미 있음", { items: [{ dealName: "3개입", sellingPrice: 1 }] }, /dealId opt-3.*dealId 로 연결/],
  ])("fails with a reason the bot can act on: %s", async (_label, overrides, detail) => {
    const outcome = await run("create_action_proposal", { ...base, ...overrides } as never);
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(outcome.result.resultSummary).toMatch(/TARGET_NOT_FOUND/);
    expect(outcome.result.resultSummary).toMatch(detail);
    expect(m.proposalCreate).not.toHaveBeenCalled();
  });

  it("a deal with a unit needs unitQuantity on new rows (the screen's rule)", async () => {
    m.dealFindUnique.mockResolvedValue({ id: "main-1", dealName: "가짜크림", dealType: "MAIN", unit: "개" });
    const missing = await run("create_action_proposal", { ...base, items: [{ dealName: "새 구성", sellingPrice: 1 }] });
    expect(missing.toStatus).toBe("FAILED_FINAL");
    expect(missing.result.resultSummary).toMatch(/unitQuantity 가 필요합니다/);
    // 옵션 이름이 달라도 수량이 같으면 같은 이름(「가짜크림 - 3개」)으로 저장된다 — 기안 안 중복으로 막는다.
    const twice = await run("create_action_proposal", {
      ...base,
      items: [
        { dealName: "가", sellingPrice: 1, unitQuantity: 3 },
        { dealName: "나", sellingPrice: 1, unitQuantity: 3 },
      ],
    });
    expect(twice.toStatus).toBe("FAILED_FINAL");
    expect(twice.result.resultSummary).toMatch(/같은 이름\(「가짜크림 - 3개」\)/);
    // 수량으로 만든 이름(「가짜크림 - 3개」)이 이미 있는 「가짜크림 - 3개입」과는 다른 이름이라 통과한다.
    const ok = await run("create_action_proposal", { ...base, items: [{ dealName: "새 구성", sellingPrice: 1, unitQuantity: 3 }] });
    expect(ok.toStatus).toBe("NEEDS_APPROVAL");
  });

  it("refuses when the campaign's own deal is an option (no options under an option)", async () => {
    m.dealFindUnique.mockResolvedValue({ id: "main-1", dealName: "가짜크림", dealType: "OPTION" });
    const outcome = await run("create_action_proposal", { ...base, items: [{ dealName: "새 구성", sellingPrice: 1 }] });
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(outcome.result.resultSummary).toMatch(/하위품목이라 그 밑에/);
  });
});

describe("add_campaign_items contract", () => {
  const accepts = (value: unknown) => createActionProposalInputSchema.safeParse(value).success;
  const base = { action: "add_campaign_items", campaignId: "sc-1", mainDealId: "main-1" };

  it("each row is exactly one of link (dealId only) or create (dealName + sellingPrice)", () => {
    expect(accepts({ ...base, items: [{ dealId: "opt-2" }] })).toBe(true);
    expect(accepts({ ...base, items: [{ dealName: "새 구성", sellingPrice: 9_900, totalCommissionRate: 18, unitQuantity: 3 }] })).toBe(true);
    expect(accepts({ ...base, items: [{}] })).toBe(false);
    expect(accepts({ ...base, items: [{ dealId: "opt-2", dealName: "둘 다" }] })).toBe(false);
    expect(accepts({ ...base, items: [{ dealId: "opt-2", sellingPrice: 1 }] })).toBe(false);
    expect(accepts({ ...base, items: [{ dealName: "가격 없음" }] })).toBe(false);
    expect(accepts({ ...base, items: [{ dealName: "음수", sellingPrice: -1 }] })).toBe(false);
    expect(accepts({ ...base, items: [{ dealName: "요율 100", sellingPrice: 1, totalCommissionRate: 100 }] })).toBe(false);
    expect(accepts({ ...base, items: [] })).toBe(false);
  });

  it("same name with different unit quantities is not a duplicate at the contract level (named by quantity under a unit)", () => {
    expect(
      accepts({
        ...base,
        items: [
          { dealName: "구성", sellingPrice: 1, unitQuantity: 3 },
          { dealName: "구성", sellingPrice: 1, unitQuantity: 5 },
        ],
      }),
    ).toBe(true);
  });

  it("rejects duplicates inside one proposal (same dealId, or same name after normalization)", () => {
    expect(accepts({ ...base, items: [{ dealId: "opt-2" }, { dealId: "opt-2" }] })).toBe(false);
    expect(
      accepts({ ...base, items: [{ dealName: "새 구성", sellingPrice: 1 }, { dealName: " 새  구성", sellingPrice: 2 }] }),
    ).toBe(false);
  });

  it("title keeps names in brackets and folds rows beyond three", () => {
    expect(
      describeCampaignItemsProposal({
        items: [1, 2, 3, 4].map((n) => ({ dealName: `구성 ${n}`, sellingPrice: n * 1_000 })),
      }),
    ).toBe("캠페인 품목 4건 추가: 새 하위품목 「구성 1」 1,000원 · 「구성 2」 2,000원 · 「구성 3」 3,000원 외 1건");
  });
});
