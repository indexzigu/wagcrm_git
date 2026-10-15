/**
 * 거래처 등록 기안 + 계산서 보강 — 승인 실행 전체를 **실 SQLite**(격리 임시 파일)로 고정한다.
 *
 * 진짜로 도는 것: `approveProposal`(보강 검사 → tx1 에 합친 payload 저장 → tx2 실행) → 실행기
 * (`create_partner` → `createPartnerRow`). SQLite 레인은 Json 을 **문자열로** 저장하므로, 합친
 * payload 가 그 경로로 왕복해 재시도에서도 같은 값으로 실행되는지가 이 파일의 요점이다.
 * 가짜: 커밋 뒤 후속 처리(캐시 무효화 — Next 런타임 없음). 값은 전부 지어낸 것이다(공개 레포).
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
vi.mock("@/lib/agent/write-action-effects", () => ({ applyWriteActionEffects: () => {} }));
// 실행 실패를 tx2 **안에서** 일으키는 스위치 — 거래처 생성 직후의 기록 단계가 던지면 tx2 전체가
// 롤백된다(전역 클라이언트를 가로채면 승인 트랜잭션의 tx 클라이언트에는 닿지 않는다).
let failActivityOnce = false;
vi.mock("@/lib/activity-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/activity-log")>();
  return {
    ...actual,
    recordActivityCreate: async (...args: Parameters<typeof actual.recordActivityCreate>) => {
      if (failActivityOnce) {
        failActivityOnce = false;
        throw new Error("일시 오류");
      }
      return actual.recordActivityCreate(...args);
    },
  };
});

const { approveProposal } = await import("../approve-proposal");

const APPROVER = "owner-approver";

async function draft(partner: Record<string, unknown>): Promise<string> {
  const created = await realPrisma.actionProposal.create({
    data: {
      requestType: "crm_mutation",
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      title: "거래처 등록",
      createdBy: "AGENT",
      payload: JSON.stringify({ action: "create_partner", args: { partner } }),
    },
  });
  return created.id as string;
}

function storedPartnerArgs(row: { payload: unknown }) {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return payload.args.partner;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "partner-enrichment-realdb-"));
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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("거래처 등록 승인 + 계산서 보강 (실 SQLite)", () => {
  it("빈 칸만 채워 거래처를 만들고, 합친 값을 기안 기록에도 남긴다", async () => {
    const id = await draft({ name: "가상공급사", type: "VENDOR", ceoName: "대화대표" });

    const outcome = await approveProposal(id, APPROVER, {
      partnerEnrichment: {
        businessNumber: "1112233333",
        ceoName: "계산서대표",
        businessType: "도소매",
        businessItem: "화장품",
        address: "가상시 가상로 1",
        representativeEmail: "vendor-tax@example.com",
      },
    });

    expect(outcome.ok).toBe(true);
    const partner = await realPrisma.partner.findFirstOrThrow({ where: { name: "가상공급사" } });
    expect(partner).toMatchObject({
      businessNumber: "1112233333",
      ceoName: "대화대표", // 기안 값 유지
      businessType: "도소매",
      businessItem: "화장품",
      address: "가상시 가상로 1",
      representativeEmail: "vendor-tax@example.com",
    });

    const row = await realPrisma.actionProposal.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("EXECUTED");
    expect(storedPartnerArgs(row)).toMatchObject({ businessType: "도소매", ceoName: "대화대표" });
    const approvedEvent = await realPrisma.actionProposalEvent.findFirstOrThrow({
      where: { proposalId: id, toStatus: "APPROVED" },
    });
    expect(approvedEvent.note).toBe("관리자 승인 · 계산서로 채움: 사업자번호·업태·종목·주소·대표 이메일");
  });

  it("실행이 실패해도 합친 값은 기안에 남아, 재시도가 보강 값 없이도 같은 값으로 만든다", async () => {
    const id = await draft({ name: "재시도공급사", type: "VENDOR" });
    failActivityOnce = true;

    const first = await approveProposal(id, APPROVER, { partnerEnrichment: { address: "가상시 재시도로 2" } });
    expect(first).toMatchObject({ ok: false, code: "EXECUTION_FAILED", status: "FAILED" });
    expect(await realPrisma.partner.count({ where: { name: "재시도공급사" } })).toBe(0); // 롤백됨
    expect(storedPartnerArgs(await realPrisma.actionProposal.findUniqueOrThrow({ where: { id } }))).toMatchObject({
      address: "가상시 재시도로 2",
    });

    const retry = await approveProposal(id, APPROVER);
    expect(retry.ok).toBe(true);
    const partner = await realPrisma.partner.findFirstOrThrow({ where: { name: "재시도공급사" } });
    expect(partner.address).toBe("가상시 재시도로 2");
  });

  it("형식이 틀린 보강 값이면 승인 자체를 하지 않는다(대기 상태 유지)", async () => {
    const id = await draft({ name: "형식공급사", type: "VENDOR" });
    const outcome = await approveProposal(id, APPROVER, { partnerEnrichment: { businessNumber: "12-34" } });
    expect(outcome).toMatchObject({ ok: false, code: "INVALID_ENRICHMENT" });
    const row = await realPrisma.actionProposal.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("PENDING_APPROVAL");
    expect(await realPrisma.partner.count({ where: { name: "형식공급사" } })).toBe(0);
  });
});
