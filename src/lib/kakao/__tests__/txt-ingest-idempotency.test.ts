import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 멱등 통합 테스트(Phase 4-5 §테스트): 같은 픽스처를 commit 로직(파싱→청킹→매핑→WorkRecord upsert)에
// 2회 통과시켜, 2회차에는 신규 0건/전부 중복(기존 sourceHash 존재)이 되는지 실 SQLite(dev.db)로
// 검증한다. naverOrderSnapshotRepository.test.ts / priceMonitorSnapshotRepository.test.ts와 동일
// 관례: DATABASE_URL을 file:./dev.db로 설정한 뒤 모듈을 동적 임포트한다(isSqliteDatabaseUrl 분기가
// 모듈 로드 시점에 결정되므로 매 테스트 vi.resetModules() 후 재로딩).

const originalDatabaseUrl = process.env.DATABASE_URL;

async function loadDeps() {
  vi.resetModules();
  process.env.DATABASE_URL = "file:./dev.db";
  const { getPrisma } = await import("@/lib/prisma");
  const { WorkRecordRepository, ChatRoomMappingRepository } = await import(
    "@/repositories/workRecordRepository"
  );
  const { parseKakaoTxt } = await import("../txt-parser");
  const { chunkMessages, detectRoomType } = await import("../txt-chunker");
  const { computeRoomKey, TXT_SOURCE } = await import("../room-key");
  const { mapChunksToIngestRecords } = await import("../ingest-mapper");
  return {
    getPrisma,
    WorkRecordRepository,
    ChatRoomMappingRepository,
    parseKakaoTxt,
    chunkMessages,
    detectRoomType,
    computeRoomKey,
    TXT_SOURCE,
    mapChunksToIngestRecords,
  };
}

const FIXTURE_TXT = `멱등테스트방 님과 카카오톡 대화
저장한 날짜 : 2026-07-05 12:00:00

--------------- 2026년 7월 1일 수요일 ---------------
[홍길동] [오전 9:00] 안녕하세요
[김철수] [오전 9:01] 네 확인했습니다
[이영희] [오전 9:02] 저도 확인했어요
`;

/** kakao-uploads route.ts의 commit 경로를 축약 재현한 헬퍼(테스트 전용). */
async function commitFixture(deps: Awaited<ReturnType<typeof loadDeps>>, rawText: string) {
  const parseResult = deps.parseKakaoTxt(rawText, "idempotency-fixture.txt");
  const roomKey = deps.computeRoomKey(parseResult.roomName);
  const roomType = deps.detectRoomType(parseResult.messages);
  const chunks = deps.chunkMessages(parseResult.messages, {
    roomKey,
    roomName: parseResult.roomName,
    roomType,
  });
  const ingestRecords = deps.mapChunksToIngestRecords(chunks);

  const prisma = deps.getPrisma();
  const sourceHashes = ingestRecords.map((r) => r.sourceHash);
  const existing = await prisma.workRecord.findMany({
    where: { source: deps.TXT_SOURCE, sourceHash: { in: sourceHashes } },
    select: { sourceHash: true },
  });
  const existingSet = new Set(existing.map((e: { sourceHash: string }) => e.sourceHash));

  let upserted = 0;
  let skipped = 0;
  for (const record of ingestRecords) {
    const wasExisting = existingSet.has(record.sourceHash);
    await deps.WorkRecordRepository.upsertByHash({
      source: deps.TXT_SOURCE,
      roomKey: record.roomKey,
      sender: record.sender,
      sentAt: new Date(record.sentAt),
      rawText: record.rawText,
      isMasked: record.isMasked,
      ingestedBy: "test-user",
    });
    if (wasExisting) skipped += 1;
    else upserted += 1;
  }

  await deps.ChatRoomMappingRepository.upsert({
    source: deps.TXT_SOURCE,
    roomKey,
    roomName: parseResult.roomName,
    roomType,
    collectorType: "TXT_UPLOAD",
  });

  return { upserted, skipped, roomKey };
}

describe("txt 업로드 commit — 멱등성 통합 테스트(실 SQLite)", () => {
  afterEach(async () => {
    vi.resetModules();
    process.env.DATABASE_URL = "file:./dev.db";
    const { getPrisma } = await import("@/lib/prisma");
    const prisma = getPrisma();
    await prisma.workRecord.deleteMany({ where: { source: "KAKAO_TXT", roomKey: { startsWith: "TXT:" } } });
    await prisma.chatRoomMapping.deleteMany({ where: { source: "KAKAO_TXT" } });
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    vi.resetModules();
    process.env.DATABASE_URL = "file:./dev.db";
    const { getPrisma } = await import("@/lib/prisma");
    const prisma = getPrisma();
    await prisma.workRecord.deleteMany({ where: { source: "KAKAO_TXT", roomKey: { startsWith: "TXT:" } } });
    await prisma.chatRoomMapping.deleteMany({ where: { source: "KAKAO_TXT" } });
  });

  it("동일 파일을 2회 커밋하면 2회차는 신규 0건, 전부 중복이다", async () => {
    const deps = await loadDeps();

    const first = await commitFixture(deps, FIXTURE_TXT);
    expect(first.upserted).toBeGreaterThan(0);
    expect(first.skipped).toBe(0);

    const deps2 = await loadDeps();
    const second = await commitFixture(deps2, FIXTURE_TXT);
    expect(second.upserted).toBe(0);
    expect(second.skipped).toBe(first.upserted);
    expect(second.roomKey).toBe(first.roomKey);
  });

  it("앞부분이 겹치는 잘린 파일을 재업로드하면 겹치는 구간은 중복 스킵된다", async () => {
    const deps = await loadDeps();
    const first = await commitFixture(deps, FIXTURE_TXT);
    expect(first.upserted).toBeGreaterThan(0);

    // 전체 파일에 새 메시지 1건이 시간 갭(GROUP 600s) 밖에서 추가된 "이어받기" 버전
    // (겹치는 앞부분 청크는 그대로 유지되고, 신규 메시지는 시간 갭 때문에 별도 청크로 분리된다 —
    // 이래야 겹치는 청크의 sourceHash가 변하지 않고 dedup이 성립한다. 갭 안에서 이어붙이면
    // 마지막 청크 텍스트가 자라나 sourceHash가 바뀌는 경계 드리프트가 발생한다(ingest-mapper 테스트의
    // "재빌드" 케이스와 동일 원리) — 그 경우는 허용된 리스크로 청사진에 문서화되어 있다.
    const extendedTxt = `${FIXTURE_TXT}[박민수] [오전 9:30] 추가 메시지입니다\n`;
    const deps2 = await loadDeps();
    const second = await commitFixture(deps2, extendedTxt);

    // 겹치는 기존 청크(들)는 스킵되고, 신규 청크만 추가로 upsert된다.
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.upserted).toBe(1);
  });
});
