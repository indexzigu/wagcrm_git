/**
 * ChunkRow(archive-reader) → 인제스트 페이로드(POST /api/work-records/ingest body.records[]) 변환.
 *
 * sourceHash는 워커/서버 동일 함수(workRecordRepository.computeSourceHash)를 재사용해
 * 러너가 계산한 값과 서버 재검증값이 항상 일치하도록 한다(§5 정합 리스크 대응).
 * 마스킹 후 텍스트로 해시를 계산해야 멱등이 유지된다 — 원문으로 계산하면 마스킹 로직이
 * 바뀔 때마다 sourceHash가 텍스트와 별개로 어긋날 수 있다.
 */

import { computeSourceHash } from "@/repositories/workRecordRepository";
import type { ChunkRow } from "./archive-reader";
import { maskPii } from "./pii-mask";

export type IngestRecord = {
  roomKey: string;
  sender: string | null;
  sentAt: string; // ISO 8601
  rawText: string; // 마스킹 후 텍스트
  isMasked: boolean;
  sourceHash: string;
  chunkId: string;
};

/**
 * chunk 단위 매핑(§2): roomKey=chat_id, sender=sender_nickname, sentAt=started_at, rawText=chunks.text.
 * sentAt은 started_at을 사용한다 — 청크는 단일 발신자 연속 발화이므로 시작 시각이 논리적 발생 시각이다.
 */
export function mapChunkToIngestRecord(chunk: ChunkRow): IngestRecord {
  const { text: maskedText, masked } = maskPii(chunk.text);

  const sourceHash = computeSourceHash({
    roomKey: chunk.chatId,
    sentAt: chunk.startedAt,
    sender: chunk.senderNickname,
    rawText: maskedText,
  });

  return {
    roomKey: chunk.chatId,
    sender: chunk.senderNickname,
    sentAt: new Date(chunk.startedAt).toISOString(),
    rawText: maskedText,
    isMasked: masked,
    sourceHash,
    chunkId: chunk.chunkId,
  };
}

export function mapChunksToIngestRecords(chunks: ChunkRow[]): IngestRecord[] {
  return chunks.map(mapChunkToIngestRecord);
}
