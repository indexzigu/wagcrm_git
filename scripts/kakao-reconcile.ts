/**
 * 카톡 "공구 폴더" → CRM 화이트리스트 정합 러너 (설계: kakao_folder_autoregister_design_20260708).
 *
 * 순서: `katok source folders --json` 실행 → 대상 폴더(기본 "공구") 추출
 *   → POST /api/chat-room-mappings/reconcile (폴더 방 등록/수집 ON, 빠진 관리분 pause).
 *
 * 래퍼(kakao-auto-ingest.sh)가 sync와 ingest 사이에서 호출한다. 실패는 비차단(래퍼가 ingest 계속).
 * 본문(대화)은 전송하지 않는다 — 페이로드는 roomKey+roomName+roomType만.
 *
 * env:
 *   INGEST_TOKEN         (필수) reconcile 라우트 인증
 *   WAGCRM_INGEST_URL    베이스 URL (기본 http://localhost:3000)
 *   KATOK_BIN            katok 바이너리 경로 (기본 ~/.gemini/antigravity/tools/katok/target/release/katok)
 *   KAKAO_SYNC_FOLDER    동기화 대상 폴더명 (기본 "공구")
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { assertServerLane, laneHeaders, resolveDeclaredLane } from "../src/lib/kakao/ingest-lane";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

type FolderRoom = { room_key: string; room_name: string | null; room_type: string | null };
type Folder = { folder_id: string; name: string; hidden: boolean; chat_count: number; rooms: FolderRoom[] };

function resolveBaseUrl(): string {
  const url = process.env.WAGCRM_INGEST_URL ?? process.env.WAG_CRM_BASE_URL ?? "http://localhost:3000";
  return url.replace(/\/$/, "");
}

function resolveKatokBin(): string {
  return (
    process.env.KATOK_BIN ??
    join(homedir(), ".gemini/antigravity/tools/katok/target/release/katok")
  );
}

function resolveIngestToken(): string {
  const token = process.env.INGEST_TOKEN;
  if (!token) {
    throw new Error("INGEST_TOKEN env var is required to run the kakao reconcile runner.");
  }
  return token;
}

async function readFolders(katokBin: string): Promise<Folder[]> {
  // katok은 폴더 목록을 stdout(JSON)으로 낸다. maxBuffer를 넉넉히(폴더/방 수 대비 충분).
  const { stdout } = await execFileAsync(katokBin, ["source", "folders", "--json"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { folders: Folder[] };
  return parsed.folders ?? [];
}

/**
 * 레인 단언 전용 프리플라이트. 등록방 조회 라우트를 읽기 전용으로 한 번 두드려 상대가 밝히는
 * 레인 신원을 받는다(인제스트 러너가 쓰는 것과 같은 라우트·같은 단언).
 */
async function assertLaneBeforeWrite(
  baseUrl: string,
  token: string,
  declaredLane: string | null
): Promise<void> {
  if (!declaredLane) return; // 루프백 — 체계 밖
  const response = await fetch(`${baseUrl}/api/chat-room-mappings`, {
    headers: { authorization: `Bearer ${token}`, ...laneHeaders(declaredLane) },
  });
  if (!response.ok) {
    throw new Error(`lane preflight failed: ${response.status} ${await response.text()}`);
  }
  assertServerLane(declaredLane, (await response.json()) as { lane?: unknown });
}

async function main() {
  const baseUrl = resolveBaseUrl();
  const token = resolveIngestToken();
  const declaredLane = resolveDeclaredLane(baseUrl);
  const katokBin = resolveKatokBin();
  const targetName = process.env.KAKAO_SYNC_FOLDER ?? "공구";

  const folders = await readFolders(katokBin);
  const target = folders.find((f) => f.name === targetName && !f.hidden);

  if (!target) {
    console.log(`[kakao-reconcile] 대상 폴더 "${targetName}" 없음 — 정합 스킵.`);
    return;
  }

  // ⚠️ **쓰기 전에** 상대 신원을 확인한다 — 이 스크립트는 조회 없이 곧바로 POST 하므로,
  // 단언을 넣지 않으면 화이트리스트 토글이 엉뚱한 배포로 나간다(2026-08-26 실사고 계열).
  // 래퍼(kakao-auto-ingest.sh)가 reconcile 실패를 비차단으로 넘기므로 여기서 조용히 성공하면
  // 잘못된 레인에 쓴 사실이 어디에도 안 남는다.
  await assertLaneBeforeWrite(baseUrl, token, declaredLane);

  const rooms = target.rooms.map((r) => ({
    roomKey: r.room_key,
    roomName: r.room_name,
    roomType: r.room_type,
  }));

  console.log(
    `[kakao-reconcile] folder="${target.name}" id=${target.folder_id} rooms=${rooms.length} baseUrl=${baseUrl}`
  );

  const response = await fetch(`${baseUrl}/api/chat-room-mappings/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...laneHeaders(declaredLane),
    },
    body: JSON.stringify({
      source: "KAKAO",
      folderId: target.folder_id,
      folderName: target.name,
      rooms,
    }),
  });

  if (!response.ok) {
    throw new Error(`reconcile failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as {
    result: { added: number; resumed: number; unchanged: number; paused: number; skippedTxt: number };
  };
  const r = json.result;
  console.log(
    `[kakao-reconcile] Done. added=${r.added} resumed=${r.resumed} paused=${r.paused} unchanged=${r.unchanged} skippedTxt=${r.skippedTxt}`
  );
}

main().catch((error) => {
  console.error("[kakao-reconcile] Fatal error:", error);
  process.exitCode = 1;
});
