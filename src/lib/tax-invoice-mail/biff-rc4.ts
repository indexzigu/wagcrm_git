/**
 * 암호(열기 암호)가 걸린 .xls(BIFF8)의 RC4 복호 — 순수 모듈. 정산 메일 첨부를 브랜드가 암호를 걸어 보낼 때 쓴다.
 *
 * 지원하는 것: FILEPASS 레코드의 **RC4 두 방식** — 옛 RC4(버전 1.1, MD5 키)와 RC4 CryptoAPI(버전 2~4.2, SHA-1 키).
 * 지원하지 않는 것: XOR 난독화(옛 방식) · 그 밖의 버전 · 다른 알고리즘 — 모두 「못 읽음」(null)이다.
 * ⚠️ xlsx 라이브러리(0.18.5 CE)는 XOR 만 풀고 RC4 는 「Encryption scheme unsupported」로 멈춘다(2026-11-24 소스 실측) —
 * 그래서 직접 푼다. 알고리즘은 MS-OFFCRYPTO(RC4 · RC4 CryptoAPI) 명세를 따른다.
 *
 * ## 스트림 규칙(키 스트림은 **스트림 위치**로 정해진다)
 *  - Workbook 스트림을 1024바이트 블록으로 나눠 블록 k 마다 키(블록 번호 k)로 RC4 를 처음부터 다시 시작한다.
 *  - 레코드 머리(종류 2 + 길이 2)는 암호화되지 않지만 위치는 센다. 아래 레코드는 내용도 암호화되지 않는다(위치는
 *    센다): BOF · FILEPASS · UsrExcl · FileLock · InterfaceHdr · RRDInfo · RRDHead. BoundSheet8 은 앞 4바이트(시트
 *    위치)가 암호화되지 않는다.
 *  - 그래서 레코드 머리만 읽어 구간을 고를 수 있고, **필요한 구간(전역 + 피벗 시트)만** 풀 수 있다 — 구매자 정보가
 *    든 발주서 시트는 풀지 않는다(statement-pivot-xls.ts 머리 주석).
 *
 * ## ⛔ 비밀번호는 호출부가 환경변수에서 읽어 인자로 넘긴다
 * 이 모듈은 비밀번호를 저장·출력하지 않는다. 검증값(verifier)으로 맞는지 확인하므로 후보를 여럿 넘겨도 틀린 것은
 * 걸러진다. 예외 문구에 어떤 값도 싣지 않는다 — 실패는 null 이다.
 */
import { createHash } from "node:crypto";

export const RT_BOF = 0x0809;
export const RT_EOF = 0x000a;
export const RT_BOUNDSHEET8 = 0x0085;
export const RT_FILEPASS = 0x002f;

/** 내용이 암호화되지 않는 레코드(위치는 센다). */
const NEVER_ENCRYPTED = new Set<number>([RT_BOF, RT_FILEPASS, 0x0194 /* UsrExcl */, 0x0195 /* FileLock */, 0x00e1 /* InterfaceHdr */, 0x0196 /* RRDInfo */, 0x0138 /* RRDHead */]);

const BLOCK_SIZE = 1024;
/** 후보 비밀번호 상한(개수·글자 수) — 환경변수 읽기(statement-passwords.ts)도 같은 값을 쓴다. */
export const MAX_PASSWORD_CHARS = 255;
export const MAX_PASSWORDS = 8;

export type FilePassInfo = {
  scheme: "rc4" | "cryptoapi";
  /** CryptoAPI 키 길이(비트). 옛 RC4 는 128 고정. */
  keyBits: number;
  salt: Buffer;
  encryptedVerifier: Buffer;
  encryptedVerifierHash: Buffer;
};

/** 풀린 키 스트림으로 스트림 위치 구간을 제자리 XOR 한다. */
export type BiffCipher = { xorRange: (buffer: Buffer, start: number, end: number) => void };

/** RC4 키 스트림 앞 `length` 바이트(KSA + PRGA). */
function rc4Keystream(key: Buffer, length: number): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  const out = Buffer.alloc(length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < length; n += 1) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    const t = s[a];
    s[a] = s[b];
    s[b] = t;
    out[n] = s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

const md5 = (data: Buffer) => createHash("md5").update(data).digest();
const sha1 = (data: Buffer) => createHash("sha1").update(data).digest();
const u32le = (value: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
};

/** 옛 RC4(버전 1.1)의 블록 키 — 항상 16바이트. */
function rc4BlockKey(password: string, salt: Buffer, block: number): Buffer {
  const truncated = md5(Buffer.from(password, "utf16le")).subarray(0, 5);
  const intermediate = md5(Buffer.concat(Array.from({ length: 16 }, () => Buffer.concat([truncated, salt]))));
  return md5(Buffer.concat([intermediate.subarray(0, 5), u32le(block)]));
}

/** RC4 CryptoAPI 의 블록 키 — 40비트는 5바이트 + 0 11바이트(16바이트), 그 밖은 keyBits/8 바이트. */
function cryptoApiBlockKey(password: string, salt: Buffer, keyBits: number, block: number): Buffer {
  const h0 = sha1(Buffer.concat([salt, Buffer.from(password, "utf16le")]));
  const final = sha1(Buffer.concat([h0, u32le(block)]));
  return keyBits === 40 ? Buffer.concat([final.subarray(0, 5), Buffer.alloc(11)]) : final.subarray(0, keyBits / 8);
}

function blockKey(info: FilePassInfo, password: string, block: number): Buffer {
  return info.scheme === "rc4" ? rc4BlockKey(password, info.salt, block) : cryptoApiBlockKey(password, info.salt, info.keyBits, block);
}

/**
 * FILEPASS 레코드의 내용(머리 4바이트 제외) → 방식·검증값. 모르는 방식·모자란 길이는 null.
 * wEncryptionType 0(XOR)은 지원하지 않는다.
 */
export function parseFilePass(payload: Buffer): FilePassInfo | null {
  if (payload.length < 6 || payload.readUInt16LE(0) !== 1) return null;
  const major = payload.readUInt16LE(2);
  const minor = payload.readUInt16LE(4);
  if (major === 1 && minor === 1) {
    if (payload.length < 6 + 48) return null;
    return {
      scheme: "rc4",
      keyBits: 128,
      salt: Buffer.from(payload.subarray(6, 22)),
      encryptedVerifier: Buffer.from(payload.subarray(22, 38)),
      encryptedVerifierHash: Buffer.from(payload.subarray(38, 54)),
    };
  }
  if ((major === 2 || major === 3 || major === 4) && minor === 2) {
    // 버전 뒤: flags(4) · headerSize(4) · 헤더 · 검증자(saltSize 4 · salt 16 · verifier 16 · hashSize 4 · hash 20).
    if (payload.length < 6 + 8) return null;
    const headerSize = payload.readUInt32LE(10);
    const headerStart = 14;
    // 헤더 고정부: flags · sizeExtra · algId · algIdHash · keySize · providerType · reserved1 · reserved2 (각 4바이트).
    if (headerSize < 32 || headerStart + headerSize > payload.length) return null;
    const algId = payload.readUInt32LE(headerStart + 8);
    const algIdHash = payload.readUInt32LE(headerStart + 12);
    const declaredBits = payload.readUInt32LE(headerStart + 16);
    // RC4(0x6801 또는 0) · SHA-1(0x8004 또는 0) 만. 키 길이 0 은 40비트(명세).
    if ((algId !== 0 && algId !== 0x6801) || (algIdHash !== 0 && algIdHash !== 0x8004)) return null;
    const keyBits = declaredBits === 0 ? 40 : declaredBits;
    if (keyBits < 40 || keyBits > 128 || keyBits % 8 !== 0) return null;
    const verifierStart = headerStart + headerSize;
    if (verifierStart + 4 + 16 + 16 + 4 + 20 > payload.length) return null;
    if (payload.readUInt32LE(verifierStart) !== 16 || payload.readUInt32LE(verifierStart + 36) !== 20) return null;
    return {
      scheme: "cryptoapi",
      keyBits,
      salt: Buffer.from(payload.subarray(verifierStart + 4, verifierStart + 20)),
      encryptedVerifier: Buffer.from(payload.subarray(verifierStart + 20, verifierStart + 36)),
      encryptedVerifierHash: Buffer.from(payload.subarray(verifierStart + 40, verifierStart + 60)),
    };
  }
  return null;
}

/** 블록 0 키로 검증값을 풀어 해시와 맞는지 본다(옛 RC4 는 MD5 16바이트, CryptoAPI 는 SHA-1 20바이트). */
function passwordMatches(info: FilePassInfo, password: string): boolean {
  const key = blockKey(info, password, 0);
  const stream = rc4Keystream(key, 16 + info.encryptedVerifierHash.length);
  const verifier = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) verifier[i] = info.encryptedVerifier[i] ^ stream[i];
  const hash = Buffer.alloc(info.encryptedVerifierHash.length);
  for (let i = 0; i < hash.length; i += 1) hash[i] = info.encryptedVerifierHash[i] ^ stream[16 + i];
  const expected = info.scheme === "rc4" ? md5(verifier) : sha1(verifier);
  return expected.length === hash.length && expected.equals(hash);
}

/** 후보 비밀번호 중 검증값이 맞는 첫 번째로 복호기를 연다. 하나도 안 맞으면 null. */
export function openBiffCipher(info: FilePassInfo, passwords: readonly string[]): BiffCipher | null {
  const candidates = passwords.filter((p) => p.length > 0 && p.length <= MAX_PASSWORD_CHARS).slice(0, MAX_PASSWORDS);
  const password = candidates.find((candidate) => passwordMatches(info, candidate));
  if (password === undefined) return null;
  const keystreams = new Map<number, Buffer>();
  const stream = (block: number) => {
    let cached = keystreams.get(block);
    if (!cached) {
      cached = rc4Keystream(blockKey(info, password, block), BLOCK_SIZE);
      keystreams.set(block, cached);
    }
    return cached;
  };
  return {
    xorRange(buffer, start, end) {
      for (let position = start; position < end; position += 1) {
        buffer[position] ^= stream(Math.floor(position / BLOCK_SIZE))[position % BLOCK_SIZE];
      }
    },
  };
}

/** 스트림 맨 앞 구간(전역)에서 FILEPASS 레코드를 찾는다 — 없으면 null(암호 없음). 레코드 머리만 읽는다. */
export function findFilePass(stream: Buffer): { offset: number; payload: Buffer } | null {
  let offset = 0;
  let depth = 0;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const next = offset + 4 + length;
    if (next > stream.length) return null;
    if (type === RT_BOF) depth += 1;
    if (type === RT_FILEPASS) return { offset, payload: Buffer.from(stream.subarray(offset + 4, next)) };
    if (type === RT_EOF) {
      depth -= 1;
      if (depth <= 0) return null;
    }
    offset = next;
  }
  return null;
}

/**
 * `[start, end)` (레코드 경계) 안의 레코드 내용을 제자리에서 푼다. 머리·암호화되지 않는 레코드·BoundSheet8 의 앞 4바이트는
 * 건드리지 않는다. 구간이 레코드 경계에서 벗어나면 false(아무것도 풀지 않은 채가 아니라 일부만 풀렸을 수 있으니
 * 호출부는 결과를 버린다).
 */
export function decryptBiffRange(stream: Buffer, cipher: BiffCipher, start: number, end: number): boolean {
  let offset = start;
  while (offset < end) {
    if (offset + 4 > stream.length) return false;
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const next = offset + 4 + length;
    if (next > end || next > stream.length) return false;
    if (!NEVER_ENCRYPTED.has(type)) {
      const payloadStart = type === RT_BOUNDSHEET8 ? offset + 8 : offset + 4;
      if (payloadStart < next) cipher.xorRange(stream, payloadStart, next);
    }
    offset = next;
  }
  return offset === end;
}
