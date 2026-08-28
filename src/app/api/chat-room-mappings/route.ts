import { NextResponse } from "next/server";
import { z } from "zod";
import { ChatRoomMappingRepository } from "@/repositories/workRecordRepository";
import { verifyIngestAuth } from "@/lib/kakao/ingest-auth";
import { ingestLaneGuard } from "@/lib/kakao/ingest-lane";

// GET: 등록된 방 + 커서(lastSyncedAt) 목록. 러너(scripts/kakao-ingest.ts)가 매 실행 시 조회해
// 화이트리스트 게이트(등록방만 스캔 — 34만 방 전부 금지, 청사진 §5)와 증분 시작점(since)에 사용한다.
// 방 목록/entityId 매핑도 PII 인접 정보라 work-records/ingest와 동일한 INGEST_TOKEN 인증을 요구한다(C1).
export async function GET(request: Request) {
  if (!verifyIngestAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 레인 게이트 — 러너가 선언한 상대가 이 배포가 아니면 아무것도 쓰지 않는다(SSOT
  // `@/lib/kakao/ingest-lane`, 실사고 2026-08-26 「은퇴 배포로 13일간 수집」).
  const lane = ingestLaneGuard(request);
  if (lane.rejection) return lane.rejection;

  const rooms = await ChatRoomMappingRepository.listWithCursors("KAKAO");
  return NextResponse.json({
    ...lane.envelope,
    rooms: rooms.map((room) => ({
      roomKey: room.roomKey,
      roomName: room.roomName,
      entityType: room.entityType,
      entityId: room.entityId,
      lastSyncedAt: room.lastSyncedAt,
    })),
  });
}

const registerMappingSchema = z.object({
  roomKey: z.string().min(1),
  roomName: z.string().nullable().optional(),
  entityType: z.enum(["PARTNER", "SELLER"]),
  entityId: z.string().min(1),
});

// POST: 방 등록/갱신(upsert). 정식 매핑 UI는 후속 — 현재는 API only.
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

  const parsed = registerMappingSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const mapping = await ChatRoomMappingRepository.upsert({
    source: "KAKAO",
    roomKey: parsed.data.roomKey,
    roomName: parsed.data.roomName ?? null,
    entityType: parsed.data.entityType,
    entityId: parsed.data.entityId,
  });

  return NextResponse.json({ ...lane.envelope, mapping });
}
