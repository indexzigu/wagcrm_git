import { createHash } from "crypto";
import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import type { Prisma } from "@prisma/client";

// WorkRecord는 상태기계 없음(append-only). attributedBy(null→AUTO/MANUAL), isMasked 플래그만 관리한다.

// Json 이원화: Postgres는 객체 그대로, SQLite는 문자열 직렬화.
export function serializeJsonField(value: unknown): unknown {
  if (value === undefined || value === null) return value ?? null;
  return isSqliteDatabaseUrl() ? JSON.stringify(value) : value;
}

export function deserializeJsonField<T = unknown>(value: unknown): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value as T;
}

/**
 * 멱등키 계산: sha256(roomKey+sentAt+sender+rawText).
 * 순수 함수로 분리해 DB 없이 결정성(같은 입력 → 같은 해시)을 유닛테스트로 검증할 수 있게 한다.
 */
export function computeSourceHash(input: {
  roomKey?: string | null;
  sentAt: Date | string;
  sender?: string | null;
  rawText: string;
}): string {
  const sentAtIso =
    input.sentAt instanceof Date ? input.sentAt.toISOString() : new Date(input.sentAt).toISOString();
  const payload = `${input.roomKey ?? ""}|${sentAtIso}|${input.sender ?? ""}|${input.rawText}`;
  return createHash("sha256").update(payload).digest("hex");
}

export class WorkRecordRepository {
  static async upsertByHash(input: {
    source: string;
    roomKey?: string | null;
    sender?: string | null;
    sentAt: Date;
    rawText: string;
    summary?: string | null;
    actionItems?: unknown;
    isMasked?: boolean;
    entityType?: string | null;
    entityId?: string | null;
    campaignId?: string | null;
    attributedBy?: string | null;
    ingestedBy?: string | null;
  }) {
    const sourceHash = computeSourceHash({
      roomKey: input.roomKey,
      sentAt: input.sentAt,
      sender: input.sender,
      rawText: input.rawText,
    });

    const prisma = getPrisma();
    const actionItems = serializeJsonField(input.actionItems ?? null);

    return prisma.workRecord.upsert({
      where: { source_sourceHash: { source: input.source, sourceHash } },
      create: {
        source: input.source,
        sourceHash,
        roomKey: input.roomKey ?? null,
        sender: input.sender ?? null,
        sentAt: input.sentAt,
        rawText: input.rawText,
        summary: input.summary ?? null,
        actionItems: actionItems as Prisma.InputJsonValue | undefined,
        isMasked: input.isMasked ?? false,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        campaignId: input.campaignId ?? null,
        attributedBy: input.attributedBy ?? null,
        ingestedBy: input.ingestedBy ?? null,
      },
      update: {
        summary: input.summary ?? undefined,
        actionItems: actionItems as Prisma.InputJsonValue | undefined,
        isMasked: input.isMasked ?? undefined,
        entityType: input.entityType ?? undefined,
        entityId: input.entityId ?? undefined,
        campaignId: input.campaignId ?? undefined,
        attributedBy: input.attributedBy ?? undefined,
      },
    });
  }

  static async findByEntity(entityType: string, entityId: string) {
    return getPrisma().workRecord.findMany({
      where: { entityType, entityId },
      orderBy: { sentAt: "desc" },
    });
  }

  static async findByRoom(roomKey: string, since?: Date) {
    return getPrisma().workRecord.findMany({
      where: {
        roomKey,
        ...(since ? { sentAt: { gte: since } } : {}),
      },
      orderBy: { sentAt: "asc" },
    });
  }

  static async attribute(
    id: string,
    input: { entityType: string; entityId: string; attributedBy: "AUTO" | "MANUAL" }
  ) {
    return getPrisma().workRecord.update({
      where: { id },
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        attributedBy: input.attributedBy,
      },
    });
  }

  static async findMany<T extends Prisma.WorkRecordFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.WorkRecordFindManyArgs>
  ) {
    return getPrisma().workRecord.findMany(args);
  }

  /**
   * 방(roomKey) 단위 소급 귀속: 미매핑 상태로 업로드된 기존 레코드를 이후 등록된
   * ChatRoomMapping 기준으로 일괄 AUTO 귀속한다. Phase 4-2 §5(미매핑 방도 업로드 → 유실방지·소급귀속).
   *
   * source 필터(M2): 기본값 "KAKAO"이지만 명시적으로 받아 where에 포함시킨다 — roomKey는
   * source별로 별도 네임스페이스(ChatRoomMapping의 복합 유니크가 source+roomKey)이므로,
   * source 없이 roomKey만으로 업데이트하면 다른 source의 동일 roomKey 레코드까지 잘못 귀속될 수 있다.
   *
   * campaignId 해제 지원(M3): naverOrderSnapshotRepository의 cursorField 패턴과 동일하게
   * undefined(호출부가 넘기지 않음)면 필드 자체를 생략해 기존값을 보존하고, 명시적으로 null을
   * 넘긴 경우에만 실제로 null로 set한다. `campaignId ?? undefined`로 뭉개면 null 지정이
   * undefined로 변환되어 캠페인 해제가 불가능해진다.
   */
  static async attributeByRoom(
    roomKey: string,
    input: {
      entityType: "PARTNER" | "SELLER";
      entityId: string;
      campaignId?: string | null;
      source?: string;
    }
  ) {
    const source = input.source ?? "KAKAO";
    const campaignField = input.campaignId === undefined ? {} : { campaignId: input.campaignId };

    return getPrisma().workRecord.updateMany({
      where: { source, roomKey, entityType: null },
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        attributedBy: "AUTO",
        ...campaignField,
      },
    });
  }
}

export class ChatRoomMappingRepository {
  static async findByRoomKey(source: string, roomKey: string) {
    return getPrisma().chatRoomMapping.findUnique({
      where: { source_roomKey: { source, roomKey } },
    });
  }

  /**
   * entityType/entityId는 nullable로 완화되었다(Phase 4-5 — 미매핑 방도 업로드·등록 가능).
   * collectorType/roomType/campaignId/excluded는 undefined면 필드 자체를 생략해(=기존값 보존)
   * update 시 의도치 않게 초기화되지 않게 한다. campaignId는 null 지정(해제)과 undefined(보존)를
   * 구분해야 하므로 workRecordRepository.attributeByRoom의 campaignField 패턴을 그대로 따른다.
   */
  static async upsert(input: {
    source?: string;
    roomKey: string;
    roomName?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    roomType?: string | null;
    collectorType?: string;
    excluded?: boolean;
    campaignId?: string | null;
  }) {
    const source = input.source ?? "KAKAO";
    const campaignField = input.campaignId === undefined ? {} : { campaignId: input.campaignId };

    return getPrisma().chatRoomMapping.upsert({
      where: { source_roomKey: { source, roomKey: input.roomKey } },
      create: {
        source,
        roomKey: input.roomKey,
        roomName: input.roomName ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        roomType: input.roomType ?? null,
        collectorType: input.collectorType ?? "KATOK_AUTO",
        excluded: input.excluded ?? false,
        ...campaignField,
      },
      update: {
        // m7 리뷰 반영: entityType/entityId/roomType은 undefined면 필드 생략(기존값 보존),
        // 명시적 null이면 실제로 null로 set되어야 한다 — 이는 이미 `input.x`를 그대로 넘기는
        // 것과 동일하므로(x===undefined ? undefined : x는 x의 no-op) 평범한 passthrough로 둔다.
        // campaignId만 undefined/null 구분이 까다로워 위 campaignField 스프레드 패턴을 쓴다.
        roomName: input.roomName ?? undefined,
        entityType: input.entityType,
        entityId: input.entityId,
        roomType: input.roomType,
        collectorType: input.collectorType ?? undefined,
        excluded: input.excluded ?? undefined,
        ...campaignField,
      },
    });
  }

  /**
   * 카톡 폴더 → 화이트리스트 정합(설계: kakao_folder_autoregister_design_20260708).
   * "폴더 = 수집 스위치" 정책:
   *  - 폴더에 있는 방 → KATOK_AUTO·excluded=false·sourceFolderId 등록/갱신. entity/campaign 보존.
   *  - 이 폴더가 관리하던(sourceFolderId=folderId) 방인데 지금 폴더에 없음 → excluded=true(pause, 데이터 보존).
   *  - 수동 등록방(sourceFolderId=null)·다른 폴더 관리분은 불가침.
   *  - 이미 TXT_UPLOAD(직원 txt 수집)로 지정된 방은 존중해 건너뜀(자동 승격 금지).
   * 멱등: upsert + 집합 diff라 여러 번 돌려도 동일 결과.
   */
  static async reconcileFolderRooms(input: {
    source?: string;
    folderId: string;
    rooms: Array<{ roomKey: string; roomName?: string | null; roomType?: string | null }>;
  }) {
    const prisma = getPrisma();
    const source = input.source ?? "KAKAO";
    const desired = new Set(input.rooms.map((r) => r.roomKey));

    let added = 0;
    let resumed = 0;
    let unchanged = 0;
    let paused = 0;
    let skippedTxt = 0;

    for (const room of input.rooms) {
      const existing = await prisma.chatRoomMapping.findUnique({
        where: { source_roomKey: { source, roomKey: room.roomKey } },
        select: { collectorType: true, excluded: true },
      });

      // 수동 txt 수집 방은 존중(자동 승격 금지) — kakao-uploads 이중수집 정책과 정합.
      if (existing?.collectorType === "TXT_UPLOAD") {
        skippedTxt += 1;
        continue;
      }

      await prisma.chatRoomMapping.upsert({
        where: { source_roomKey: { source, roomKey: room.roomKey } },
        create: {
          source,
          roomKey: room.roomKey,
          roomName: room.roomName ?? null,
          roomType: room.roomType ?? null,
          collectorType: "KATOK_AUTO",
          excluded: false,
          sourceFolderId: input.folderId,
        },
        update: {
          // roomName/roomType는 값 있을 때만 갱신, entity/campaign은 미지정 → 보존.
          roomName: room.roomName ?? undefined,
          roomType: room.roomType ?? undefined,
          collectorType: "KATOK_AUTO",
          excluded: false,
          sourceFolderId: input.folderId,
        },
      });

      if (!existing) added += 1;
      else if (existing.excluded) resumed += 1;
      else unchanged += 1;
    }

    // 이 폴더 관리분 중 폴더에서 빠진 방 → pause(가역). 수동방/타폴더분은 where로 이미 배제.
    const managed = await prisma.chatRoomMapping.findMany({
      where: { source, sourceFolderId: input.folderId, excluded: false },
      select: { roomKey: true },
    });
    for (const m of managed) {
      if (desired.has(m.roomKey)) continue;
      await prisma.chatRoomMapping.update({
        where: { source_roomKey: { source, roomKey: m.roomKey } },
        data: { excluded: true },
      });
      paused += 1;
    }

    return { added, resumed, unchanged, paused, skippedTxt };
  }

  // 증분 동기화 커서 갱신
  static async touchSync(source: string, roomKey: string, lastSyncedAt: Date = new Date()) {
    return getPrisma().chatRoomMapping.update({
      where: { source_roomKey: { source, roomKey } },
      data: { lastSyncedAt },
    });
  }

  /**
   * 등록된 방 목록 + 커서(lastSyncedAt)를 반환한다.
   * GET /api/chat-room-mappings 및 러너의 화이트리스트 게이트(§5 — 34만 방 전부 금지)에 사용.
   * 러너 게이트(Phase 4-5): collectorType='KATOK_AUTO' AND excluded=false인 방만 반환한다 —
   * TXT_UPLOAD/EXCLUDED 방은 katok 러너(scripts/kakao-ingest.ts)가 스캔 대상으로 삼지 않아야
   * 하므로 여기서 필터링해 러너 코드 변경 없이 자동 게이트한다(default 'KATOK_AUTO'라 기존 행 무영향).
   */
  static async listWithCursors(source: string = "KAKAO") {
    return getPrisma().chatRoomMapping.findMany({
      where: { source, collectorType: "KATOK_AUTO", excluded: false },
      select: {
        roomKey: true,
        roomName: true,
        entityType: true,
        entityId: true,
        lastSyncedAt: true,
      },
      orderBy: { roomKey: "asc" },
    });
  }

  /**
   * 방 관리 UI용 통합 목록: source 무관 전체(KAKAO+KAKAO_TXT) ChatRoomMapping 반환.
   * GET /api/chat-room-mappings/manage에서 listUnmappedRooms 결과와 병합해 사용한다.
   */
  static async listAll() {
    return getPrisma().chatRoomMapping.findMany({
      orderBy: [{ source: "asc" }, { roomKey: "asc" }],
    });
  }

  /**
   * 미귀속(entityType/entityId 없이 업로드된) 방 목록: WorkRecord.roomKey 중 ChatRoomMapping이
   * 없는 방을 distinct로 집계한다. GET /api/chat-room-mappings/unmapped.
   */
  static async listUnmappedRooms(source: string = "KAKAO") {
    const prisma = getPrisma();
    const mapped = await prisma.chatRoomMapping.findMany({
      where: { source },
      select: { roomKey: true },
    });
    const mappedKeys = new Set(mapped.map((m) => m.roomKey));

    const rooms = await prisma.workRecord.findMany({
      where: { source, roomKey: { not: null } },
      select: { roomKey: true, sender: true, sentAt: true },
      orderBy: { sentAt: "desc" },
    });

    const seen = new Map<string, { roomKey: string; lastSeenAt: Date; messageCount: number }>();
    for (const row of rooms) {
      if (!row.roomKey || mappedKeys.has(row.roomKey)) continue;
      const existing = seen.get(row.roomKey);
      if (existing) {
        existing.messageCount += 1;
      } else {
        seen.set(row.roomKey, { roomKey: row.roomKey, lastSeenAt: row.sentAt, messageCount: 1 });
      }
    }

    return Array.from(seen.values());
  }
}
