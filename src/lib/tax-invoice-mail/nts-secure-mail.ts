/**
 * 국세청 홈택스 **보안메일 HTML** 봉투 파싱 + 복호화.
 *
 * ## 구조 (오너 제공 실물 샘플로 확정, 2026-08-04)
 *
 * ```
 * HTML
 * ├─ <input id="idCriHeader">          base64 → 바이트별 XOR 0x6b → 평문 헤더(key:value)
 * ├─ <input id="idCriPcContents">      본문(암호화)
 * └─ <input id="idCriAttachContents0"> 첨부(암호화) ← 표준 세금계산서 XML 이 여기 있다
 * ```
 *
 * - **헤더는 비밀번호 없이 읽힌다.** `AttachFileName`(`<승인번호>.xml`) · `AttachFileSize` ·
 *   `AttachFileTagID` · `HashKey` · `ContentEncryptionAlgorithm` 을 담는다.
 * - **복호화:** `key = MD5(비밀번호)` · **IV = 0으로 채운 16바이트** · 알고리즘은 헤더가 지정
 *   (1=AES, 2=SEED, 3=ARIA. 실측 샘플은 **2=SEED**).
 * - **비밀번호 = 공급받는자 사업자등록번호 10자리.** 헤더 `HintKey` 가 명시한다.
 * - **복호 결과는 base64 이고, 디코드해야 XML 이 나온다**(선언 크기 6703B → base64 8940자).
 *
 * ## 왜 SEED 만 직접 구현했나
 *
 * Node 기본 OpenSSL 에 SEED 가 없다(`seed-cipher.ts` 주석 참조). AES·ARIA 는 있으므로
 * 표준 `crypto` 를 쓴다 — 필요 없는 것까지 손으로 구현하지 않는다.
 */

import { createHash, createDecipheriv } from "crypto";
import { seedDecryptCbc } from "./seed-cipher";

/** 헤더의 `ContentEncryptionAlgorithm` 값. 참조 구현의 분기와 같다. */
export type NtsEncryptionAlgorithm = "AES" | "SEED" | "ARIA";

export interface NtsAttachmentSlot {
  /** 파일명. 표준 XML 이면 `<승인번호 24자리>.xml` 형태로 관측됐다. */
  filename: string | null;
  /** 암호문이 들어 있는 input 의 id */
  tagId: string;
  /** 헤더가 선언한 원본 바이트 크기(복호 후 base64 디코드 결과와 대조할 수 있다) */
  declaredSize: number | null;
}

export interface NtsSecureMailEnvelope {
  algorithm: NtsEncryptionAlgorithm;
  /** 비밀번호 검증용 암호문(복호하면 MD5 16진 문자열이 나와야 한다) */
  hashKey: string | null;
  /** 비밀번호 안내 문구 — 무엇을 넣어야 하는지가 여기 적혀 있다 */
  hintKey: string | null;
  attachments: NtsAttachmentSlot[];
  /** tagId → base64 암호문 */
  payloads: Record<string, string>;
}

/** 봉투인지 값싸게 판별한다(전체 파싱 전에 거르기 위해). */
export function isNtsSecureMailHtml(source: string): boolean {
  return source.includes('id="idCriHeader"');
}

function readInputValue(html: string, id: string): string | null {
  // id 와 value 의 순서가 뒤바뀐 마크업도 있을 수 있어 양방향을 본다.
  const forward = new RegExp(`id="${id}"[^>]*?value="([^"]*)"`).exec(html);
  if (forward) return forward[1];
  const backward = new RegExp(`value="([^"]*)"[^>]*?id="${id}"`).exec(html);
  return backward ? backward[1] : null;
}

/** 헤더는 base64 디코드 후 **각 바이트를 0x6b 로 XOR** 하면 평문이 된다. */
function decodeHeader(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  const plain = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < raw.length; i += 1) plain[i] = raw[i] ^ 0x6b;
  return plain.toString("utf8");
}

function resolveAlgorithm(raw: string | null): NtsEncryptionAlgorithm {
  switch ((raw ?? "").trim()) {
    case "1":
      return "AES";
    case "3":
      return "ARIA";
    // 2 = SEED. 미지정도 SEED 로 둔다 — 실측 샘플이 SEED 이고, 틀리면 패딩 검사에서
    // 즉시 던지므로 조용히 오해석되지 않는다.
    default:
      return "SEED";
  }
}

/**
 * 보안메일 HTML 을 파싱해 봉투를 만든다. 봉투가 아니면 null.
 * **비밀번호 없이** 여기까지는 읽힌다 — 그래서 첨부 목록·승인번호를 미리 알 수 있다.
 */
export function parseNtsSecureMailHtml(source: string): NtsSecureMailEnvelope | null {
  if (!isNtsSecureMailHtml(source)) return null;

  const encodedHeader = readInputValue(source, "idCriHeader");
  if (!encodedHeader) return null;

  const header = decodeHeader(encodedHeader);
  const values = new Map<string, string[]>();
  for (const line of header.split(/\r\n|\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    const bucket = values.get(key);
    if (bucket) bucket.push(value);
    else values.set(key, [value]);
  }
  const first = (key: string) => values.get(key)?.[0] ?? null;
  const all = (key: string) => values.get(key) ?? [];

  const tagIds = all("AttachFileTagID");
  const names = all("AttachFileName");
  const sizes = all("AttachFileSize");

  const attachments: NtsAttachmentSlot[] = tagIds.map((tagId, index) => ({
    tagId: tagId.trim(),
    filename: names[index]?.trim() ?? null,
    declaredSize: Number.isFinite(Number(sizes[index])) ? Number(sizes[index]) : null,
  }));

  const payloads: Record<string, string> = {};
  for (const slot of attachments) {
    const payload = readInputValue(source, slot.tagId);
    if (payload) payloads[slot.tagId] = payload;
  }
  const body = readInputValue(source, "idCriPcContents");
  if (body) payloads.idCriPcContents = body;

  return {
    algorithm: resolveAlgorithm(first("ContentEncryptionAlgorithm")),
    hashKey: first("HashKey"),
    hintKey: first("HintKey"),
    attachments,
    payloads,
  };
}

/** 비밀번호 → 대칭키. 참조 구현이 `MD5(비밀번호)` 를 그대로 키로 쓴다. */
export function deriveNtsKey(password: string): Buffer {
  return createHash("md5").update(password, "utf8").digest();
}

const ZERO_IV = Buffer.alloc(16);

function decryptPayload(
  base64: string,
  key: Buffer,
  algorithm: NtsEncryptionAlgorithm,
): Buffer {
  const ciphertext = Buffer.from(base64, "base64");
  if (algorithm === "SEED") {
    return Buffer.from(seedDecryptCbc(new Uint8Array(ciphertext), new Uint8Array(key)));
  }
  const cipherName = algorithm === "AES" ? "aes-128-cbc" : "aria-128-cbc";
  const decipher = createDecipheriv(cipherName, key, ZERO_IV);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 비밀번호가 맞는지 확인한다.
 *
 * 헤더의 `HashKey` 를 복호하면 **키의 16진 문자열**이 나와야 한다(참조 구현이
 * `CriKey.toString()` 과 비교한다). 이게 있어서 **복호를 시도하기 전에** 비밀번호를
 * 판별할 수 있고, 틀린 비밀번호로 얻은 쓰레기를 계산서로 오해석할 일이 없다.
 */
export function verifyNtsPassword(envelope: NtsSecureMailEnvelope, password: string): boolean {
  if (!envelope.hashKey) return false;
  const key = deriveNtsKey(password);
  try {
    const decrypted = decryptPayload(envelope.hashKey, key, envelope.algorithm);
    return decrypted.toString("utf8").trim() === key.toString("hex");
  } catch {
    // 패딩 오류 = 비밀번호 불일치. 예외를 "검증 실패"로 흡수하는 것이 이 함수의 계약이다.
    return false;
  }
}

export interface OpenedNtsAttachment {
  filename: string | null;
  /** 복호 + base64 디코드까지 끝난 원본 바이트 */
  content: Buffer;
  /** 헤더가 선언한 크기와 실제가 맞는가(불일치면 절단·손상 신호) */
  sizeMatches: boolean | null;
}

/**
 * 첨부를 복호해 원본 바이트로 돌려준다.
 *
 * 복호 결과가 **base64 문자열**이라 한 번 더 디코드한다 — 이 단계를 빠뜨리면 XML 파서가
 * 조용히 실패한다(실측: 6703B 파일이 8940자 base64 로 나왔다).
 *
 * 비밀번호가 틀리면 `verifyNtsPassword` 가 먼저 걸러내지만, 그걸 건너뛰고 불러도
 * 패딩 검사가 던지므로 쓰레기가 흘러나가지 않는다.
 */
export function openNtsAttachments(
  envelope: NtsSecureMailEnvelope,
  password: string,
): OpenedNtsAttachment[] {
  const key = deriveNtsKey(password);
  const opened: OpenedNtsAttachment[] = [];

  for (const slot of envelope.attachments) {
    const payload = envelope.payloads[slot.tagId];
    if (!payload) continue;
    const decrypted = decryptPayload(payload, key, envelope.algorithm);
    const content = Buffer.from(decrypted.toString("utf8").trim(), "base64");
    opened.push({
      filename: slot.filename,
      content,
      sizeMatches: slot.declaredSize === null ? null : content.length === slot.declaredSize,
    });
  }

  return opened;
}
