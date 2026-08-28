import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteChunkSourceAdapter } from "../archive-reader";

// 합성 sqlite 픽스처만 사용 — 실 archive.sqlite3는 절대 열지 않는다.
// 스키마는 청사진에 기재된 chunks 테이블 컬럼 구조만 재현한다(개인정보 없는 구조 재현).

const runtimeRequire = createRequire(import.meta.url);
const Database = runtimeRequire("better-sqlite3") as typeof import("better-sqlite3");

let tmpDir: string;
let dbPath: string;

function seedSyntheticArchive(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE chunks (
      chunk_id TEXT PRIMARY KEY,
      account_hash TEXT,
      chat_id TEXT,
      chat_name TEXT,
      sender_nickname TEXT,
      started_at TEXT,
      ended_at TEXT,
      text TEXT,
      message_count INTEGER
    );
  `);

  const insert = db.prepare(`
    INSERT INTO chunks (chunk_id, account_hash, chat_id, chat_name, sender_nickname, started_at, ended_at, text, message_count)
    VALUES (@chunk_id, @account_hash, @chat_id, @chat_name, @sender_nickname, @started_at, @ended_at, @text, @message_count)
  `);

  const rows = [
    {
      chunk_id: "chunk-1",
      account_hash: "synthetic-account",
      chat_id: "room-a",
      chat_name: "테스트방A",
      sender_nickname: "홍길동",
      started_at: "2026-07-01T00:00:00.000Z",
      ended_at: "2026-07-01T00:01:00.000Z",
      text: "합성 테스트 메시지 1",
      message_count: 2,
    },
    {
      chunk_id: "chunk-2",
      account_hash: "synthetic-account",
      chat_id: "room-a",
      chat_name: "테스트방A",
      sender_nickname: "홍길동",
      started_at: "2026-07-02T00:00:00.000Z",
      ended_at: "2026-07-02T00:01:00.000Z",
      text: "합성 테스트 메시지 2",
      message_count: 1,
    },
    // 아직 종료가 확정되지 않은(그레이스 컷오프 이후에 끝나는) 청크 — 제외되어야 함
    {
      chunk_id: "chunk-3-growing",
      account_hash: "synthetic-account",
      chat_id: "room-a",
      chat_name: "테스트방A",
      sender_nickname: "홍길동",
      started_at: "2026-07-03T00:00:00.000Z",
      ended_at: new Date().toISOString(),
      text: "아직 자라는 중인 청크",
      message_count: 1,
    },
    // 다른 방 — chatId 필터링 확인용
    {
      chunk_id: "chunk-4-other-room",
      account_hash: "synthetic-account",
      chat_id: "room-b",
      chat_name: "테스트방B",
      sender_nickname: "이영희",
      started_at: "2026-07-01T00:00:00.000Z",
      ended_at: "2026-07-01T00:01:00.000Z",
      text: "다른 방 메시지",
      message_count: 1,
    },
  ];

  for (const row of rows) {
    insert.run(row);
  }

  db.close();
}

describe("SqliteChunkSourceAdapter — 합성 sqlite 픽스처 read 테스트", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kakao-archive-test-"));
    dbPath = join(tmpDir, "archive.sqlite3");
    seedSyntheticArchive(dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("since 이후 시작 && graceCutoff 이전 종료된 확정 청크만 반환한다", () => {
    const adapter = new SqliteChunkSourceAdapter(dbPath);
    try {
      const since = new Date("2026-06-30T00:00:00.000Z");
      const graceCutoff = new Date(Date.now() - 60 * 60 * 1000); // 1시간 그레이스

      const chunks = adapter.readNewChunks("room-a", since, graceCutoff);

      const chunkIds = chunks.map((c) => c.chunkId);
      expect(chunkIds).toContain("chunk-1");
      expect(chunkIds).toContain("chunk-2");
      expect(chunkIds).not.toContain("chunk-3-growing"); // 자라는 중 → 제외
      expect(chunkIds).not.toContain("chunk-4-other-room"); // 다른 방 → 제외
    } finally {
      adapter.close();
    }
  });

  it("since 커서 이후 청크만 반환한다(증분)", () => {
    const adapter = new SqliteChunkSourceAdapter(dbPath);
    try {
      const since = new Date("2026-07-01T12:00:00.000Z"); // chunk-1 이후, chunk-2 이전
      const graceCutoff = new Date(Date.now() - 60 * 60 * 1000);

      const chunks = adapter.readNewChunks("room-a", since, graceCutoff);
      const chunkIds = chunks.map((c) => c.chunkId);

      expect(chunkIds).not.toContain("chunk-1");
      expect(chunkIds).toContain("chunk-2");
    } finally {
      adapter.close();
    }
  });

  it("필드가 snake_case DB 컬럼에서 camelCase ChunkRow로 정확히 매핑된다", () => {
    const adapter = new SqliteChunkSourceAdapter(dbPath);
    try {
      const since = new Date("2026-06-30T00:00:00.000Z");
      const graceCutoff = new Date(Date.now() - 60 * 60 * 1000);
      const chunks = adapter.readNewChunks("room-a", since, graceCutoff);

      const chunk1 = chunks.find((c) => c.chunkId === "chunk-1");
      expect(chunk1).toBeDefined();
      expect(chunk1?.chatId).toBe("room-a");
      expect(chunk1?.chatName).toBe("테스트방A");
      expect(chunk1?.senderNickname).toBe("홍길동");
      expect(chunk1?.messageCount).toBe(2);
      expect(chunk1?.text).toBe("합성 테스트 메시지 1");
    } finally {
      adapter.close();
    }
  });

  it("존재하지 않는 방을 조회하면 빈 배열을 반환한다", () => {
    const adapter = new SqliteChunkSourceAdapter(dbPath);
    try {
      const chunks = adapter.readNewChunks("room-nonexistent", new Date(0), new Date());
      expect(chunks).toEqual([]);
    } finally {
      adapter.close();
    }
  });
});
