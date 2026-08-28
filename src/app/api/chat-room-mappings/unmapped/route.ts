import { NextResponse } from "next/server";
import { ChatRoomMappingRepository } from "@/repositories/workRecordRepository";
import { verifyIngestAuth } from "@/lib/kakao/ingest-auth";
import { ingestLaneGuard } from "@/lib/kakao/ingest-lane";

// GET: 업로드는 됐지만 아직 어떤 파트너/셀러에도 귀속되지 않은 방 목록.
// 미매핑 방도 업로드하는 정책(청사진 §5 — 유실 방지·소급 귀속)의 짝: 담당자가 이 목록을 보고
// POST /api/chat-room-mappings로 등록하면, 이후 WorkRecordRepository.attributeByRoom으로 소급 귀속한다.
// roomKey 자체가 카톡방 식별정보라 인증 없이 노출하지 않는다(C1).
export async function GET(request: Request) {
  if (!verifyIngestAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 레인 게이트 — 러너가 선언한 상대가 이 배포가 아니면 아무것도 쓰지 않는다(SSOT
  // `@/lib/kakao/ingest-lane`, 실사고 2026-08-26 「은퇴 배포로 13일간 수집」).
  const lane = ingestLaneGuard(request);
  if (lane.rejection) return lane.rejection;

  const rooms = await ChatRoomMappingRepository.listUnmappedRooms("KAKAO");
  return NextResponse.json({
    ...lane.envelope,
    rooms: rooms.map((room) => ({
      roomKey: room.roomKey,
      lastSeenAt: room.lastSeenAt,
      messageCount: room.messageCount,
    })),
  });
}
