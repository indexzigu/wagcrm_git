/**
 * API 응답 직렬화 헬퍼 — SQLite/Postgres Json 필드 이원화 대응.
 *
 * priceSheetRepository.ts(Phase 1)의 serializeJsonField는 DB에 쓸 때 SQLite면 JSON.stringify,
 * Postgres면 그대로 두는 이원화를 하지만, 반대 방향(DB에서 읽어 API 응답으로 내보낼 때)의
 * 역직렬화는 어느 리포지토리도 호출하지 않는다 — Postgres는 원래 객체로 오니 문제없지만,
 * SQLite 로컬 개발환경에서는 flags/rawCells/columnMapping이 문자열 그대로 응답에 실려
 * 프론트가 JSON.parse 없이는 사용할 수 없다. 이 헬퍼로 API 라우트 응답 직전에만 역직렬화한다
 * (DB 스키마/리포지토리는 건드리지 않음 — Phase 1 소유 경로 보존).
 */
import { deserializeJsonField } from "@/repositories/priceSheetRepository";

export function normalizePriceSheetRowForResponse<
  T extends { flags?: unknown; rawCells?: unknown },
>(row: T): T {
  return {
    ...row,
    flags: deserializeJsonField(row.flags),
    rawCells: deserializeJsonField(row.rawCells) ?? {},
  };
}

export function normalizePriceSheetForResponse<
  T extends { columnMapping?: unknown; rows?: Array<{ flags?: unknown; rawCells?: unknown }> },
>(sheet: T): T {
  return {
    ...sheet,
    columnMapping: deserializeJsonField(sheet.columnMapping),
    ...(sheet.rows ? { rows: sheet.rows.map(normalizePriceSheetRowForResponse) } : {}),
  };
}
