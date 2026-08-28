import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { ChatRoomMappingRepository, WorkRecordRepository } from "@/repositories/workRecordRepository";

// GET: 방 관리 UI용 통합 목록. ChatRoomMapping 전체(KAKAO+KAKAO_TXT) + 아직 매핑 레코드가 없는
// 미매핑 방(listUnmappedRooms, source별)을 병합해 반환한다. 세션 인증(웹 UI 전용 라우트 — 러너는
// Bearer INGEST_TOKEN을 쓰는 기존 /api/chat-room-mappings를 그대로 사용).
export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const [mappings, unmappedKakao, unmappedTxt] = await Promise.all([
    ChatRoomMappingRepository.listAll(),
    ChatRoomMappingRepository.listUnmappedRooms("KAKAO"),
    ChatRoomMappingRepository.listUnmappedRooms("KAKAO_TXT"),
  ]);

  const entityIds = {
    PARTNER: new Set<string>(),
    SELLER: new Set<string>(),
  };
  for (const m of mappings) {
    if (m.entityType === "PARTNER" && m.entityId) entityIds.PARTNER.add(m.entityId);
    if (m.entityType === "SELLER" && m.entityId) entityIds.SELLER.add(m.entityId);
  }

  const prisma = getPrisma();
  const [partners, sellers] = await Promise.all([
    entityIds.PARTNER.size > 0
      ? prisma.partner.findMany({
          where: { id: { in: Array.from(entityIds.PARTNER) } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    entityIds.SELLER.size > 0
      ? prisma.seller.findMany({
          where: { id: { in: Array.from(entityIds.SELLER) } },
          select: { id: true, name: true, alias: true },
        })
      : Promise.resolve([]),
  ]);
  const partnerNameById = new Map(partners.map((p) => [p.id, p.name]));
  const sellerNameById = new Map(sellers.map((s) => [s.id, s.alias || s.name]));

  const rooms = mappings.map((m) => ({
    id: m.id,
    source: m.source,
    roomKey: m.roomKey,
    roomName: m.roomName,
    roomType: m.roomType,
    collectorType: m.collectorType,
    excluded: m.excluded,
    entityType: m.entityType,
    entityId: m.entityId,
    entityName:
      m.entityType === "PARTNER"
        ? (partnerNameById.get(m.entityId ?? "") ?? null)
        : m.entityType === "SELLER"
          ? (sellerNameById.get(m.entityId ?? "") ?? null)
          : null,
    campaignId: m.campaignId,
    lastSyncedAt: m.lastSyncedAt,
    messageCount: null as number | null,
    mapped: true,
  }));

  const unmappedRows = [
    ...unmappedKakao.map((r) => ({ ...r, source: "KAKAO" as const })),
    ...unmappedTxt.map((r) => ({ ...r, source: "KAKAO_TXT" as const })),
  ].map((r) => ({
    id: null,
    source: r.source,
    roomKey: r.roomKey,
    roomName: null as string | null,
    roomType: null as string | null,
    collectorType: r.source === "KAKAO" ? "KATOK_AUTO" : "TXT_UPLOAD",
    excluded: false,
    entityType: null,
    entityId: null,
    entityName: null,
    campaignId: null,
    lastSyncedAt: r.lastSeenAt,
    messageCount: r.messageCount,
    mapped: false,
  }));

  return NextResponse.json({ rooms: [...rooms, ...unmappedRows] });
}

const patchSchema = z.object({
  source: z.enum(["KAKAO", "KAKAO_TXT"]),
  roomKey: z.string().min(1),
  roomName: z.string().nullable().optional(),
  entityType: z.enum(["PARTNER", "SELLER"]).nullable().optional(),
  entityId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
  collectorType: z.enum(["KATOK_AUTO", "TXT_UPLOAD", "EXCLUDED"]).optional(),
  excluded: z.boolean().optional(),
  roomType: z.enum(["DIRECT", "GROUP", "OPEN"]).nullable().optional(),
});

// PATCH: 방 매핑/담당/제외 상태 갱신. 매핑(entityType+entityId)이 새로 지정되면 기존 미귀속
// WorkRecord를 소급 귀속한다(attributeByRoom).
export async function PATCH(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { source, roomKey, roomName, entityType, entityId, campaignId, collectorType, excluded, roomType } =
    parsed.data;

  // m6 리뷰 반영: DB 예외의 내부 메시지(Prisma 에러 문자열 등)를 그대로 클라이언트에 노출하지
  // 않는다 — 서버 로그에는 상세를 남기되 응답은 일반화된 메시지로 대체한다.
  try {
    const mapping = await ChatRoomMappingRepository.upsert({
      source,
      roomKey,
      roomName: roomName ?? undefined,
      entityType,
      entityId,
      campaignId,
      collectorType,
      excluded,
      roomType,
    });

    if (entityType && entityId) {
      await WorkRecordRepository.attributeByRoom(roomKey, {
        entityType,
        entityId,
        campaignId: campaignId ?? undefined,
        source,
      });
    }

    return NextResponse.json({ mapping });
  } catch (error) {
    console.error("[PATCH /api/chat-room-mappings/manage] Error:", error);
    return NextResponse.json({ error: "방 매핑 저장 중 오류가 발생했습니다." }, { status: 500 });
  }
}
