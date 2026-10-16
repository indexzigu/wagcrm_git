/**
 * 봇 상품 매핑 즉시 저장(`applyProductMappings`) — 창구 본체를 **실 SQLite**(격리 임시 파일)로 고정한다.
 *
 * 진짜: 기안 INSERT(`insertAgentWorkerProposal`) · 지금 값 스냅샷 · 정본 승인 함수(`approveProposal` tx1/tx2) ·
 *       매핑 실행 동작(`upsert-product-mappings` 의 사람 승인 가드·이름 대조·조건부 쓰기).
 * 가짜: 네이버(주입한 상품 목록·상세 응답), 커밋 뒤 후속 처리(`applyWriteActionEffects` — 자동 연결·캐시).
 *
 * 설계 정본 불변(§3): 매핑 줄의 키(optionName)는 언제나 네이버 등록 옵션 글자다 — 코드표 이름은 어떤 경로로도
 * optionName 이 되지 않는다. 아래 「코드표 이름은 저장되지 않는다」가 그 불변을 고정한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushSqliteTestSchema } from "@/test/sqlite-test-db";

const REPO_ROOT = process.cwd();
let tmpDir: string;
let realPrisma: any;

vi.mock("@/lib/prisma", () => ({ getPrisma: () => realPrisma }));
vi.mock("@/lib/prisma-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma-client")>();
  return { ...actual, isSqliteDatabaseUrl: () => true };
});
const effectsCalls: unknown[] = [];
vi.mock("@/lib/agent/write-action-effects", () => ({
  applyWriteActionEffects: (...args: unknown[]) => {
    effectsCalls.push(args);
  },
}));

const { applyProductMappings } = await import("../apply-product-mappings");
const { AGENT_MAPPING_APPLY_ACTOR } = await import("../actors");
const { resetStoreOptionsCacheForTest, STORE_OPTIONS_REUSE_MS } = await import("../store-product-options");
type StoreOptionsDeps = import("../store-product-options").StoreOptionsDeps;

const CAMPAIGN_ID = "cmtestordercampaign000000001";
const CAMPAIGN_NAME = "[샘플 공구] 테스트 기획전";
const ORIGIN_NO = "9000000001";
const CHANNEL_NO = "8000000001";
const STORE_PRODUCT_NAME = "샘플 유산균 기획전";
const OPTION_A = "구성: 1박스 (30포)";
const OPTION_B = "구성: 2박스 (60포)";
const SHEET_ONLY_NAME = "샘플 유산균 1BOX";

let now = 1_800_000_000_000;
let listCalls = 0;
let detailCalls = 0;

function detailBody(optionNames: string[]) {
  return {
    smartstoreChannelProduct: { name: STORE_PRODUCT_NAME },
    originProduct: {
      salePrice: 30000,
      detailAttribute: {
        optionInfo: {
          optionCombinationGroupNames: { optionGroupName1: "구성" },
          optionCombinations: optionNames.map((name, index) => ({
            optionName1: name.replace("구성: ", ""),
            price: index * 25000,
          })),
        },
      },
    },
  };
}

let storeOptionNames = [OPTION_A, OPTION_B];

const storeDeps: StoreOptionsDeps = {
  listProducts: async () => {
    listCalls += 1;
    return [{ originProductNo: ORIGIN_NO, channelProducts: [{ channelProductNo: CHANNEL_NO, name: STORE_PRODUCT_NAME }] }];
  },
  fetchChannelProduct: async () => {
    detailCalls += 1;
    return detailBody(storeOptionNames);
  },
  findOrderCampaign: (id) =>
    realPrisma.orderCampaign.findUnique({ where: { id }, select: { id: true, name: true, productId: true } }),
  now: () => now,
};

async function mappings() {
  return realPrisma.productMapping.findMany({
    where: { campaignId: CAMPAIGN_ID },
    select: { optionName: true, productName: true, brandCode: true, price: true, campaignDealId: true },
    orderBy: { optionName: "asc" },
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-agent-apply-"));
  const dbPath = join(tmpDir, "test.db");
  pushSqliteTestSchema(dbPath, REPO_ROOT);
  const generatedClientPath = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite", "index.js");
  const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
  realPrisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
}, 60_000);

afterAll(async () => {
  await realPrisma?.$disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await realPrisma.actionProposalEvent.deleteMany({});
  await realPrisma.actionProposal.deleteMany({});
  await realPrisma.productMapping.deleteMany({});
  await realPrisma.orderCampaign.deleteMany({});
  await realPrisma.orderCampaign.create({
    data: { id: CAMPAIGN_ID, name: CAMPAIGN_NAME, sellerName: "샘플 셀러", productId: ORIGIN_NO },
  });
  resetStoreOptionsCacheForTest();
  storeOptionNames = [OPTION_A, OPTION_B];
  listCalls = 0;
  detailCalls = 0;
  effectsCalls.length = 0;
  now += STORE_OPTIONS_REUSE_MS * 10;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("즉시 저장 — 「응」 한 번이 승인이다", () => {
  it("새 줄은 스토어 옵션 글자·스토어 상품명으로 바로 저장되고 결재함에 EXECUTED 기록 1건이 남는다", async () => {
    const result = await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] },
      { storeOptions: storeDeps },
    );

    expect(result).toMatchObject({ ok: true, data: { created: 1, updated: 0, unchanged: 0, rejected: [] } });
    expect(await mappings()).toEqual([
      { optionName: OPTION_A, productName: STORE_PRODUCT_NAME, brandCode: "TC-001", price: 30000, campaignDealId: null },
    ]);
    const proposals = await realPrisma.actionProposal.findMany();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: "EXECUTED",
      createdBy: "AGENT_WORKER",
      executedBy: AGENT_MAPPING_APPLY_ACTOR,
      requestType: "crm_mutation",
    });
    expect(result.ok && result.data.proposalId).toBe(proposals[0].id);
    const events = await realPrisma.actionProposalEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(events.map((event: { toStatus: string }) => event.toStatus)).toEqual(["PENDING_APPROVAL", "APPROVED", "EXECUTED"]);
    // 새 줄을 만들었으니 화면 저장과 같은 후속 처리(자동 연결)가 돈다.
    expect(effectsCalls).toHaveLength(1);
  });

  it("코드표 이름은 저장되지 않는다 — 그 줄만 NOT_A_STORE_OPTION 으로 돌려주고 나머지는 저장한다", async () => {
    const result = await applyProductMappings(
      {
        orderCampaignId: CAMPAIGN_ID,
        mappings: [
          { optionName: SHEET_ONLY_NAME, brandCode: "TC-009", price: 9000 },
          { optionName: OPTION_B, brandCode: "TC-002", price: 55000 },
        ],
      },
      { storeOptions: storeDeps },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { created: 1, rejected: [{ optionName: SHEET_ONLY_NAME, code: "NOT_A_STORE_OPTION" }] },
    });
    const saved = await mappings();
    expect(saved.map((row: { optionName: string }) => row.optionName)).toEqual([OPTION_B]);
    expect(saved.some((row: { optionName: string }) => row.optionName.includes("1BOX"))).toBe(false);
  });

  it("봇이 보낸 글자가 NFD·공백만 다르면 같은 옵션으로 보고, 저장은 스토어 글자 그대로 한다", async () => {
    const variant = `  ${OPTION_A.normalize("NFD").replace(" ", "   ")} `;
    const result = await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: variant, brandCode: "TC-001", price: 30000 }] },
      { storeOptions: storeDeps },
    );
    expect(result).toMatchObject({ ok: true, data: { created: 1, rejected: [] } });
    expect((await mappings())[0].optionName).toBe(OPTION_A);
  });

  it("이미 있는 줄은 상품코드·가격만 고치고 딜 연결·상품명은 그대로 둔다", async () => {
    await realPrisma.productMapping.create({
      data: { campaignId: CAMPAIGN_ID, optionName: OPTION_A, productName: "", brandCode: "OLD-1", price: 1000 },
    });
    const result = await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] },
      { storeOptions: storeDeps },
    );
    expect(result).toMatchObject({ ok: true, data: { created: 0, updated: 1, unchanged: 0 } });
    expect(await mappings()).toEqual([
      { optionName: OPTION_A, productName: "", brandCode: "TC-001", price: 30000, campaignDealId: null },
    ]);
    // 고치기만 했으면 자동 연결을 돌리지 않는다(정본 실행 동작의 effects 규칙).
    expect(effectsCalls).toHaveLength(1);
    const [, executionResult] = effectsCalls[0] as [string, { createdCount?: number }];
    expect(executionResult.createdCount).toBe(0);
  });

  it("같은 요청을 다시 보내면 「그대로」로 세고 기록을 더 만들지 않는다", async () => {
    const request = { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] };
    await applyProductMappings(request, { storeOptions: storeDeps });
    const second = await applyProductMappings(request, { storeOptions: storeDeps });
    expect(second).toMatchObject({ ok: true, data: { proposalId: null, created: 0, updated: 0, unchanged: 1 } });
    expect(await realPrisma.actionProposal.count()).toBe(1);
  });

  it("모든 줄이 스토어 옵션이 아니면 아무것도 쓰지 않고 기록도 없다", async () => {
    const result = await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: SHEET_ONLY_NAME, brandCode: "TC-009", price: 9000 }] },
      { storeOptions: storeDeps },
    );
    expect(result).toMatchObject({ ok: true, data: { proposalId: null, created: 0, rejected: [{ code: "NOT_A_STORE_OPTION" }] } });
    expect(await mappings()).toEqual([]);
    expect(await realPrisma.actionProposal.count()).toBe(0);
  });

  it("같은 옵션 매핑이 이미 두 줄이면 DUPLICATE_MAPPING 으로 실패하고 아무것도 쓰지 않는다", async () => {
    for (const code of ["D-1", "D-2"]) {
      await realPrisma.productMapping.create({
        data: { campaignId: CAMPAIGN_ID, optionName: OPTION_A, productName: "", brandCode: code, price: 1 },
      });
    }
    const result = await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] },
      { storeOptions: storeDeps },
    );
    expect(result).toMatchObject({ ok: false, code: "DUPLICATE_MAPPING" });
    expect(await realPrisma.actionProposal.count()).toBe(0);
    expect((await mappings()).map((row: { brandCode: string }) => row.brandCode).sort()).toEqual(["D-1", "D-2"]);
  });

  it("슬랙 위치를 기록의 출처 칸에 남긴다", async () => {
    const slack = {
      channelId: "C0TESTCHAN1",
      threadTs: "1800000000.000100",
      messageTs: "1800000000.000200",
      rid: "01M4E4P6Z4QJ5A7X1178QJ7Y01",
    };
    await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }], slack },
      { storeOptions: storeDeps },
    );
    const proposal = await realPrisma.actionProposal.findFirst();
    expect(JSON.parse(proposal.sourceRef)).toEqual({ slack });
  });
});

describe("리뷰 보강(2026-10-16)", () => {
  it("같은 요청이 동시에 두 번 와도(「응」 두 번) 하나는 저장, 하나는 「그대로」 — 실패·FAILED 기록이 없다", async () => {
    const request = { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] };
    const [first, second] = await Promise.all([
      applyProductMappings(request, { storeOptions: storeDeps }),
      applyProductMappings(request, { storeOptions: storeDeps }),
    ]);
    expect(first).toMatchObject({ ok: true, data: { created: 1 } });
    expect(second).toMatchObject({ ok: true, data: { created: 0, unchanged: 1, proposalId: null } });
    expect(await realPrisma.actionProposal.count({ where: { status: "FAILED" } })).toBe(0);
    expect(await mappings()).toHaveLength(1);
  });

  it("승인 실행이 시작도 못 하면 남은 승인대기 기록을 반려로 닫는다(오너가 낡은 줄을 나중에 승인하지 않게)", async () => {
    const result = await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] },
      {
        storeOptions: storeDeps,
        approve: async () => ({ ok: false, code: "APPROVE_ERROR", httpStatus: 500, error: "승인 처리 중 오류", status: "PENDING_APPROVAL" }),
      },
    );
    expect(result).toMatchObject({ ok: false, code: "APPLY_FAILED" });
    const proposals = await realPrisma.actionProposal.findMany();
    expect(proposals.map((proposal: { status: string }) => proposal.status)).toEqual(["REJECTED"]);
    expect(await mappings()).toEqual([]);
  });

  it("승인 함수가 던져도 승인대기 기록을 닫고 실패를 돌려준다", async () => {
    const result = await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] },
      {
        storeOptions: storeDeps,
        approve: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(result).toMatchObject({ ok: false, code: "APPLY_FAILED" });
    expect((await realPrisma.actionProposal.findFirst()).status).toBe("REJECTED");
  });

  it("원문이 매핑 상한(100자)을 넘는 스토어 옵션은 그 줄만 OPTION_NAME_TOO_LONG, 나머지는 저장한다", async () => {
    // 비교 키(공백 접기)로는 100자 안이라 봇 줄과 짝이 맞지만, 저장 글자(스토어 원문)는 공백 때문에 100자를 넘는다.
    const spaced = `구성: ${"가 ".repeat(30)}${" ".repeat(60)}끝`;
    storeOptionNames = [OPTION_A, spaced];
    const botText = spaced.replace(/\s+/g, " ");
    expect(botText.length).toBeLessThanOrEqual(100);
    expect(spaced.length).toBeGreaterThan(100);
    const result = await applyProductMappings(
      {
        orderCampaignId: CAMPAIGN_ID,
        mappings: [
          { optionName: OPTION_A, brandCode: "TC-001", price: 30000 },
          { optionName: botText, brandCode: "TC-LONG", price: 1 },
        ],
      },
      { storeOptions: storeDeps },
    );
    expect(result).toMatchObject({ ok: true, data: { created: 1 } });
    expect(result.ok && result.data.rejected.map((row) => row.code)).toEqual(["OPTION_NAME_TOO_LONG"]);
  });

  it("거절 줄의 옵션명은 결과 상한 안에 들도록 잘라 돌려준다(50줄 × 100자 거절)", async () => {
    const result = await applyProductMappings(
      {
        orderCampaignId: CAMPAIGN_ID,
        mappings: Array.from({ length: 50 }, (_, index) => ({
          optionName: `코드표 이름 ${index} ${"나".repeat(90)}`,
          brandCode: "TC-X",
          price: 1,
        })),
      },
      { storeOptions: storeDeps },
    );
    expect(result).toMatchObject({ ok: true, data: { created: 0 } });
    expect(result.ok && result.data.rejected).toHaveLength(50);
    expect(result.ok && result.data.rejected.every((row) => row.optionName.length <= 40)).toBe(true);
  });
});

describe("스토어 옵션 대조 자료 — Fixie 요청 수", () => {
  it("조회 뒤 10분 안 저장은 네이버를 다시 부르지 않는다", async () => {
    const { loadStoreOptionsFresh } = await import("../store-product-options");
    await loadStoreOptionsFresh(CAMPAIGN_ID, storeDeps);
    expect([listCalls, detailCalls]).toEqual([1, 1]);
    now += STORE_OPTIONS_REUSE_MS - 1;
    await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] },
      { storeOptions: storeDeps },
    );
    expect([listCalls, detailCalls]).toEqual([1, 1]);
  });

  it("10분이 지났거나 캠페인의 연결 상품이 바뀌었으면 다시 조회한다", async () => {
    const { loadStoreOptionsFresh, loadStoreOptionsForApply } = await import("../store-product-options");
    await loadStoreOptionsFresh(CAMPAIGN_ID, storeDeps);
    now += STORE_OPTIONS_REUSE_MS;
    await loadStoreOptionsForApply(CAMPAIGN_ID, storeDeps);
    expect(detailCalls).toBe(2);

    await realPrisma.orderCampaign.update({ where: { id: CAMPAIGN_ID }, data: { productId: CHANNEL_NO } });
    await loadStoreOptionsForApply(CAMPAIGN_ID, storeDeps);
    expect(detailCalls).toBe(3);
  });

  it("상품이 연결되지 않은 캠페인은 NO_STORE_OPTIONS 로 실패하고 네이버를 부르지 않는다", async () => {
    await realPrisma.orderCampaign.update({ where: { id: CAMPAIGN_ID }, data: { productId: null } });
    const result = await applyProductMappings(
      { orderCampaignId: CAMPAIGN_ID, mappings: [{ optionName: OPTION_A, brandCode: "TC-001", price: 30000 }] },
      { storeOptions: storeDeps },
    );
    expect(result).toMatchObject({ ok: false, code: "NO_STORE_OPTIONS" });
    expect([listCalls, detailCalls]).toEqual([0, 0]);
  });
});
