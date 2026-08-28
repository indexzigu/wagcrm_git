import { createHash } from "crypto";

/**
 * TXT_UPLOAD 방 식별키 합성 (Phase 4-5).
 *
 * katok 자동 수집(ChunkRow.chatId, source="KAKAO")은 카톡 내부 chat_id를 그대로 roomKey로 쓰지만,
 * txt 내보내기는 그런 안정적 내부 ID가 없다 — 파일 헤더/구분선에서 추출한 "방 이름" 문자열만
 * 근거로 삼을 수 있다. 따라서 방 이름을 정규화한 뒤 해시해 결정적 키를 만든다.
 *
 * source 네임스페이스 분리: TXT_UPLOAD 방은 'KAKAO_TXT' 네임스페이스를 사용한다(katok 자동 수집은
 * 'KAKAO'). ChatRoomMapping.@@unique([source, roomKey])가 source별로 별도 네임스페이스이므로,
 * 같은 방이 katok과 txt 양쪽에서 수집되더라도 roomKey 문자열이 우연히 같아도 절대 충돌하지
 * 않는다. 대신 "같은 물리적 카톡방"을 두 source에서 자동으로 같은 레코드로 합쳐주는 교차 dedup은
 * Non-goal이다(청사진 승인 사항) — collectorType으로 방 단위 이중 수집만 사람이 수동으로 차단한다.
 */

export const TXT_SOURCE = "KAKAO_TXT";
const ROOM_KEY_PREFIX = "TXT:";
const HASH_LENGTH = 16;

/** NFC 정규화 + 앞뒤 공백 제거 + 연속 공백을 1개로 축약 — 같은 방이 공백/유니코드 표현 차이로 다른 키를 받지 않게 한다. */
export function normalizeRoomName(roomName: string): string {
  return roomName.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** `TXT:` + sha256(정규화된 방 이름)의 앞 16자. 결정적 — 같은 방 이름 입력은 항상 같은 키를 낸다. */
export function computeRoomKey(roomName: string): string {
  const normalized = normalizeRoomName(roomName);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, HASH_LENGTH);
  return `${ROOM_KEY_PREFIX}${hash}`;
}
