import { parseChannelUrl } from "@/lib/channel-url";
import type { SnsType } from "@/lib/validations/seller";

/**
 * 발굴 셀러 대량 등록 — 입력 파서 (클라이언트 프리뷰 ↔ 서버 생성 공유 SSOT)
 *
 * 운영 맥락: 인스타 탐색 중 수집한 후보 계정 링크/핸들을 한 번에 붙여넣어
 * 다건 등록하는 유입 경로. 입력은 URL 또는 @핸들을 줄/공백/쉼표로 구분한 자유 텍스트.
 * 나머지 지표(팔로워·bio·프로필)는 등록 후 백그라운드 채널 스크래핑이 보강한다.
 */

/** 한 번에 처리할 최대 항목 수 (서버리스 타임아웃·드라이브 폴더 생성 팬아웃 방어). */
export const BULK_SELLER_MAX = 100;

export type BulkEntryStatus = "ok" | "duplicate" | "invalid";

export interface ParsedBulkEntry {
  /** 사용자가 입력한 원본 토큰 (프리뷰/에러 표시용). */
  raw: string;
  snsType?: SnsType;
  snsHandle?: string;
  channelUrl?: string;
  status: BulkEntryStatus;
  /** duplicate/invalid 사유 (한국어). */
  reason?: string;
}

const URL_HOST_RE =
  /(instagram\.com|youtube\.com|youtu\.be|x\.com|twitter\.com)/i;
// IG/YouTube/X 핸들 안전 문자 집합. 길이 30자 상한(IG 기준).
const BARE_HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;

function looksLikeUrl(token: string): boolean {
  return /^https?:\/\//i.test(token) || URL_HOST_RE.test(token);
}

function normalizeUrl(token: string): string {
  return /^https?:\/\//i.test(token) ? token : `https://${token}`;
}

function channelUrlFor(snsType: SnsType, handle: string): string {
  switch (snsType) {
    case "INSTAGRAM":
      return `https://www.instagram.com/${handle}`;
    case "YOUTUBE":
      return handle.startsWith("UC")
        ? `https://www.youtube.com/channel/${handle}`
        : `https://www.youtube.com/@${handle}`;
    case "X":
      return `https://x.com/${handle}`;
  }
}

/** 단일 토큰 → 확정 엔트리 (in-batch 중복 판정 전 단계). */
function resolveToken(token: string): ParsedBulkEntry {
  if (looksLikeUrl(token)) {
    const parsed = parseChannelUrl(normalizeUrl(token));
    if (!parsed) {
      return {
        raw: token,
        status: "invalid",
        reason: "지원하지 않는 URL 형식",
      };
    }
    return {
      raw: token,
      snsType: parsed.snsType,
      snsHandle: parsed.snsHandle,
      channelUrl: channelUrlFor(parsed.snsType, parsed.snsHandle),
      status: "ok",
    };
  }

  // 스킴/도메인이 없는 순수 토큰 → 핸들로 간주. 발굴은 IG 중심이므로 기본 INSTAGRAM.
  const handle = token.replace(/^@/, "").trim();
  if (!BARE_HANDLE_RE.test(handle)) {
    return {
      raw: token,
      status: "invalid",
      reason: "URL 또는 핸들 형식이 아님",
    };
  }
  return {
    raw: token,
    snsType: "INSTAGRAM",
    snsHandle: handle,
    channelUrl: channelUrlFor("INSTAGRAM", handle),
    status: "ok",
  };
}

/**
 * 자유 텍스트를 줄/공백/쉼표로 토큰화하여 대량 등록 엔트리 배열로 변환한다.
 * - 순서 보존.
 * - 입력 내 (snsType, snsHandle) 중복은 첫 항목만 ok, 이후는 "duplicate"로 마킹.
 * - 정합성 판단만 하며 실제 DB 존재 여부(기존 셀러 중복)는 서버 생성 단계에서 판정.
 */
export function parseBulkSellerLines(raw: string): ParsedBulkEntry[] {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const seen = new Set<string>();
  const entries: ParsedBulkEntry[] = [];

  for (const token of tokens) {
    const entry = resolveToken(token);
    if (entry.status === "ok" && entry.snsType && entry.snsHandle) {
      const key = `${entry.snsType}:${entry.snsHandle.toLowerCase()}`;
      if (seen.has(key)) {
        entries.push({ ...entry, status: "duplicate", reason: "입력 내 중복" });
        continue;
      }
      seen.add(key);
    }
    entries.push(entry);
  }

  return entries;
}
