import crypto from "crypto";

/**
 * 셀러 주민등록번호 암·복호화 (AES-256-GCM).
 *
 * 2026-07-23 이전에는 `ENCRYPTION_KEY` 부재 시 **소스에 박힌 기본 키**로 폴백했다.
 * 레포가 공개돼 있어 그 기본 키는 곧 공개된 키였고, 프로덕션에 변수가 등록돼 있지
 * 않아 실제로 그 키가 쓰이고 있었다. 폴백을 제거하고 fail-closed 로 바꾼다.
 *
 * ⚠️ 키를 바꾸려면 **기존 행 재암호화가 선행돼야 한다.** 그래서 복호화는 전환
 * 기간 동안 `ENCRYPTION_KEY_PREVIOUS`(구 키)도 시도한다:
 *   1. 새 키를 `ENCRYPTION_KEY`, 구 키를 `ENCRYPTION_KEY_PREVIOUS` 로 등록·배포
 *   2. `scripts/reencrypt-resident-numbers.ts --apply` 로 전 행을 새 키로 재암호화
 *   3. `ENCRYPTION_KEY_PREVIOUS` 제거
 * 이 순서를 지키면 무중단으로 전환된다.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM 권장 12바이트

/**
 * 구 구현과 **바이트 단위로 동일한** 파생 규칙을 유지한다 — `padEnd(32)`는 공백으로
 * 채운다. 이걸 바꾸면 기존 행이 열리지 않으므로 재암호화 전에는 절대 손대지 말 것.
 */
function deriveKey(secret: string): Buffer {
  return Buffer.from(secret.padEnd(32).slice(0, 32));
}

function currentSecret(): string {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error("ENCRYPTION_KEY 환경 변수가 누락되었습니다.");
  return secret;
}

/** 복호화 시도 순서: 현재 키 → 구 키(전환 기간에만 설정). */
function decryptionSecrets(): string[] {
  const secrets = [currentSecret()];
  const previous = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (previous && previous !== secrets[0]) secrets.push(previous);
  return secrets;
}

/** 저장 형식 `iv:authTag:ciphertext` 인지. 아니면 암호문이 아니다(평문 등). */
export function isEncrypted(text: string): boolean {
  return text.split(":").length === 3;
}

export function encrypt(text: string): string {
  if (!text) return "";

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(currentSecret()), iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`;
}

function decryptWith(secret: string, ivHex: string, tagHex: string, dataHex: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

export function decrypt(text: string): string {
  if (!text) return "";

  // 암호문 형식이 아니면 암호화된 적 없는 값이다 — 그대로 돌려준다(기존 동작 유지).
  if (!isEncrypted(text)) return text;

  const [ivHex, authTagHex, encryptedHex] = text.split(":");
  for (const secret of decryptionSecrets()) {
    try {
      return decryptWith(secret, ivHex, authTagHex, encryptedHex);
    } catch {
      // 다음 키로 시도
    }
  }

  // ⚠️ 구 구현은 여기서 **원문(=암호문)을 그대로 반환**했다. 그래서 키가 어긋나면
  // 주민번호 자리에 암호문이 조용히 표시되고 아무도 눈치채지 못했다. 삼키지 않는다.
  throw new Error(
    "주민등록번호 복호화 실패: ENCRYPTION_KEY 가 이 값을 암호화한 키와 다릅니다. " +
      "전환 중이라면 ENCRYPTION_KEY_PREVIOUS 를 설정하고 재암호화 스크립트를 실행하세요.",
  );
}

/**
 * 감사용 판독 등급 — **값을 돌려주지 않고** "이 값이 어느 키로 열리는가"만 답한다.
 *
 * 왜 별도 함수인가(2026-08-13 실사고):
 * - `decrypt()` 는 현재 키 → 구 키를 **차례로** 시도하므로 "현재 키로 열리는가"를
 *   구분해 물을 수 없다. 전환이 안 끝난 행(구 키로만 열림)이 정상으로 보인다.
 * - `decryptOrNull()` 은 성공하면 **평문을 반환**한다. 전 행을 훑는 감사기가 그걸
 *   받으면 주민등록번호 평문이 감사 경로 메모리·응답·로그에 흘러들 위험이 생긴다.
 *   이 함수는 복호화 결과를 즉시 버리고 등급만 남긴다.
 * - 파생 규칙(`padEnd(32)`)·키 사다리를 감사기가 다시 구현하면 어긋난다
 *   (`scripts/reencrypt-resident-numbers.ts` 가 이미 사본을 들고 있는 그 함정).
 */
export type ResidentNumberDecryptability =
  /** 값이 없다(감사 대상 아님). */
  | "empty"
  /** 암호문 형식이 아니다 = 암호화된 적 없는 평문. 복호화 실패가 아니다. */
  | "plaintext"
  /** 현재 `ENCRYPTION_KEY` 로 열린다 = 정상. */
  | "current"
  /** 현재 키로는 안 열리고 `ENCRYPTION_KEY_PREVIOUS` 로만 열린다 = 재암호화 미완. */
  | "previous"
  /** 어느 키로도 안 열린다 = 키가 데이터와 어긋났다(2026-08-13 사고의 상태). */
  | "unreadable";

export function classifyDecryptability(
  text: string | null | undefined,
): ResidentNumberDecryptability {
  if (!text) return "empty";
  if (!isEncrypted(text)) return "plaintext";

  const [ivHex, authTagHex, encryptedHex] = text.split(":");

  // ⚠️ `currentSecret()` 을 쓰지 않는다 — 키 미설정은 감사기가 "감사 불능"으로 따로
  // 판정할 사안이고, 여기서 던지면 전 행이 예외로 중단된다.
  const current = process.env.ENCRYPTION_KEY;
  if (current) {
    try {
      decryptWith(current, ivHex, authTagHex, encryptedHex);
      return "current";
    } catch {
      // 현재 키로는 안 열린다 — 구 키를 시도한다.
    }
  }

  const previous = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (previous && previous !== current) {
    try {
      decryptWith(previous, ivHex, authTagHex, encryptedHex);
      return "previous";
    } catch {
      // 구 키로도 안 열린다.
    }
  }

  return "unreadable";
}

/**
 * 대량 조회 경로용 — 복호화 실패 시 던지지 않고 `null` 을 돌려준다.
 *
 * 왜 나눠 놓는가: 캠페인 행 목록·대시보드처럼 **여러 행을 한꺼번에 읽는 경로**는
 * 프리렌더에서도 돌기 때문에, 행 하나가 안 열린다고 페이지와 빌드를 통째로 죽이면
 * 피해가 원인보다 커진다(이 레포는 빌드가 실 DB를 읽는다).
 *
 * ⚠️ **가르는 축은 "한 건이냐 여러 건이냐"가 아니다** (2026-08-12 실사고로 정정).
 * 종전 서술은 "편집 화면처럼 그 한 건이 목적인 경로는 `decrypt()` 로 크게 터뜨린다"
 * 였는데, 그 문장을 문자 그대로 따르면 **이미 끝난 일을 장식하는 자리에서도 던지게**
 * 된다. 실제로 `PATCH /api/sellers/[id]` 가 그랬다 — 저장은 커밋된 뒤 응답을 만들다
 * 던져서 500 이 됐고, 열리지 않는 값을 가진 셀러는 *다른 필드조차* 고칠 수 없었다.
 * 진짜 축은 **복호화가 그 요청의 목적인가**다:
 *   - 목적이다(값을 보여주려고 읽는다) → 실패가 곧 사고. 다만 화면 표면은 전부 대량
 *     경로라 현재 이쪽 호출부는 없다.
 *   - 목적이 아니다(감사 로그 비교·응답 직렬화처럼 **부가 작업**) → 던지지 않는다.
 *     부가 기능이 주 기능을 죽여서는 안 된다. 선례 두 곳:
 *     `resident-number-audit.ts`(#382) · `api/sellers/[id]/route.ts` 응답 직렬화.
 * 그래서 지금 `decrypt()` 의 throw 를 그대로 흘리는 호출부는 **하나도 없다** — 키가
 * 데이터와 어긋난 상태의 탐지는 예외가 아니라 `encryption-key-audit` 크론(#381)이
 * 맡는다. 새 호출부를 만들 때 이 분업을 되돌리지 말 것.
 *
 * `null` 은 "값 없음"으로 표시될 뿐 **암호문이 화면에 새지 않는다** — 구 동작과
 * 다르다. 그리고 조용하지 않다: 실패는 경고로 남긴다(값은 남기지 않는다).
 */
export function decryptOrNull(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    return decrypt(text);
  } catch (error) {
    console.warn(
      "[encryption] 주민등록번호 복호화 실패 — 해당 값을 비워 반환합니다.",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
