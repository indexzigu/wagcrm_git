// 셀러 전용 주소 포털의 인증 — 비밀번호 해시(bcrypt)와 세션 쿠키(HMAC 서명).
// Node 전용(crypto·bcrypt) — proxy(edge)에서는 import 금지. 경로 판정은 portal-slug.ts.
//
// 보안 모델: slug가 공개(계정명 기반·열거 가능)이므로 비밀은 비밀번호뿐이다.
//  - 저장: bcrypt 해시만(평문은 발급 응답에 1회 노출 후 어디에도 없음).
//  - 세션: HMAC-SHA256 서명 쿠키 {sellerId, 만료, 비밀번호 버전}. 비밀번호를 재발급하면
//    pv(해시 지문)가 바뀌어 기존 세션이 전부 무효화된다.
//  - 무차별 대입: 실패 카운트를 DB(Seller)에 둬 서버리스에서도 잠금이 유지된다.
import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import bcrypt from "bcrypt";

export const PORTAL_SESSION_COOKIE = "wag_portal";
export const PORTAL_SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30일
export const PORTAL_MAX_FAILS = 8; // 연속 실패 허용 횟수
export const PORTAL_LOCK_MINUTES = 15; // 초과 시 잠금 시간

const BCRYPT_ROUNDS = 10;

export async function hashPortalPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPortalPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// 헷갈리는 글자(0/O, 1/l/I) 제외 32자 알파벳 — 카톡으로 불러줘도 오타가 안 나게.
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 셀러에게 전달할 포털 비밀번호 생성(10자, ~49bit). 잠금 정책과 조합해 무차별 대입 방어. */
export function generatePortalPassword(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

/**
 * 세션 서명 비밀키 — PORTAL_SESSION_SECRET 이 있으면 그 값, 없으면
 * SUPABASE_SERVICE_ROLE_KEY 에서 파생(라벨 고정 HMAC). 파생 방식이라 별도 env 없이 동작하며,
 * service key 로테이션 시 포털 세션이 일괄 만료된다(허용 가능한 트레이드오프).
 */
function sessionSecret(): Buffer {
  const explicit = process.env.PORTAL_SESSION_SECRET;
  if (explicit && explicit.length >= 16) return Buffer.from(explicit);
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) {
    throw new Error(
      "포털 세션 서명 키 없음: PORTAL_SESSION_SECRET 또는 SUPABASE_SERVICE_ROLE_KEY env가 필요합니다",
    );
  }
  return createHmac("sha256", base).update("wag-portal-session-v1").digest();
}

/** 비밀번호 해시 지문 — 쿠키에 넣어 비밀번호 재발급 시 기존 세션을 무효화한다. */
function passwordVersion(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

type SessionPayload = { sid: string; exp: number; pv: string };

function sign(data: string): string {
  return createHmac("sha256", sessionSecret()).update(data).digest("base64url");
}

/** 성공 로그인 후 쿠키 값 생성 */
export function createPortalSessionValue(
  sellerId: string,
  passwordHash: string,
  now = Date.now(),
): string {
  const payload: SessionPayload = {
    sid: sellerId,
    exp: Math.floor(now / 1000) + PORTAL_SESSION_MAX_AGE_SEC,
    pv: passwordVersion(passwordHash),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data)}`;
}

/**
 * 쿠키 값 검증 — 서명·만료·셀러 일치·비밀번호 버전까지 모두 통과해야 true.
 * 실패 사유는 구분하지 않는다(전부 "미인증"으로 게이트 재표시).
 */
export function verifyPortalSessionValue(
  value: string | undefined,
  sellerId: string,
  passwordHash: string | null,
  now = Date.now(),
): boolean {
  if (!value || !passwordHash) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const data = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(data);
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) return false;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString());
  } catch {
    return false;
  }
  if (payload.sid !== sellerId) return false;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now) return false;
  if (payload.pv !== passwordVersion(passwordHash)) return false;
  return true;
}
