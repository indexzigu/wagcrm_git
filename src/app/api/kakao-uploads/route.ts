import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { ChatRoomMappingRepository, WorkRecordRepository } from "@/repositories/workRecordRepository";
import { getPrisma } from "@/lib/prisma";
import { computeRoomKey, TXT_SOURCE } from "@/lib/kakao/room-key";
import { parseKakaoTxt } from "@/lib/kakao/txt-parser";
import { chunkMessages, detectRoomType } from "@/lib/kakao/txt-chunker";
import { mapChunksToIngestRecords } from "@/lib/kakao/ingest-mapper";
import { queueKakaoReferenceUrls } from "@/lib/kakao/queue-reference-urls";

// Vercel 서버리스 함수 본문 한도(4.5MB)를 감안해 파일당 4MB로 제한한다. 여러 파일은 클라이언트가
// 순차적으로 POST(파일당 한 요청)한다 — 청사진 §4 결정사항.
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;

const modeSchema = z.enum(["preview", "commit"]);

// m9 리뷰 반영: roomType은 detectRoomType(항상 DIRECT|GROUP만 반환) 또는 기존 매핑에 저장된 값에서
// 온다. 기존 매핑 값은 DB에 잘못된 값이 들어갈 가능성을 배제할 수 없으므로, 화이트리스트 검증 후
// 비정상 값은 GROUP으로 명시적으로 폴백한다(임의 `as` 캐스트로 타입만 맞추는 대신 런타임 검증).
const ROOM_TYPE_VALUES = new Set(["DIRECT", "GROUP", "OPEN"]);
type RoomTypeValue = "DIRECT" | "GROUP" | "OPEN";

function toRoomType(value: string | null | undefined): RoomTypeValue {
  if (value && ROOM_TYPE_VALUES.has(value)) {
    return value as RoomTypeValue;
  }
  return "GROUP";
}

type PreviewResponse = {
  roomName: string;
  roomKey: string;
  roomType: "DIRECT" | "GROUP" | "OPEN";
  messageCount: number;
  chunkCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  mapping: {
    entityType: string | null;
    entityId: string | null;
    campaignId: string | null;
    collectorType: string;
  } | null;
  warnings: string[];
};

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart form data" }, { status: 400 });
  }

  const file = formData.get("file");
  const modeRaw = formData.get("mode");
  const mappingEntityTypeRaw = formData.get("mappingEntityType");
  const mappingEntityIdRaw = formData.get("mappingEntityId");
  const mappingCampaignIdRaw = formData.get("mappingCampaignId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (!file.name.toLowerCase().endsWith(".txt")) {
    return NextResponse.json({ error: ".txt 파일만 업로드할 수 있습니다." }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      {
        error: `파일 크기가 4MB를 초과합니다 (${(file.size / 1024 / 1024).toFixed(1)}MB). 카톡에서 기간을 나눠 내보내기 해주세요.`,
      },
      { status: 400 }
    );
  }

  const modeParsed = modeSchema.safeParse(modeRaw);
  if (!modeParsed.success) {
    return NextResponse.json({ error: "mode는 preview 또는 commit이어야 합니다." }, { status: 400 });
  }
  const mode = modeParsed.data;

  // m9 리뷰 반영: 클라이언트가 보내는 mappingEntityType은 화이트리스트("PARTNER"|"SELLER")로만
  // 인정한다 — 그 외 값은 무시(null)해 이후 `as "PARTNER"|"SELLER"` 캐스트가 검증되지 않은 값을
  // 실어 나르지 않게 한다.
  const mappingEntityType =
    typeof mappingEntityTypeRaw === "string" &&
    (mappingEntityTypeRaw === "PARTNER" || mappingEntityTypeRaw === "SELLER")
      ? mappingEntityTypeRaw
      : null;
  const mappingEntityId = typeof mappingEntityIdRaw === "string" && mappingEntityIdRaw.length > 0
    ? mappingEntityIdRaw
    : null;
  const mappingCampaignId = typeof mappingCampaignIdRaw === "string" && mappingCampaignIdRaw.length > 0
    ? mappingCampaignIdRaw
    : null;

  const rawText = await file.text();
  const parseResult = parseKakaoTxt(rawText, file.name);
  const roomKey = computeRoomKey(parseResult.roomName);

  const existingMapping = await ChatRoomMappingRepository.findByRoomKey(TXT_SOURCE, roomKey);

  // KATOK_AUTO 방이면 이중 수집 차단(409) — 사장 Mac 자동 수집 담당 방.
  // roomKey 네임스페이스는 source별로 분리되어 있으므로(TXT_SOURCE vs "KAKAO"), collectorType
  // 충돌 검사는 TXT_SOURCE 네임스페이스에 이미 등록된 매핑 기준으로만 판단한다 — 즉 담당자가
  // 이 방을 이미 TXT_UPLOAD로 등록해 collectorType='KATOK_AUTO'로 표시해둔 경우를 막는다.
  if (existingMapping?.collectorType === "KATOK_AUTO") {
    return NextResponse.json(
      {
        error: `"${parseResult.roomName}" 방은 사장 Mac 자동 수집 담당 방입니다. 중복 수집을 막기 위해 txt 업로드가 차단됩니다.`,
        roomName: parseResult.roomName,
        roomKey,
      },
      { status: 409 }
    );
  }

  if (existingMapping?.excluded) {
    return NextResponse.json(
      {
        error: `"${parseResult.roomName}" 방은 수집 제외로 지정되어 있습니다.`,
        roomName: parseResult.roomName,
        roomKey,
      },
      { status: 409 }
    );
  }

  const roomType = existingMapping?.roomType
    ? toRoomType(existingMapping.roomType)
    : detectRoomType(parseResult.messages);
  const chunks = chunkMessages(parseResult.messages, {
    roomKey,
    roomName: parseResult.roomName,
    roomType,
  });

  const periodStart = parseResult.messages.length > 0
    ? parseResult.messages.reduce((min, m) => (m.sentAt < min ? m.sentAt : min), parseResult.messages[0].sentAt).toISOString()
    : null;
  const periodEnd = parseResult.messages.length > 0
    ? parseResult.messages.reduce((max, m) => (m.sentAt > max ? m.sentAt : max), parseResult.messages[0].sentAt).toISOString()
    : null;

  if (mode === "preview") {
    // DB 쓰기 없음, 원문 텍스트는 응답/로그에 절대 포함하지 않는다.
    const response: PreviewResponse = {
      roomName: parseResult.roomName,
      roomKey,
      roomType,
      messageCount: parseResult.messages.length,
      chunkCount: chunks.length,
      periodStart,
      periodEnd,
      mapping: existingMapping
        ? {
            entityType: existingMapping.entityType,
            entityId: existingMapping.entityId,
            campaignId: existingMapping.campaignId,
            collectorType: existingMapping.collectorType,
          }
        : null,
      warnings: parseResult.warnings,
    };
    return NextResponse.json(response);
  }

  // mode === "commit"
  const authContext = auth.context;
  const ingestRecords = mapChunksToIngestRecords(chunks);

  // 신규/중복 카운트를 정확히 산출하기 위해, upsert 이전에 이 배치의 sourceHash들이 이미
  // 존재하는지 findMany로 먼저 조회한다(upsertByHash 자체는 신규/갱신을 구분해 알려주지 않음).
  const sourceHashes = ingestRecords.map((r) => r.sourceHash);
  const existingRecords = sourceHashes.length
    ? await getPrisma().workRecord.findMany({
        where: { source: TXT_SOURCE, sourceHash: { in: sourceHashes } },
        select: { sourceHash: true },
      })
    : [];
  const existingHashSet = new Set(existingRecords.map((r) => r.sourceHash));

  const effectiveEntityType = mappingEntityType ?? existingMapping?.entityType ?? null;
  const effectiveEntityId = mappingEntityId ?? existingMapping?.entityId ?? null;
  const effectiveCampaignId = mappingCampaignId ?? existingMapping?.campaignId ?? null;

  let upserted = 0;
  let skipped = 0;
  const errors: { chunkId?: string; sentAt: string; reason: string }[] = [];

  // 레코드 upsert는 개별 진행 — 실패 건은 errors로 보고하고 나머지는 계속 처리한다(멱등 재시도로
  // 복구 가능, 청사진 §4 트랜잭션/부분 실패 결정).
  for (const record of ingestRecords) {
    try {
      const wasExisting = existingHashSet.has(record.sourceHash);
      const workRecord = await WorkRecordRepository.upsertByHash({
        source: TXT_SOURCE,
        roomKey: record.roomKey,
        sender: record.sender,
        sentAt: new Date(record.sentAt),
        rawText: record.rawText,
        isMasked: record.isMasked,
        entityType: effectiveEntityType,
        entityId: effectiveEntityId,
        campaignId: effectiveCampaignId,
        attributedBy: effectiveEntityType ? "AUTO" : null,
        ingestedBy: authContext.userId,
      });
      if (wasExisting) {
        skipped += 1;
      } else {
        upserted += 1;
        // R2b: 신규 WorkRecord에 대해서만 콘텐츠 URL을 미분류 인박스로 유입한다(중복 재스캔 방지).
        // 실패해도 카톡 인제스트 본류(위 upsert 성공)를 깨선 안 되므로 격리 — catch는 로깅만.
        try {
          await queueKakaoReferenceUrls(
            getPrisma(),
            workRecord.id,
            record.roomKey,
            record.rawText,
          );
        } catch (refErr) {
          console.error(
            `[POST /api/kakao-uploads] queueKakaoReferenceUrls failed (roomKey=${record.roomKey}, workRecordId=${workRecord.id}):`,
            refErr,
          );
        }
      }
    } catch (error) {
      // m6 리뷰 반영: Prisma 등 내부 예외 메시지를 클라이언트 응답에 그대로 노출하지 않는다.
      // 서버 로그에는 상세를 남기고, 응답에는 일반화된 사유만 담는다.
      console.error(
        `[POST /api/kakao-uploads] upsertByHash failed (roomKey=${record.roomKey}, sentAt=${record.sentAt}):`,
        error
      );
      errors.push({
        chunkId: record.chunkId,
        sentAt: record.sentAt,
        reason: "레코드 저장 중 오류가 발생했습니다. 같은 파일을 다시 업로드해 재시도할 수 있습니다.",
      });
    }
  }

  const isNewMapping = !existingMapping;

  await ChatRoomMappingRepository.upsert({
    source: TXT_SOURCE,
    roomKey,
    roomName: parseResult.roomName,
    entityType: effectiveEntityType,
    entityId: effectiveEntityId,
    campaignId: effectiveCampaignId,
    roomType,
    collectorType: "TXT_UPLOAD",
  });
  await ChatRoomMappingRepository.touchSync(TXT_SOURCE, roomKey, new Date());

  // 매핑이 새로 생기고 엔티티가 지정된 경우, 기존에 미귀속 상태로 업로드된 레코드를 소급 귀속한다.
  // m9 리뷰 반영: effectiveEntityType은 화이트리스트 검증된 mappingEntityType 또는 DB에 이미
  // 저장된 existingMapping.entityType에서만 오므로, 여기서도 다시 한 번 화이트리스트로 좁혀
  // 캐스트 없이 타입을 확정한다(방어적 이중 검증).
  if (
    isNewMapping &&
    effectiveEntityId &&
    (effectiveEntityType === "PARTNER" || effectiveEntityType === "SELLER")
  ) {
    await WorkRecordRepository.attributeByRoom(roomKey, {
      entityType: effectiveEntityType,
      entityId: effectiveEntityId,
      campaignId: effectiveCampaignId ?? undefined,
      source: TXT_SOURCE,
    });
  }

  return NextResponse.json({
    upserted,
    skipped,
    roomKey,
    roomName: parseResult.roomName,
    ...(errors.length > 0 ? { errors } : {}),
  });
}
