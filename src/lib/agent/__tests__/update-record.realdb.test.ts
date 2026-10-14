/**
 * `update_record`(기록 수정) — 승인 실행 전체를 **실 SQLite**(격리 임시 파일)로 고정한다.
 *
 * 진짜로 도는 것: 승인 SSOT(`approveProposal` 의 tx1 CAS · tx2 · FAILED 기록) → 실행기 가드(지금 값
 * 대조·잠금) → **화면 PATCH 와 같은 본체**(`applyCampaignPatch` → `campaignService.updateCampaign` ·
 * `dealService.updateDeal` · `PartnerService.updatePartner` · `applySellerPatch`)가 승인 트랜잭션 안에서.
 * 그래서 「묶음 캠페인은 계산서일이 묶음 행에 간다」 「입금일을 넣으면 입금 플래그와 자동 상태가 따라온다」
 * 같은 결과가 화면 저장의 결과 그 자체다(이 테스트가 그 규칙을 다시 적지 않는다).
 * 가짜: 커밋 뒤 후속 처리(캐시 무효화·캘린더 — Next 런타임 없음).
 *
 * 🪤 sqlite 는 쓰기 잠금이 하나라, 본체 안 어딘가가 tx 대신 전역 클라이언트로 쓰면 여기서 멈춘다 —
 *    「본체 전체가 승인 트랜잭션 안에서 돈다」를 이 파일이 함께 지킨다.
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
const { resolveWriteActionEffects } = await import("../write-executor");
const { CAMPAIGN_INVALIDATION_TAGS, MASTER_DATA_INVALIDATION_TAGS } = await import("@/lib/cache-tags");

const APPROVER = "owner-approver";
let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

async function partner(over: Record<string, unknown> = {}) {
  return realPrisma.partner.create({ data: { id: nextId("ptn"), name: "가상 브랜드사", type: "BRAND", ...over } });
}

async function seller() {
  const id = nextId("slr");
  return realPrisma.seller.create({ data: { id, name: "가상셀러", snsType: "INSTAGRAM", snsHandle: `fake_${id}` } });
}

async function deal(partnerId: string) {
  return realPrisma.deal.create({
    data: { id: nextId("deal"), dealName: "가상 상품", baseMarginPolicy: "{}", partnerId, sellingPrice: 10_000 },
  });
}

async function campaign(over: Record<string, unknown> = {}) {
  const p = (over.partner as { id: string } | undefined) ?? (await partner());
  const s = (over.seller as { id: string } | undefined) ?? (await seller());
  const d = await deal(p.id);
  const { partner: _p, seller: _s, ...rest } = over;
  return realPrisma.salesCampaign.create({
    data: {
      id: nextId("camp"),
      dealId: d.id,
      sellerId: s.id,
      startDate: new Date("2026-04-01T00:00:00.000Z"),
      endDate: new Date("2026-04-07T00:00:00.000Z"),
      salesChannel: "BRAND_MALL",
      baseNaverLink: "https://example.invalid/item",
      generatedTrackingLink: "https://example.invalid/t",
      status: "SETTLEMENT_WAIT",
      settlementSales: 300_000,
      sellerExpense: 100_000,
      ...rest,
    },
  });
}

async function propose(args: Record<string, unknown>) {
  const created = await realPrisma.actionProposal.create({
    data: {
      requestType: "record_update",
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      title: "기록 수정",
      createdBy: "AGENT_WORKER",
      payload: JSON.stringify({ action: "update_record", args }),
    },
  });
  return created.id as string;
}

async function proposal(id: string) {
  return realPrisma.actionProposal.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "update-record-realdb-"));
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

describe("캠페인 — 화면 저장과 같은 본체", () => {
  it("입금일·지급일을 넣으면 입금·지급 플래그가 켜지고 자동 상태가 정산 완료로 넘어간다", async () => {
    const target = await campaign();
    const id = await propose({
      entityType: "CAMPAIGN",
      entityId: target.id,
      changes: { depositReceivedAt: "2026-04-28", payoutCompletedAt: "2026-05-26" },
      expected: { depositReceivedAt: null, payoutCompletedAt: null },
      memo: "실제 입금·지급일 반영",
    });

    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(true);
    const row = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.isDepositReceived).toBe(true);
    expect(row.isPayoutCompleted).toBe(true);
    expect(row.depositReceivedAt.toISOString()).toBe("2026-04-28T00:00:00.000Z");
    expect(row.payoutCompletedAt.toISOString()).toBe("2026-05-26T00:00:00.000Z");
    expect(row.status).toBe("COMPLETED");
    expect((await proposal(id)).status).toBe("EXECUTED");
    // 화면 저장과 같은 이력(캠페인 활동 + 상태 자동 전이) + 기안 메모.
    const activities = await realPrisma.campaignActivity.findMany({ where: { campaignId: target.id } });
    expect(activities.some((a: { action: string }) => a.action === "UPDATED")).toBe(true);
    const memo = await realPrisma.activityLog.findFirst({ where: { entityId: target.id, type: "MEMO" } });
    expect(memo.content).toContain("실제 입금·지급일 반영");
    expect(memo.actor).toBe(APPROVER);
    // 후속 처리는 커밋 뒤 effects 명세로 한 번.
    expect(effectsCalls).toHaveLength(1);
    expect(resolveWriteActionEffects("update_record", { refType: "CAMPAIGN", refId: target.id, summary: "" })).toEqual({
      revalidate: CAMPAIGN_INVALIDATION_TAGS,
      calendarCampaignId: target.id,
    });
  });

  it("묶음 캠페인의 계산서일은 묶음 행에 쓰이고, 판매 채널은 화면처럼 그 캠페인 한 건에만 쓰인다", async () => {
    const s = await seller();
    const p = await partner();
    const group = await realPrisma.campaignGroup.create({ data: { id: nextId("grp"), sellerId: s.id } });
    const first = await campaign({ seller: s, partner: p, groupId: group.id, salesChannel: "UNSPECIFIED" });
    const second = await campaign({ seller: s, partner: p, groupId: group.id, salesChannel: "UNSPECIFIED" });

    const id = await propose({
      entityType: "CAMPAIGN",
      entityId: first.id,
      changes: { supplierInvoiceIssuedAt: "2026-04-23", salesChannel: "BRAND_MALL" },
      expected: { supplierInvoiceIssuedAt: null, salesChannel: "UNSPECIFIED" },
    });
    expect((await approveProposal(id, APPROVER)).ok).toBe(true);

    const groupRow = await realPrisma.campaignGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(groupRow.supplierInvoiceIssuedAt.toISOString()).toBe("2026-04-23T00:00:00.000Z");
    const firstRow = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: first.id } });
    const secondRow = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: second.id } });
    // CG-1: 묶음이면 멤버 행에 계산서일을 쓰지 않는다(화면 저장과 같다).
    expect(firstRow.supplierInvoiceIssuedAt).toBeNull();
    expect(firstRow.salesChannel).toBe("BRAND_MALL");
    expect(secondRow.salesChannel).toBe("UNSPECIFIED");
  });

  it("묶음 캠페인의 지금 값은 묶음 행에서 읽는다 — 멤버 행 값으로 기안하면 낡은 기안으로 거절한다", async () => {
    const s = await seller();
    const group = await realPrisma.campaignGroup.create({
      data: { id: nextId("grp"), sellerId: s.id, sellerInvoiceIssuedAt: new Date("2026-05-22T00:00:00.000Z") },
    });
    const member = await campaign({ seller: s, groupId: group.id });

    const id = await propose({
      entityType: "CAMPAIGN",
      entityId: member.id,
      changes: { sellerInvoiceIssuedAt: "2026-05-23" },
      expected: { sellerInvoiceIssuedAt: null },
    });
    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(false);
    const failed = await proposal(id);
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toMatch(/지금 값이 기안 때와 다릅니다.*셀러 계산서일\(기안: 비어 있음 · 현재: 2026-05-22\)/);
    const groupRow = await realPrisma.campaignGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(groupRow.sellerInvoiceIssuedAt.toISOString()).toBe("2026-05-22T00:00:00.000Z");
  });

  it("월정산 거래처의 공급사 계산서일은 화면 저장과 같은 게이트로 거절하고 아무것도 쓰지 않는다", async () => {
    const p = await partner({ monthlySettlement: true });
    const target = await campaign({ partner: p });
    const id = await propose({
      entityType: "CAMPAIGN",
      entityId: target.id,
      changes: { supplierInvoiceIssuedAt: "2026-05-01" },
      expected: { supplierInvoiceIssuedAt: null },
    });

    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(false);
    expect((await proposal(id)).errorMessage).toMatch(/월정산 거래처의 공급사 계산서는/);
    const row = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.supplierInvoiceIssuedAt).toBeNull();
  });

  it("시스템 실행자는 승인해도 실행하지 않는다(사람 승인만)", async () => {
    const target = await campaign();
    const id = await propose({
      entityType: "CAMPAIGN",
      entityId: target.id,
      changes: { expectedDepositDate: "2026-06-01" },
      expected: { expectedDepositDate: null },
    });

    const outcome = await approveProposal(id, "SYSTEM_AUTO");

    expect(outcome.ok).toBe(false);
    expect((await proposal(id)).errorMessage).toMatch(/사람이 결재함에서 승인해야/);
    const row = await realPrisma.salesCampaign.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.expectedDepositDate).toBeNull();
  });

  it("화면 스키마에 없는 칸·제외 칸은 실행 전에 거절한다", async () => {
    const target = await campaign();
    const unknownField = await propose({
      entityType: "CAMPAIGN",
      entityId: target.id,
      changes: { operatingProfit: 1 },
      expected: { operatingProfit: null },
    });
    const excludedField = await propose({
      entityType: "CAMPAIGN",
      entityId: target.id,
      changes: { assignedTo: "someone" },
      expected: { assignedTo: null },
    });

    expect((await approveProposal(unknownField, APPROVER)).ok).toBe(false);
    expect((await proposal(unknownField)).errorMessage).toMatch(/args 검증 실패/);
    expect((await approveProposal(excludedField, APPROVER)).ok).toBe(false);
    expect((await proposal(excludedField)).errorMessage).toMatch(/assignedTo: 담당자 인수인계는/);
  });
});

describe("딜·거래처·셀러 — 각 화면 저장 본체", () => {
  it("딜 판매가를 고치고 같은 감사 기록을 승인자 이름으로 남긴다", async () => {
    const p = await partner();
    const target = await deal(p.id);
    const id = await propose({
      entityType: "DEAL",
      entityId: target.id,
      changes: { sellingPrice: 12_000 },
      expected: { sellingPrice: 10_000 },
    });

    expect((await approveProposal(id, APPROVER)).ok).toBe(true);
    const row = await realPrisma.deal.findUniqueOrThrow({ where: { id: target.id } });
    expect(Number(row.sellingPrice)).toBe(12_000);
    const log = await realPrisma.activityLog.findFirst({ where: { entityId: target.id, type: "CHANGE" } });
    expect(log.actor).toBe(APPROVER);
    expect(resolveWriteActionEffects("update_record", { refType: "DEAL", refId: target.id, summary: "" })).toEqual({
      revalidate: MASTER_DATA_INVALIDATION_TAGS,
      calendarCampaignId: null,
    });
  });

  it("거래처 메모와 셀러 메모를 고친다", async () => {
    const p = await partner({ notes: "옛 메모" });
    const s = await seller();
    const partnerProposal = await propose({
      entityType: "PARTNER",
      entityId: p.id,
      changes: { notes: "새 메모" },
      expected: { notes: "옛 메모" },
    });
    const sellerProposal = await propose({
      entityType: "SELLER",
      entityId: s.id,
      changes: { notes: "연락 완료" },
      expected: { notes: null },
    });

    expect((await approveProposal(partnerProposal, APPROVER)).ok).toBe(true);
    expect((await approveProposal(sellerProposal, APPROVER)).ok).toBe(true);
    expect((await realPrisma.partner.findUniqueOrThrow({ where: { id: p.id } })).notes).toBe("새 메모");
    expect((await realPrisma.seller.findUniqueOrThrow({ where: { id: s.id } })).notes).toBe("연락 완료");
  });

  it("셀러 기안이 낡아 실패하면 실패 문구에 지금 값을 싣지 않는다(봇·슬랙으로 연락처가 새지 않게)", async () => {
    const s = await seller();
    await realPrisma.seller.update({ where: { id: s.id }, data: { phoneNumber: "010-0000-1234" } });
    const id = await propose({
      entityType: "SELLER",
      entityId: s.id,
      changes: { phoneNumber: "010-0000-5678" },
      expected: { phoneNumber: null },
    });

    expect((await approveProposal(id, APPROVER)).ok).toBe(false);
    const failed = await proposal(id);
    expect(failed.errorMessage).toMatch(/지금 값이 기안 때와 다릅니다/);
    expect(failed.errorMessage).not.toContain("010-0000-1234");
    expect(failed.errorMessage).not.toContain("현재:");
  });

  it("딜 상태는 화면과 같은 전이 규칙으로 막고, 거절되면 함께 보낸 칸도 쓰지 않는다(SOURCING → ARCHIVED 불가)", async () => {
    const p = await partner();
    const target = await deal(p.id);
    const before = await realPrisma.deal.findUniqueOrThrow({ where: { id: target.id } });
    const id = await propose({
      entityType: "DEAL",
      entityId: target.id,
      changes: { status: "ARCHIVED", dealName: "바뀌면 안 되는 이름" },
      expected: { status: before.status, dealName: before.dealName },
    });

    expect(before.status).toBe("SOURCING");
    const outcome = await approveProposal(id, APPROVER);

    expect(outcome.ok).toBe(false);
    const after = await realPrisma.deal.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.dealName).toBe(before.dealName);
    expect(after.status).toBe(before.status);
    expect((await proposal(id)).status).toBe("FAILED");
  });
});
