/**
 * katok archive.sqlite3 → WorkRecord 인제스트 러너 (Phase 4-2).
 *
 * 순서: GET /api/chat-room-mappings로 등록방+커서 수신(화이트리스트 게이트, 34만 방 전부 금지)
 *   → 방별 archive 직독(started_at > cursor AND ended_at < now-GRACE(1h), 경계 드리프트 차단)
 *   → PII 마스킹 + sourceHash 계산(ingest-mapper) → 200개 배치 업로드 → 성공분 roomCursors로 touchSync.
 *
 * 개인정보: 원문(text)은 이 프로세스 밖으로 나가지 않는다. 업로드 페이로드는 마스킹 후 텍스트만 포함.
 *
 * 사용 (모든 모드에 INGEST_TOKEN env 필수 — dry-run도 예외 아님. dry-run은 쓰기만 스킵할 뿐
 * 조회 라우트 인증까지 면제하지는 않는다):
 *   npm run kakao:ingest            # 실제 업로드
 *   npm run kakao:ingest:dry        # --dry-run: 카운트만 출력, 업로드/커서갱신 없음
 *   node --import tsx scripts/kakao-ingest.ts --room=<chatId> --since=2026-07-01T00:00:00Z
 */
import "dotenv/config";
import { SqliteChunkSourceAdapter, type ChunkRow } from "../src/lib/kakao/archive-reader";
import { mapChunksToIngestRecords, type IngestRecord } from "../src/lib/kakao/ingest-mapper";
import {
  assertServerLane,
  laneHeaders,
  resolveDeclaredLane,
} from "../src/lib/kakao/ingest-lane";

const GRACE_MS = 60 * 60 * 1000; // 1시간 — 청크 boundary drift 차단(청사진 §2)
const BATCH_SIZE = 200;
const MAX_RETRIES = 3;

type RoomMapping = {
  roomKey: string;
  roomName: string | null;
  entityType: string | null;
  entityId: string | null;
  lastSyncedAt: string | null;
};

function getArg(flag: string): string | null {
  const match = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : null;
}

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

function resolveBaseUrl(): string {
  const url = process.env.WAGCRM_INGEST_URL ?? process.env.WAG_CRM_BASE_URL ?? "http://localhost:3000";
  return url.replace(/\/$/, "");
}

// dry-run도 실토큰이 필요하다(C2 결정): --dry-run은 "쓰기(업로드/커서갱신)만 스킵"하는 옵션이지
// 인증을 면제하는 옵션이 아니다. GET /api/chat-room-mappings 등 조회 라우트도 INGEST_TOKEN
// 인증이 걸려 있으므로(C1) dry-run 조회조차 실토큰 없이는 애초에 성공할 수 없다.
function resolveIngestToken(): string {
  const token = process.env.INGEST_TOKEN;
  if (!token) {
    throw new Error(
      "INGEST_TOKEN env var is required to run the kakao ingest runner (dry-run 포함 — --dry-run은 " +
        "쓰기만 스킵할 뿐 인증까지 면제하지는 않는다)."
    );
  }
  return token;
}

async function fetchRoomMappings(
  baseUrl: string,
  token: string,
  declaredLane: string | null,
): Promise<RoomMapping[]> {
  const response = await fetch(`${baseUrl}/api/chat-room-mappings`, {
    headers: { authorization: `Bearer ${token}`, ...laneHeaders(declaredLane) },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch chat-room-mappings: ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as { rooms: RoomMapping[]; lane?: unknown; laneUnknown?: unknown };
  // ⚠️ 순서가 계약이다 — 단언은 **첫 업로드보다 먼저**여야 한다. 이 조회가 러너의 첫 요청이라
  // 여기서 걸리면 쓰기가 한 건도 나가지 않는다.
  assertServerLane(declaredLane, json);
  return json.rooms;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// 4xx(400/401/403/422)는 요청 자체가 잘못됐다는 신호라 재시도해도 동일하게 실패한다(입력 검증
// 실패, 인증 실패 등). 이런 응답은 즉시 중단하고, 5xx/429(서버 일시 장애·레이트리밋)만 백오프
// 재시도한다. 상태 코드를 실어 나르기 위해 일반 Error 대신 이 클래스를 사용한다.
class IngestHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "IngestHttpError";
  }
}

const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 422]);

async function uploadBatch(
  baseUrl: string,
  token: string,
  records: IngestRecord[],
  declaredLane: string | null
): Promise<{ upserted: number; skipped: number; failed: number; roomCursors: Record<string, string> }> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < MAX_RETRIES) {
    attempt += 1;
    try {
      const response = await fetch(`${baseUrl}/api/work-records/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...laneHeaders(declaredLane),
        },
        body: JSON.stringify({ source: "KAKAO", records }),
      });

      if (!response.ok) {
        throw new IngestHttpError(
          response.status,
          `Ingest upload failed: ${response.status} ${await response.text()}`
        );
      }

      return (await response.json()) as {
        upserted: number;
        skipped: number;
        failed: number;
        roomCursors: Record<string, string>;
      };
    } catch (error) {
      lastError = error;

      if (error instanceof IngestHttpError && NON_RETRYABLE_STATUSES.has(error.status)) {
        console.error(`[kakao-ingest] upload failed with non-retryable status ${error.status}, aborting batch:`, error);
        throw error;
      }

      if (attempt < MAX_RETRIES) {
        const backoffMs = 500 * 2 ** (attempt - 1);
        console.warn(`[kakao-ingest] upload attempt ${attempt} failed, retrying in ${backoffMs}ms:`, error);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  const dryRun = isDryRun();
  const roomFilter = getArg("--room");
  const sinceOverride = getArg("--since");
  const baseUrl = resolveBaseUrl();
  // dry-run도 실토큰 필수(C2) — 조회 라우트(GET /api/chat-room-mappings)도 인증이 걸려 있어
  // "dry-run" 플레이스홀더로는 애초에 조회조차 되지 않는다.
  const token = resolveIngestToken();
  // 선언 레인은 baseUrl 에서 파생한다 — 러너가 아는 유일한 "상대"가 그것이다.
  const declaredLane = resolveDeclaredLane(baseUrl);

  const graceCutoff = new Date(Date.now() - GRACE_MS);

  console.log(`[kakao-ingest] mode=${dryRun ? "dry-run" : "live"} baseUrl=${baseUrl} graceCutoff=${graceCutoff.toISOString()}`);

  // 화이트리스트 게이트: 등록방(ChatRoomMapping)만 스캔한다. 34만 방 전부 스캔 금지(청사진 §5).
  const rooms = await fetchRoomMappings(baseUrl, token, declaredLane);
  const targetRooms = roomFilter ? rooms.filter((r) => r.roomKey === roomFilter) : rooms;

  if (targetRooms.length === 0) {
    console.log("[kakao-ingest] No registered rooms to scan (whitelist empty or --room filter matched nothing). Exiting.");
    return;
  }

  const reader = new SqliteChunkSourceAdapter();

  let totalRead = 0;
  let totalUploaded = 0;
  const allRecords: { roomKey: string; records: IngestRecord[] }[] = [];

  try {
    for (const room of targetRooms) {
      const since = sinceOverride
        ? new Date(sinceOverride)
        : room.lastSyncedAt
          ? new Date(room.lastSyncedAt)
          : new Date(0);

      let chunks: ChunkRow[];
      try {
        chunks = reader.readNewChunks(room.roomKey, since, graceCutoff);
      } catch (error) {
        console.error(`[kakao-ingest] Failed to read chunks for room ${room.roomKey}:`, error);
        continue;
      }

      totalRead += chunks.length;
      if (chunks.length === 0) continue;

      const records = mapChunksToIngestRecords(chunks);
      allRecords.push({ roomKey: room.roomKey, records });

      console.log(`[kakao-ingest] room=${room.roomKey} newChunks=${chunks.length}`);
    }
  } finally {
    reader.close();
  }

  if (dryRun) {
    console.log(`[kakao-ingest] DRY RUN: would upload ${allRecords.reduce((sum, r) => sum + r.records.length, 0)} records across ${allRecords.length} rooms.`);
    console.log(`[kakao-ingest] DRY RUN: totalChunksRead=${totalRead}`);
    return;
  }

  const flatRecords = allRecords.flatMap((r) => r.records);
  const batches = chunkArray(flatRecords, BATCH_SIZE);

  const roomMaxSentAt = new Map<string, string>();

  for (const batch of batches) {
    try {
      // 서버가 업로드 성공분의 방별 max(sentAt)로 ChatRoomMapping.lastSyncedAt을 직접 전진시킨다
      // (POST /api/work-records/ingest 참고). 실패한 배치는 커서가 전진하지 않아 재시도 시 멱등하다(청사진 §6).
      const result = await uploadBatch(baseUrl, token, batch, declaredLane);
      totalUploaded += result.upserted;
      for (const [roomKey, maxSentAt] of Object.entries(result.roomCursors)) {
        const existing = roomMaxSentAt.get(roomKey);
        if (!existing || new Date(maxSentAt) > new Date(existing)) {
          roomMaxSentAt.set(roomKey, maxSentAt);
        }
      }
    } catch (error) {
      console.error(`[kakao-ingest] Batch upload failed after ${MAX_RETRIES} retries, skipping cursor advance for this batch:`, error);
    }
  }

  console.log(`[kakao-ingest] Done. chunksRead=${totalRead} uploaded=${totalUploaded} roomsTouched=${roomMaxSentAt.size}`);
}

main().catch((error) => {
  console.error("[kakao-ingest] Fatal error:", error);
  process.exitCode = 1;
});
