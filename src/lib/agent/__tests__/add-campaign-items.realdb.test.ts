/**
 * `add_campaign_items`(판매캠페인 품목 추가, T-271) — 승인 실행 전체를 **실 SQLite**(격리 임시 파일)로 고정한다.
 *
 * 진짜로 도는 것: 승인 SSOT(`approveProposal`) → 실행기 가드(사람 승인 · 잠금 · 판매 조건 대조 · 매출 합계 대조 · 줄 판정)
 * → 새 하위품목 생성 → **화면 저장과 같은 본체**(`applyCampaignPatch` → `campaignService.updateCampaign`)가 승인 트랜잭션
 * 안에서. 그래서 「품목 수가 늘고 실매출·수량은 그대로」가 화면 저장의 결과 그 자체다.
 * 가짜: 커밋 뒤 후속 처리(캐시 무효화 — Next 런타임 없음).
 *
 * 🪤 sqlite 는 쓰기 잠금이 하나라, 본체 안 어딘가가 tx 대신 전역 클라이언트로 쓰면 여기서 멈춘다.
 * 이름은 전부 지어낸 값이다(공개 레포).
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
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => true }));
const effectsCalls: unknown[] = [];
vi.mock("@/lib/agent/write-action-effects", () => ({
  applyWriteActionEffects: (...args: unknown[]) => effectsCalls.push(args),
}));

const { approveProposal } = await import("../approve-proposal");
const { executeWriteAction, resolveWriteActionEffects } = await import("../write-executor");
const { CAMPAIGN_INVALIDATION_TAGS, CRM_CACHE_TAGS } = await import("@/lib/cache-tags");

const APPROVER = "owner-approver";
let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

type Fixture = { campaignId: string; mainId: string; optionA: string; optionB: string; partnerId: string };

/**
 * 판매 조건(수수료율 20%) 밑 하위품목 A·B, 판매캠페인 품목엔 A 만(수량 3 · 실매출 30,000원) — 캠페인 실매출·수량은
 * 품목 합계와 같다(화면 저장 뒤의 정상 상태).
 */
async function fixture(
  over: { campaignSales?: number; campaignQuantity?: number; withItem?: boolean; unit?: string } = {},
): Promise<Fixture> {
  const partner = await realPrisma.partner.create({ data: { id: nextId("ptn"), name: "가상 브랜드사", type: "BRAND" } });
  const seller = await realPrisma.seller.create({
    data: { id: nextId("slr"), name: "가상셀러", snsType: "INSTAGRAM", snsHandle: `fake_${seq}` },
  });
  const main = await realPrisma.deal.create({
    data: {
      id: nextId("main"),
      dealName: "가상 상품",
      brandName: "가상브랜드",
      unit: over.unit ?? null,
      partnerId: partner.id,
      partnerCompanyName: "가상 브랜드사",
      sellingPrice: 10_000,
      costPrice: 8_000,
      totalCommissionRate: 20,
      baseMarginPolicy: '{"byChannel":{"BRAND_MALL":20}}',
    },
  });
  const option = (name: string, price: number, sortOrder: number) =>
    realPrisma.deal.create({
      data: {
        id: nextId("opt"),
        dealName: name,
        sellingPrice: price,
        costPrice: price * 0.8,
        totalCommissionRate: 20,
        dealType: "OPTION",
        parentDealId: main.id,
        partnerId: partner.id,
        optionSortOrder: sortOrder,
        baseMarginPolicy: "{}",
      },
    });
  // 화면이 저장하는 이름 모양(「판매 조건 이름 - 옵션 이름」, `formatOptionDealName`).
  const optionA = await option("가상 상품 - 1개", 10_000, 0);
  const optionB = await option("가상 상품 - 2개입", 19_000, 1);
  const campaign = await realPrisma.salesCampaign.create({
    data: {
      id: nextId("camp"),
      dealId: main.id,
      sellerId: seller.id,
      startDate: new Date("2026-04-01T00:00:00.000Z"),
      endDate: new Date("2026-04-07T00:00:00.000Z"),
      salesChannel: "BRAND_MALL",
      baseNaverLink: "https://example.invalid/item",
      generatedTrackingLink: "https://example.invalid/t",
      status: "ACTIVE",
      totalMarginRate: 25,
      sellerMarginRate: 10,
      actualSales: over.campaignSales ?? 30_000,
      quantity: over.campaignQuantity ?? 3,
      itemCount: 1,
    },
  });
  if (over.withItem === false) {
    return { campaignId: campaign.id, mainId: main.id, optionA: optionA.id, optionB: optionB.id, partnerId: partner.id };
  }
  await realPrisma.campaignDeal.create({
    data: {
      campaignId: campaign.id,
      dealId: optionA.id,
      quantity: 3,
      actualSales: 30_000,
      feeRate: 20,
      sellerMarginRate: 10,
      sellingPrice: 10_000,
      costPrice: 8_000,
    },
  });
  return { campaignId: campaign.id, mainId: main.id, optionA: optionA.id, optionB: optionB.id, partnerId: partner.id };
}

async function propose(args: Record<string, unknown>) {
  const created = await realPrisma.actionProposal.create({
    data: {
      requestType: "crm_mutation",
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      title: "판매캠페인 품목 추가",
      createdBy: "AGENT_WORKER",
      targetEntityType: "CAMPAIGN",
      targetEntityId: args.campaignId as string,
      payload: JSON.stringify({ action: "add_campaign_items", args }),
    },
  });
  return created.id as string;
}

const proposal = (id: string) => realPrisma.actionProposal.findUniqueOrThrow({ where: { id } });
const items = (campaignId: string) =>
  realPrisma.campaignDeal.findMany({ where: { campaignId }, include: { deal: true }, orderBy: { createdAt: "asc" } });
const optionCount = (mainId: string) => realPrisma.deal.count({ where: { parentDealId: mainId } });

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "add-campaign-items-realdb-"));
  const dbPath = join(tmpDir, "test.db");
  pushSqliteTestSchema(dbPath, REPO_ROOT);
  const generatedClientPath = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite", "index.js");
  const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
  realPrisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
}, 120_000);

afterAll(async () => {
  await realPrisma?.$disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  effectsCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("판매캠페인 품목 추가 — 승인 반영", () => {
  it("새 하위품목을 상위 판매 조건 값으로 만들고, 기존 하위품목과 함께 수량 0 줄로 덧붙인다(기존 줄·매출 그대로)", async () => {
    const f = await fixture();
    const id = await propose({
      campaignId: f.campaignId,
      mainDealId: f.mainId,
      items: [{ dealName: "3개입", sellingPrice: 27_000, unitQuantity: 3 }, { dealId: f.optionB }],
      memo: "새 구성 추가",
    });

    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(true);
    const saved = await proposal(id);
    expect(saved.status).toBe("EXECUTED");

    // 새 하위품목 — 화면의 「하위품목 추가」와 같은 값(이름 「판매 조건 이름 - 옵션 이름」 · 부모 상속 · 수수료율 20% →
    // 공급가 21,600원 · 정렬 = 형제 최대 + 1).
    const created = await realPrisma.deal.findFirstOrThrow({ where: { parentDealId: f.mainId, dealName: "가상 상품 - 3개입" } });
    expect(created.dealType).toBe("OPTION");
    expect(created.partnerId).toBe(f.partnerId);
    expect(created.partnerCompanyName).toBe("가상 브랜드사");
    expect(created.brandName).toBe("가상브랜드");
    expect(created.unit).toBeNull();
    expect(created.unitQuantity).toBe(3);
    expect(Number(created.sellingPrice)).toBe(27_000);
    expect(Number(created.totalCommissionRate)).toBe(20);
    expect(Number(created.costPrice)).toBe(21_600);
    expect(created.optionSortOrder).toBe(2);
    expect(created.baseMarginPolicy).toBe('{"byChannel":{"BRAND_MALL":20}}');
    expect(created.status).toBe("SOURCING");

    // 품목 — 기존 줄은 읽은 값 그대로, 새 줄은 「+ 옵션 품목 추가」 기본값.
    const rows = await items(f.campaignId);
    expect(rows.map((row: { dealId: string }) => row.dealId).sort()).toEqual([f.optionA, f.optionB, created.id].sort());
    const byDeal = new Map(rows.map((row: { dealId: string }) => [row.dealId, row]));
    const kept: any = byDeal.get(f.optionA);
    // 기존 줄은 읽은 값 그대로 다시 보낸다(요율·가격 칸도 바뀌지 않는다).
    expect(kept.quantity).toBe(3);
    expect(Number(kept.actualSales)).toBe(30_000);
    expect(Number(kept.feeRate)).toBe(20);
    expect(Number(kept.sellerMarginRate)).toBe(10);
    expect(Number(kept.sellingPrice)).toBe(10_000);
    expect(Number(kept.costPrice)).toBe(8_000);
    const linked: any = byDeal.get(f.optionB);
    expect(linked.quantity).toBe(0);
    expect(Number(linked.actualSales)).toBe(0);
    expect(Number(linked.feeRate)).toBe(20);
    expect(Number(linked.sellerMarginRate)).toBe(10);
    expect(Number(linked.sellingPrice)).toBe(19_000);
    expect(Number(linked.costPrice)).toBe(15_200);
    const fresh: any = byDeal.get(created.id);
    expect(fresh.quantity).toBe(0);
    expect(Number(fresh.sellingPrice)).toBe(27_000);
    expect(Number(fresh.costPrice)).toBe(21_600);

    // 캠페인 — 품목 수만 늘고 실매출·수량은 그대로(화면 저장 본체가 품목 합으로 다시 쓴 결과).
    const campaign = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    expect(campaign.itemCount).toBe(3);
    expect(Number(campaign.actualSales)).toBe(30_000);
    expect(campaign.quantity).toBe(3);

    const result = JSON.parse(saved.executionResult);
    expect(result.summary).toContain("캠페인 품목 추가: 2건(새 하위품목 1건 · 기존 하위품목 연결 1건)");
    const memo = await realPrisma.activityLog.findFirst({ where: { entityId: f.campaignId, type: "MEMO" } });
    expect(memo?.content).toBe("품목 추가 기안 메모: 새 구성 추가");
    expect(resolveWriteActionEffects("add_campaign_items", result).revalidate).toEqual([
      ...CAMPAIGN_INVALIDATION_TAGS,
      CRM_CACHE_TAGS.deals,
    ]);
  });

  it("이미 품목에 있는 줄은 건너뛰고, 모두 있으면 아무것도 쓰지 않는다", async () => {
    const f = await fixture();
    const before = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    const id = await propose({ campaignId: f.campaignId, mainDealId: f.mainId, items: [{ dealId: f.optionA }] });

    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(true);
    const saved = await proposal(id);
    expect(JSON.parse(saved.executionResult).summary).toContain("모두 이미 품목에 있습니다");
    expect(await items(f.campaignId)).toHaveLength(1);
    const after = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    expect(after.itemCount).toBe(before.itemCount);
  });

  it.each([
    ["옵션 이름만", " 2개입 "],
    ["판매 조건 이름까지(공백 차이)", "가상 상품 -  2개입"],
  ])("같은 이름의 하위품목이 이미 있으면(%s) 새로 만들지 않고 그것을 연결한다", async (_label, dealName) => {
    const f = await fixture();
    const id = await propose({
      campaignId: f.campaignId,
      mainDealId: f.mainId,
      items: [{ dealName, sellingPrice: 99_000 }],
    });

    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(true);
    expect(await optionCount(f.mainId)).toBe(2);
    const rows = await items(f.campaignId);
    expect(rows.map((row: { dealId: string }) => row.dealId)).toContain(f.optionB);
    // 연결 줄은 하위품목의 지금 값을 쓴다(기안의 판매가가 아니다).
    const linked: any = rows.find((row: { dealId: string }) => row.dealId === f.optionB);
    expect(Number(linked.sellingPrice)).toBe(19_000);
  });
});

describe("판매캠페인 품목 추가 — 단위가 있는 판매 조건(화면 규칙: 수량 필수 · 이름은 수량으로)", () => {
  it("이름을 「판매 조건 이름 - {수량}{단위}」로 만들고 단위를 물려받는다", async () => {
    const f = await fixture({ unit: "개" });
    const id = await propose({
      campaignId: f.campaignId,
      mainDealId: f.mainId,
      items: [{ dealName: "3개 묶음", sellingPrice: 27_000, unitQuantity: 3 }],
    });

    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(true);
    const created = await realPrisma.deal.findFirstOrThrow({ where: { parentDealId: f.mainId, dealName: "가상 상품 - 3개" } });
    expect(created.unit).toBe("개");
    expect(created.unitQuantity).toBe(3);
  });

  it("옵션 이름이 달라도 같은 수량 두 줄은 같은 이름이 되므로 실패하고 아무것도 쓰지 않는다", async () => {
    const f = await fixture({ unit: "개" });
    const id = await propose({
      campaignId: f.campaignId,
      mainDealId: f.mainId,
      items: [
        { dealName: "가", sellingPrice: 1, unitQuantity: 3 },
        { dealName: "나", sellingPrice: 1, unitQuantity: 3 },
      ],
    });
    const outcome = await approveProposal(id, APPROVER);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(await proposal(id))).toMatch(/같은 이름/);
    expect(await optionCount(f.mainId)).toBe(2);
  });

  it("단위 수량이 없으면 실패하고 아무것도 쓰지 않는다", async () => {
    const f = await fixture({ unit: "개" });
    const id = await propose({ campaignId: f.campaignId, mainDealId: f.mainId, items: [{ dealName: "3개입", sellingPrice: 1 }] });
    const outcome = await approveProposal(id, APPROVER);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(await proposal(id))).toMatch(/단위 수량이 필요합니다/);
    expect(await optionCount(f.mainId)).toBe(2);
    expect(await items(f.campaignId)).toHaveLength(1);
  });
});

describe("판매캠페인 품목 추가 — 품목이 하나도 없는 캠페인", () => {
  it("실매출·주문수량이 0 이면 첫 품목을 더하고 품목 수가 1 이 된다", async () => {
    const f = await fixture({ withItem: false, campaignSales: 0, campaignQuantity: 0 });
    const id = await propose({ campaignId: f.campaignId, mainDealId: f.mainId, items: [{ dealId: f.mainId }] });

    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(true);
    const rows = await items(f.campaignId);
    expect(rows.map((row: { dealId: string }) => row.dealId)).toEqual([f.mainId]);
    const campaign = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    expect(campaign.itemCount).toBe(1);
    expect(Number(campaign.actualSales)).toBe(0);
  });

  it("품목이 없는데 실매출이 있으면 실패(첫 품목 저장이 매출을 0 으로 덮는다)", async () => {
    const f = await fixture({ withItem: false, campaignSales: 30_000, campaignQuantity: 3 });
    const id = await propose({ campaignId: f.campaignId, mainDealId: f.mainId, items: [{ dealId: f.optionB }] });
    const outcome = await approveProposal(id, APPROVER);
    expect(outcome.ok).toBe(false);
    expect(await items(f.campaignId)).toHaveLength(0);
    const campaign = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    expect(Number(campaign.actualSales)).toBe(30_000);
  });
});

describe("판매캠페인 품목 추가 — 거절(아무것도 쓰지 않음)", () => {
  async function expectFailedWithoutWrites(f: Fixture, args: Record<string, unknown>, message: RegExp) {
    const id = await propose(args);
    const outcome = await approveProposal(id, APPROVER);
    expect(outcome.ok).toBe(false);
    const saved = await proposal(id);
    expect(saved.status).toBe("FAILED");
    expect(saved.executionError ?? JSON.stringify(saved)).toMatch(message);
    expect(await optionCount(f.mainId)).toBe(2);
    expect(await items(f.campaignId)).toHaveLength(1);
  }

  it("캠페인의 판매 조건이 기안 때와 다르면 실패", async () => {
    const f = await fixture();
    const other = await fixture();
    await expectFailedWithoutWrites(
      f,
      { campaignId: f.campaignId, mainDealId: other.mainId, items: [{ dealName: "가상 상품 5개입", sellingPrice: 45_000 }] },
      /판매 조건이 기안 때와 다릅니다/,
    );
  });

  it("캠페인 실매출·수량이 품목 합계와 다르면 실패(덧붙이면 매출이 바뀐다)", async () => {
    const f = await fixture({ campaignSales: 50_000 });
    await expectFailedWithoutWrites(
      f,
      { campaignId: f.campaignId, mainDealId: f.mainId, items: [{ dealName: "가상 상품 5개입", sellingPrice: 45_000 }] },
      /품목 합계.*매출이 바뀝니다/,
    );
  });

  it("다른 판매 조건의 하위품목은 연결하지 않는다", async () => {
    const f = await fixture();
    const other = await fixture();
    await expectFailedWithoutWrites(
      f,
      { campaignId: f.campaignId, mainDealId: f.mainId, items: [{ dealId: other.optionB }] },
      /판매 조건 「가상 상품」 밑에 없습니다/,
    );
  });

  it("봇·시스템 실행자는 DB 를 읽기 전에 거부한다(사람 승인만)", async () => {
    const f = await fixture();
    const args = { campaignId: f.campaignId, mainDealId: f.mainId, items: [{ dealId: f.optionB }] };
    for (const actor of ["AGENT_WORKER", "SYSTEM_AUTO"]) {
      await expect(
        realPrisma.$transaction((tx: unknown) => executeWriteAction("add_campaign_items", args, actor, tx as never)),
      ).rejects.toThrow(/사람이 결재함에서 승인해야/);
    }
    expect(await items(f.campaignId)).toHaveLength(1);
  });
});
