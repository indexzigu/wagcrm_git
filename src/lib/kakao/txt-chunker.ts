/**
 * txt 파싱 결과(ParsedMessage[])를 결정적으로 청킹해 기존 ChunkRow 계약(archive-reader.ts)에
 * 맞춘다 — 그러면 katok 자동 수집 경로와 동일한 mapChunksToIngestRecords(ingest-mapper.ts)를
 * 재사용할 수 있다(Phase 4-5 §설계).
 *
 * 청킹 규칙: 시간 갭이 임계(threshold)를 초과하면 새 청크를 시작한다.
 *   GROUP/OPEN: 600초, DIRECT: 1800초.
 * roomType 판정: 파일 내 고유 발신자 수 >= 3이면 GROUP, 아니면 DIRECT. 관리 UI에서 방 유형을
 * 수동으로 교정할 수 있으나(ChatRoomMapping.roomType), 그 교정이 청킹 임계값 재계산을 유발하지는
 * 않는다 — 이미 커밋된 WorkRecord/청크는 재청킹되지 않고 표시상의 배지만 바뀐다.
 *
 * chunkId는 roomKey + 청크 시작 시각(ISO)으로 결정적으로 합성한다(같은 입력 재실행 시 항상
 * 동일한 chunkId → sourceHash도 동일 → 재업로드 시 멱등 dedup이 성립).
 *
 * text는 `[HH:mm] 발신자: 내용` 형태의 줄을 개행으로 결합한다. senderNickname은 청크 내 첫
 * 발신자(멀티 발신자 청크에서도 대표값 하나만 필요한 ChunkRow 계약을 따름).
 *
 * 잘림 경계(청크 앞부분이 겹치는 재업로드) 중복은 허용 리스크로 승인됨 — 겹치는 구간은 동일한
 * sourceHash를 내므로 서버 upsert 단계에서 자연스럽게 dedup된다.
 */

import type { ChunkRow } from "./archive-reader";
import type { ParsedMessage } from "./txt-parser";

export type RoomType = "DIRECT" | "GROUP" | "OPEN";

const GROUP_GAP_THRESHOLD_MS = 600 * 1000;
const DIRECT_GAP_THRESHOLD_MS = 1800 * 1000;
const GROUP_SENDER_THRESHOLD = 3;

/** 파일 내 고유 발신자 수 기반 방 유형 판정. */
export function detectRoomType(messages: ParsedMessage[]): RoomType {
  const uniqueSenders = new Set(messages.map((m) => m.sender));
  return uniqueSenders.size >= GROUP_SENDER_THRESHOLD ? "GROUP" : "DIRECT";
}

function formatLine(message: ParsedMessage): string {
  // UI 표기는 KST 기준 HH:mm이 자연스러우나, text 필드는 사람이 읽는 로그 목적이라
  // 저장된 시각(UTC)을 그대로 HH:mm로 표기해도 무방하다(파서가 이미 UTC로 변환 완료).
  // 여기서는 원본 KST 표기를 복원하기 위해 UTC+9로 되돌린다.
  const kst = new Date(message.sentAt.getTime() + 9 * 60 * 60 * 1000);
  const hhKst = String(kst.getUTCHours()).padStart(2, "0");
  const mmKst = String(kst.getUTCMinutes()).padStart(2, "0");
  return `[${hhKst}:${mmKst}] ${message.sender}: ${message.text}`;
}

/**
 * 시간 갭 기반 결정적 청킹. roomKey/chatName은 호출부(room-key.ts 결과)에서 주입한다.
 */
export function chunkMessages(
  messages: ParsedMessage[],
  options: { roomKey: string; roomName: string | null; roomType: RoomType }
): ChunkRow[] {
  if (messages.length === 0) return [];

  const threshold = options.roomType === "DIRECT" ? DIRECT_GAP_THRESHOLD_MS : GROUP_GAP_THRESHOLD_MS;

  // 시간순 정렬(입력이 이미 정렬되어 있다는 가정을 강제하지 않고 방어적으로 재정렬 — 결정성 보장).
  const sorted = [...messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  const chunks: ChunkRow[] = [];
  let currentGroup: ParsedMessage[] = [sorted[0]];

  const flush = () => {
    if (currentGroup.length === 0) return;
    const startedAt = currentGroup[0].sentAt;
    const endedAt = currentGroup[currentGroup.length - 1].sentAt;
    const chunkId = `${options.roomKey}:${startedAt.toISOString()}`;
    const text = currentGroup.map(formatLine).join("\n");

    chunks.push({
      chunkId,
      chatId: options.roomKey,
      chatName: options.roomName,
      senderNickname: currentGroup[0].sender,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      text,
      messageCount: currentGroup.length,
    });
  };

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gapMs = curr.sentAt.getTime() - prev.sentAt.getTime();

    if (gapMs > threshold) {
      flush();
      currentGroup = [curr];
    } else {
      currentGroup.push(curr);
    }
  }
  flush();

  return chunks;
}
