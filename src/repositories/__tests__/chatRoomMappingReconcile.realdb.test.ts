/**
 * 카톡 폴더 → 화이트리스트 정합(reconcileFolderRooms) 실 SQLite 회귀.
 * "폴더 = 수집 스위치" 정책(설계: kakao_folder_autoregister_design_20260708)의 핵심 케이스:
 *  신규 등록 · pause · resume · 수동방 불가침 · TXT_UPLOAD 존중 · entity 보존.
 * 격리 임시 DB 패턴은 actionProposal.transition.realdb.test.ts와 동일(공유 dev.db 미접촉).
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

vi.mock("@/lib/prisma", () => ({ getPrisma: () => realPrisma }));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => true }));

const FOLDER = "folder-gonggu";

async function get(roomKey: string) {
  return realPrisma.chatRoomMapping.findUnique({
    where: { source_roomKey: { source: "KAKAO", roomKey } },
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-folder-reconcile-"));
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
  await realPrisma?.$disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await realPrisma.chatRoomMapping.deleteMany({});
});

describe("ChatRoomMappingRepository.reconcileFolderRooms — 폴더=수집 스위치 (실 SQLite)", () => {
  it("신규 폴더 방을 KATOK_AUTO·excluded=false·sourceFolderId로 등록한다", async () => {
    const { ChatRoomMappingRepository } = await import("../workRecordRepository");
    const res = await ChatRoomMappingRepository.reconcileFolderRooms({
      folderId: FOLDER,
      rooms: [{ roomKey: "r1", roomName: "방1", roomType: "GROUP" }],
    });
    expect(res.added).toBe(1);
    const row = await get("r1");
    expect(row.collectorType).toBe("KATOK_AUTO");
    expect(row.excluded).toBe(false);
    expect(row.sourceFolderId).toBe(FOLDER);
    expect(row.roomName).toBe("방1");
    expect(row.roomType).toBe("GROUP");
  });

  it("폴더에서 빠진 관리방은 pause(excluded=true)하되 행·데이터는 보존한다", async () => {
    const { ChatRoomMappingRepository } = await import("../workRecordRepository");
    await ChatRoomMappingRepository.reconcileFolderRooms({
      folderId: FOLDER,
      rooms: [{ roomKey: "r1" }, { roomKey: "r2" }],
    });
    const res = await ChatRoomMappingRepository.reconcileFolderRooms({
      folderId: FOLDER,
      rooms: [{ roomKey: "r1" }],
    });
    expect(res.paused).toBe(1);
    expect((await get("r2")).excluded).toBe(true);
    expect(await get("r2")).not.toBeNull(); // 데이터 보존(삭제 아님)
    expect((await get("r1")).excluded).toBe(false);
  });

  it("pause된 방이 폴더에 다시 들어오면 resume(excluded=false)한다", async () => {
    const { ChatRoomMappingRepository } = await import("../workRecordRepository");
    await ChatRoomMappingRepository.reconcileFolderRooms({ folderId: FOLDER, rooms: [{ roomKey: "r1" }] });
    await ChatRoomMappingRepository.reconcileFolderRooms({ folderId: FOLDER, rooms: [] });
    expect((await get("r1")).excluded).toBe(true);
    const res = await ChatRoomMappingRepository.reconcileFolderRooms({ folderId: FOLDER, rooms: [{ roomKey: "r1" }] });
    expect(res.resumed).toBe(1);
    expect((await get("r1")).excluded).toBe(false);
  });

  it("수동 등록방(sourceFolderId=null)은 폴더에 없어도 pause하지 않는다", async () => {
    const { ChatRoomMappingRepository } = await import("../workRecordRepository");
    await realPrisma.chatRoomMapping.create({
      data: { source: "KAKAO", roomKey: "manual", collectorType: "KATOK_AUTO", excluded: false },
    });
    await ChatRoomMappingRepository.reconcileFolderRooms({ folderId: FOLDER, rooms: [{ roomKey: "r1" }] });
    const row = await get("manual");
    expect(row.excluded).toBe(false);
    expect(row.sourceFolderId).toBeNull();
  });

  it("TXT_UPLOAD 방은 폴더에 있어도 자동 승격하지 않고 skip한다", async () => {
    const { ChatRoomMappingRepository } = await import("../workRecordRepository");
    await realPrisma.chatRoomMapping.create({
      data: { source: "KAKAO", roomKey: "txt", collectorType: "TXT_UPLOAD", excluded: false },
    });
    const res = await ChatRoomMappingRepository.reconcileFolderRooms({
      folderId: FOLDER,
      rooms: [{ roomKey: "txt" }],
    });
    expect(res.skippedTxt).toBe(1);
    const row = await get("txt");
    expect(row.collectorType).toBe("TXT_UPLOAD");
    expect(row.sourceFolderId).toBeNull();
  });

  it("기존 entity 매핑(entityType/entityId)은 재정합 시 보존하고 roomName만 갱신한다", async () => {
    const { ChatRoomMappingRepository } = await import("../workRecordRepository");
    await ChatRoomMappingRepository.reconcileFolderRooms({
      folderId: FOLDER,
      rooms: [{ roomKey: "r1", roomName: "방1" }],
    });
    await realPrisma.chatRoomMapping.update({
      where: { source_roomKey: { source: "KAKAO", roomKey: "r1" } },
      data: { entityType: "SELLER", entityId: "seller-1" },
    });
    await ChatRoomMappingRepository.reconcileFolderRooms({
      folderId: FOLDER,
      rooms: [{ roomKey: "r1", roomName: "방1-갱신" }],
    });
    const row = await get("r1");
    expect(row.entityType).toBe("SELLER");
    expect(row.entityId).toBe("seller-1");
    expect(row.roomName).toBe("방1-갱신");
  });
});
