/**
 * OrderFulfillmentState 저장소 실 SQLite 회귀.
 * "배송대기 = 발주요청 발송됨"(order-fulfillment.ts)의 쓰기/읽기 계약:
 *  stampPoRequested(멱등·campaignId 갱신) · getPoRequestedSet(청크·미발송 제외).
 * 격리 임시 DB 패턴은 chatRoomMappingReconcile.realdb.test.ts와 동일(공유 dev.db 미접촉).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
let tmpDir: string;
let dbPath: string;
let realPrisma: any;

// 저장소는 @/lib/order-converter/prisma 의 prisma를 쓴다 → 임시 DB 클라이언트로 대체.
vi.mock("@/lib/order-converter/prisma", () => ({ get prisma() { return realPrisma; } }));

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-order-fulfillment-"));
  dbPath = join(tmpDir, "test.db");
  execFileSync(
    "npx",
    ["prisma", "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate", "--accept-data-loss"],
    { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: `file:${dbPath}` }, stdio: "pipe" }
  );
  const generatedClientPath = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite", "index.js");
  const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
  realPrisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
}, 30000);

afterAll(async () => {
  if (realPrisma) await realPrisma.$disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await realPrisma.orderFulfillmentState.deleteMany({});
});

describe("orderFulfillmentRepository (realdb)", () => {
  it("stampPoRequested → getPoRequestedSet 왕복: 발송된 것만 집합에 든다", async () => {
    const { orderFulfillmentRepository } = await import("../orderFulfillmentRepository");
    await orderFulfillmentRepository.stampPoRequested(["P1", "P2"], "camp-1");

    const set = await orderFulfillmentRepository.getPoRequestedSet(["P1", "P2", "P3"]);
    expect(set.has("P1")).toBe(true);
    expect(set.has("P2")).toBe(true);
    expect(set.has("P3")).toBe(false); // 스탬프 안 됨 → 배송대기 아님
  });

  it("멱등: 같은 상품주문번호 재발송 시 중복행 없이 poRequestedAt/campaignId 갱신", async () => {
    const { orderFulfillmentRepository } = await import("../orderFulfillmentRepository");
    await orderFulfillmentRepository.stampPoRequested(["P1"], "camp-1");
    await orderFulfillmentRepository.stampPoRequested(["P1"], "camp-2");

    const rows = await realPrisma.orderFulfillmentState.findMany({ where: { productOrderId: "P1" } });
    expect(rows.length).toBe(1);
    expect(rows[0].campaignId).toBe("camp-2");
    expect(rows[0].poRequestedAt).not.toBeNull();
  });

  it("빈/공백 ID·중복은 정규화되어 무해하다", async () => {
    const { orderFulfillmentRepository } = await import("../orderFulfillmentRepository");
    const res = await orderFulfillmentRepository.stampPoRequested(["P1", " P1 ", "", null as any, "  "], null);
    expect(res.stamped).toBe(1); // P1 하나로 dedup/trim
    const set = await orderFulfillmentRepository.getPoRequestedSet([]);
    expect(set.size).toBe(0); // 빈 입력 → 빈 집합
  });
});
