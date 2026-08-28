import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ChatRoomMappingRepository,
  WorkRecordRepository,
  computeSourceHash,
} from "@/repositories/workRecordRepository";
import { verifyIngestAuth } from "@/lib/kakao/ingest-auth";
import { ingestLaneGuard } from "@/lib/kakao/ingest-lane";
import { getPrisma } from "@/lib/prisma";
import { queueKakaoReferenceUrls } from "@/lib/kakao/queue-reference-urls";

const ingestRecordSchema = z.object({
  roomKey: z.string().min(1),
  sender: z.string().nullable().optional(),
  // RFC3339 datetime, 오프셋 허용(카톡 원본이 +00:00 형식으로 옴).
  sentAt: z.string().datetime({ offset: true }),
  rawText: z.string(),
  isMasked: z.boolean().optional().default(false),
  sourceHash: z.string().min(1),
  chunkId: z.string().optional(),
});

const ingestBodySchema = z.object({
  source: z.literal("KAKAO"),
  records: z.array(ingestRecordSchema).min(1).max(200),
});

type IngestError = { chunkId?: string; roomKey: string; sentAt: string; reason: string };

export async function POST(request: Request) {
  if (!verifyIngestAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 레인 게이트 — 러너가 선언한 상대가 이 배포가 아니면 아무것도 쓰지 않는다(SSOT
  // `@/lib/kakao/ingest-lane`, 실사고 2026-08-26 「은퇴 배포로 13일간 수집」).
  const lane = ingestLaneGuard(request);
  if (lane.rejection) return lane.rejection;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ingestBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { records } = parsed.data;

  let upserted = 0;
  // upsertByHash는 항상 upsert하므로 "skipped"는 현재 항상 0이다(계약 유지를 위해 응답 필드는 남긴다).
  const skipped = 0;
  let failed = 0;
  const errors: IngestError[] = [];
  const roomCursors: Record<string, string> = {};
  // 방별로 실패 레코드가 1건이라도 있으면 그 방의 커서는 전진시키지 않는다(m1 — 부분 실패 시
  // 커서 미전진). 이유: 커서를 성공분 max(sentAt)로만 전진시키면, 실패한 레코드가 커서보다
  // 앞선 시각이더라도 다음 실행에서 since=커서로 재조회되지 않아 영구 유실될 수 있다.
  // 방 전체를 미전진 상태로 두면 다음 실행에서 같은 범위를 재조회하게 되고, sourceHash 기반
  // upsert가 멱등이라 이미 성공한 레코드의 재업로드는 무해하다.
  const failedRooms = new Set<string>();

  // 방별 매핑을 미리 조회해 귀속(entityType/entityId/attributedBy=AUTO)에 사용한다.
  // 미매핑 방은 null로 업로드(유실 방지·소급 귀속 — 청사진 §5).
  const roomKeys = Array.from(new Set(records.map((r) => r.roomKey)));
  const mappings = await Promise.all(
    roomKeys.map((roomKey) => ChatRoomMappingRepository.findByRoomKey("KAKAO", roomKey))
  );
  const mappingByRoom = new Map(roomKeys.map((roomKey, i) => [roomKey, mappings[i]]));

  for (const record of records) {
    try {
      // 서버 sourceHash 재검증: 불일치 시 서버값을 신뢰하고 경고로 기록한다(§5 정합 리스크).
      // 주의: 클라이언트가 보낸 sourceHash는 저장에 사용되지 않는다 — upsertByHash가 서버에서
      // 항상 재계산한 해시로 upsert한다. 이 블록은 순수히 러너-서버 버전 정합 감시용(불일치가
      // 계속 발생하면 두 쪽의 computeSourceHash 로직이 어긋났다는 신호)이며, 불일치가 저장
      // 결과에 영향을 주지는 않는다.
      const recomputedHash = computeSourceHash({
        roomKey: record.roomKey,
        sentAt: record.sentAt,
        sender: record.sender ?? null,
        rawText: record.rawText,
      });

      if (recomputedHash !== record.sourceHash) {
        errors.push({
          chunkId: record.chunkId,
          roomKey: record.roomKey,
          sentAt: record.sentAt,
          reason: `sourceHash mismatch: client=${record.sourceHash} server=${recomputedHash} (server value used)`,
        });
      }

      const mapping = mappingByRoom.get(record.roomKey);

      const workRecord = await WorkRecordRepository.upsertByHash({
        source: "KAKAO",
        roomKey: record.roomKey,
        sender: record.sender ?? null,
        sentAt: new Date(record.sentAt),
        rawText: record.rawText,
        isMasked: record.isMasked,
        entityType: mapping?.entityType ?? null,
        entityId: mapping?.entityId ?? null,
        attributedBy: mapping ? "AUTO" : null,
      });

      upserted += 1;

      // R2b: 청크의 콘텐츠 URL을 미분류 인박스로 유입한다(부가기능). 실패해도 카톡 인제스트
      // 본류(위 upsert 성공)를 깨선 안 되므로 격리 — catch는 로깅만 하고 계속 진행한다(빈 catch 금지).
      try {
        await queueKakaoReferenceUrls(
          getPrisma(),
          workRecord.id,
          record.roomKey,
          record.rawText,
        );
      } catch (refErr) {
        console.error(
          `[work-records/ingest] queueKakaoReferenceUrls failed (roomKey=${record.roomKey}, workRecordId=${workRecord.id}):`,
          refErr,
        );
      }

      const currentMax = roomCursors[record.roomKey];
      if (!currentMax || new Date(record.sentAt) > new Date(currentMax)) {
        roomCursors[record.roomKey] = record.sentAt;
      }
    } catch (error) {
      failed += 1;
      failedRooms.add(record.roomKey);
      errors.push({
        chunkId: record.chunkId,
        roomKey: record.roomKey,
        sentAt: record.sentAt,
        reason: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // 성공적으로 업로드된 레코드의 방별 max(sentAt)로 ChatRoomMapping.lastSyncedAt을 전진시킨다.
  // 서버 커서가 진실(청사진 §6) — 매핑이 없는(미등록) 방은 touchSync 대상이 아니다(등록 시점부터 커서 시작).
  // m1: 방에 실패 레코드가 1건이라도 있으면 그 방은 전진 대상에서 제외한다(위 failedRooms 주석 근거).
  await Promise.all(
    Object.entries(roomCursors).map(async ([roomKey, maxSentAt]) => {
      if (!mappingByRoom.get(roomKey)) return;
      if (failedRooms.has(roomKey)) return;
      try {
        await ChatRoomMappingRepository.touchSync("KAKAO", roomKey, new Date(maxSentAt));
      } catch (error) {
        console.error(`[work-records/ingest] touchSync failed for room ${roomKey}:`, error);
      }
    })
  );

  // 응답 roomCursors는 실제로 커서가 전진된(=touchSync된) 방만 포함한다. 실패 레코드가 있던 방을
  // 여기 포함시키면 러너가 "그 방도 전진했다"고 오인할 수 있다(m1과 응답 계약 일치).
  const advancedRoomCursors = Object.fromEntries(
    Object.entries(roomCursors).filter(
      ([roomKey]) => mappingByRoom.get(roomKey) && !failedRooms.has(roomKey)
    )
  );

  return NextResponse.json({
    ...lane.envelope,
    upserted,
    skipped,
    failed,
    roomCursors: advancedRoomCursors,
    ...(errors.length > 0 ? { errors } : {}),
  });
}
