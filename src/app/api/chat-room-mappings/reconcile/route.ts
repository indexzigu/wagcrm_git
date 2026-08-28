import { NextResponse } from "next/server";
import { z } from "zod";
import { ChatRoomMappingRepository } from "@/repositories/workRecordRepository";
import { verifyIngestAuth } from "@/lib/kakao/ingest-auth";
import { ingestLaneGuard } from "@/lib/kakao/ingest-lane";

// POST: 카톡 폴더 → 화이트리스트 정합(설계: kakao_folder_autoregister_design_20260708).
// 러너(scripts/kakao-reconcile.ts)가 `katok source folders --json`에서 대상 폴더(공구)를 추출해
// 이 라우트로 POST한다. "폴더 = 수집 스위치" 정책은 reconcileFolderRooms가 수행:
// 폴더 방=등록/수집 ON, 폴더에서 빠진 관리분=pause, 수동방(sourceFolderId=null)=불가침.
// roomKey/roomName/roomType은 PII 인접 정보라 work-records/ingest와 동일한 INGEST_TOKEN 인증(C1).
const roomSchema = z.object({
  roomKey: z.string().min(1),
  roomName: z.string().nullable().optional(),
  roomType: z.string().nullable().optional(),
});

const reconcileSchema = z.object({
  source: z.string().optional(),
  folderId: z.string().min(1),
  folderName: z.string().optional(),
  rooms: z.array(roomSchema),
});

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

  const parsed = reconcileSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await ChatRoomMappingRepository.reconcileFolderRooms({
    source: parsed.data.source,
    folderId: parsed.data.folderId,
    rooms: parsed.data.rooms,
  });

  return NextResponse.json({ ...lane.envelope, folder: parsed.data.folderName ?? null, result });
}
