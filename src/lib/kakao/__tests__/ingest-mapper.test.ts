import { describe, expect, it } from "vitest";
import { mapChunkToIngestRecord, mapChunksToIngestRecords } from "../ingest-mapper";
import type { ChunkRow } from "../archive-reader";

// 합성 픽스처만 사용. 실 archive 메시지 원문은 절대 사용하지 않는다.

function makeSyntheticChunk(overrides: Partial<ChunkRow> = {}): ChunkRow {
  return {
    chunkId: "synthetic-chunk-001",
    chatId: "room-abc",
    chatName: "테스트방",
    senderNickname: "김철수",
    startedAt: "2026-07-05T01:00:00.000Z",
    endedAt: "2026-07-05T01:00:30.000Z",
    text: "정산 관련해서 확인 부탁드립니다.",
    messageCount: 2,
    ...overrides,
  };
}

describe("mapChunkToIngestRecord — chunk→ingest 페이로드 변환", () => {
  it("ChunkRow를 IngestRecord 필드로 정확히 매핑한다(roomKey=chat_id, sentAt=started_at)", () => {
    const chunk = makeSyntheticChunk();
    const record = mapChunkToIngestRecord(chunk);

    expect(record.roomKey).toBe(chunk.chatId);
    expect(record.sender).toBe(chunk.senderNickname);
    expect(record.sentAt).toBe(new Date(chunk.startedAt).toISOString());
    expect(record.chunkId).toBe(chunk.chunkId);
    expect(record.rawText).toBe(chunk.text); // PII 없는 텍스트는 그대로
    expect(record.isMasked).toBe(false);
  });

  it("동일 청크를 2회 매핑하면 동일한 sourceHash를 낸다(멱등)", () => {
    const chunk = makeSyntheticChunk();
    const record1 = mapChunkToIngestRecord(chunk);
    const record2 = mapChunkToIngestRecord({ ...chunk });

    expect(record1.sourceHash).toBe(record2.sourceHash);
  });

  it("PII가 포함된 텍스트는 마스킹 후 텍스트로 sourceHash를 계산한다(isMasked=true)", () => {
    const chunk = makeSyntheticChunk({
      text: "연락처는 010-1234-5678 입니다. 정산 부탁드려요.",
    });
    const record = mapChunkToIngestRecord(chunk);

    expect(record.isMasked).toBe(true);
    expect(record.rawText).toContain("[PHONE_MASKED]");
    expect(record.rawText).not.toContain("010-1234-5678");

    // 같은 원문 청크를 다시 매핑해도 마스킹이 결정적이므로 sourceHash가 동일해야 한다.
    const record2 = mapChunkToIngestRecord({ ...chunk });
    expect(record.sourceHash).toBe(record2.sourceHash);
  });

  it("다른 청크(다른 chatId)는 다른 sourceHash를 낸다", () => {
    const chunkA = makeSyntheticChunk({ chatId: "room-a" });
    const chunkB = makeSyntheticChunk({ chatId: "room-b" });

    const recordA = mapChunkToIngestRecord(chunkA);
    const recordB = mapChunkToIngestRecord(chunkB);

    expect(recordA.sourceHash).not.toBe(recordB.sourceHash);
  });

  it("경계 드리프트로 텍스트가 자라난 청크(재빌드)는 다른 sourceHash를 낸다", () => {
    // chunking.rs의 append 시 마지막 청크 재빌드 시나리오를 시뮬레이션: 동일 chunkId지만 text가 자람.
    const before = makeSyntheticChunk({ text: "확인 부탁드립니다" });
    const after = makeSyntheticChunk({ text: "확인 부탁드립니다. 추가로 한 줄 더요." });

    const recordBefore = mapChunkToIngestRecord(before);
    const recordAfter = mapChunkToIngestRecord(after);

    expect(recordBefore.sourceHash).not.toBe(recordAfter.sourceHash);
  });
});

describe("mapChunksToIngestRecords — 배열 변환", () => {
  it("여러 청크를 순서대로 매핑한다", () => {
    const chunks = [
      makeSyntheticChunk({ chunkId: "c1", startedAt: "2026-07-05T01:00:00.000Z" }),
      makeSyntheticChunk({ chunkId: "c2", startedAt: "2026-07-05T01:05:00.000Z" }),
    ];
    const records = mapChunksToIngestRecords(chunks);

    expect(records).toHaveLength(2);
    expect(records[0].chunkId).toBe("c1");
    expect(records[1].chunkId).toBe("c2");
  });

  it("빈 배열은 빈 배열을 반환한다", () => {
    expect(mapChunksToIngestRecords([])).toEqual([]);
  });
});
