import { createRequire } from "node:module";

/**
 * katok archive.sqlite3 read-only 리더.
 *
 * 실측 스키마(개인정보 비노출 — 구조만):
 *   chunks(chunk_id, account_hash, chat_id, chat_name, sender_nickname, started_at, ended_at, text, message_count)
 * chunk = 단일 발신자 연속 발화 묶음(chunking.rs). chunk_id는 계정|채팅|첫메시지|마지막메시지 기반 결정적 해시.
 * 주의: append 시 마지막 청크가 재빌드될 수 있음(boundary drift) → 호출부에서 ended_at < graceCutoff로 확정본만 사용.
 *
 * 소스 어댑터 추상화: 실 아카이브(SqliteChunkSourceAdapter) 외에 txt 폴백(4-1B, 카톡 UI 변경으로
 * sync 붕괴 시 대비) 등 다른 구현체가 동일한 ChunkRow[] 계약만 지키면 러너가 그대로 재사용 가능하게 한다.
 */

export type ChunkRow = {
  chunkId: string;
  chatId: string;
  chatName: string | null;
  senderNickname: string | null;
  startedAt: string; // RFC3339 UTC
  endedAt: string; // RFC3339 UTC
  text: string;
  messageCount: number;
};

export interface ChunkSourceAdapter {
  /**
   * 지정된 chatId(방)에서 since 이후 시작되었고, graceCutoff 이전에 종료가 확정된 청크만 반환한다.
   * (started_at > since) AND (ended_at < graceCutoff)
   */
  readNewChunks(chatId: string, since: Date, graceCutoff: Date): ChunkRow[];

  /** 리더가 관리하는 리소스(DB 커넥션 등) 정리 */
  close(): void;
}

const DEFAULT_ARCHIVE_PATH =
  "~/Library/Application Support/katok/archive.sqlite3";

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return `${home}/${path.slice(2)}`;
  }
  return path;
}

export function resolveArchivePath(): string {
  const override = process.env.KATOK_ARCHIVE_PATH;
  return expandHome(override && override.trim().length > 0 ? override : DEFAULT_ARCHIVE_PATH);
}

/**
 * better-sqlite3 기반 read-only 어댑터. archive.sqlite3를 직접 오픈한다.
 * better-sqlite3는 CJS 모듈이라 ESM(node --import tsx) 컨텍스트에서 createRequire로 로드한다
 * (src/lib/prisma-client.ts의 SQLite 클라이언트 로딩과 동일 패턴).
 */
export class SqliteChunkSourceAdapter implements ChunkSourceAdapter {
  // better-sqlite3 Database 인스턴스. 타입은 any로 두고 사용부에서 필요한 메서드만 호출한다.
  private db: import("better-sqlite3").Database;

  constructor(dbPath: string = resolveArchivePath()) {
    const Database = loadBetterSqlite3();
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  readNewChunks(chatId: string, since: Date, graceCutoff: Date): ChunkRow[] {
    const sinceIso = since.toISOString();
    const graceCutoffIso = graceCutoff.toISOString();

    const stmt = this.db.prepare(
      `SELECT chunk_id, chat_id, chat_name, sender_nickname, started_at, ended_at, text, message_count
       FROM chunks
       WHERE chat_id = ?
         AND started_at > ?
         AND ended_at < ?
       ORDER BY started_at ASC`
    );

    const rows = stmt.all(chatId, sinceIso, graceCutoffIso) as Array<{
      chunk_id: string;
      chat_id: string;
      chat_name: string | null;
      sender_nickname: string | null;
      started_at: string;
      ended_at: string;
      text: string;
      message_count: number;
    }>;

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      chatId: row.chat_id,
      chatName: row.chat_name,
      senderNickname: row.sender_nickname,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      text: row.text,
      messageCount: row.message_count,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function loadBetterSqlite3(): typeof import("better-sqlite3") {
  // Next.js/ESM 런타임에서도 안전하게 동작하도록 createRequire로 CJS 네이티브 모듈을 로드한다
  // (src/lib/prisma-client.ts의 SQLite Prisma 클라이언트 로딩과 동일 패턴).
  const runtimeRequire = createRequire(import.meta.url);
  return runtimeRequire("better-sqlite3");
}
