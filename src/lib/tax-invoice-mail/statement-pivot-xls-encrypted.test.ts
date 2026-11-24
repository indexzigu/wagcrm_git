/**
 * 암호(열기 암호) 걸린 정산 첨부(.xls) — 합성 파일만 쓴다(실물 첨부·실제 비밀번호를 커밋하지 않는다. 테스트 비밀번호는 가짜).
 * 고정하는 것: ① RC4 두 방식(옛 RC4 · CryptoAPI 128/40비트)으로 건 암호를 비밀번호로 풀어 피벗을 읽는다
 * ② 비밀번호가 없거나 틀리면 ATTACHMENT_UNREADABLE ③ 발주서 시트(가짜 구매자 정보)는 **풀지 않는다** ④ 1024바이트 블록
 * 재키를 넘는 위치도 맞다 ⑤ 모르는 방식·모자란 길이는 null.
 *
 * ⚠️ 이 파일의 암호화 쪽(`encryptStream`)은 명세를 따로 옮겨 쓴 것이라 구현과 같은 오해를 공유할 수 있다 — 실물 파일 대조는
 * 오너가 받은 실제 첨부로 한 번 한다(PR 본문이 아니라 소스 주석: 실물 대조 전에는 「미확인」).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { decryptBiffRange, findFilePass, openBiffCipher, parseFilePass } from "./biff-rc4";
import { readStatementAttachmentPasswords } from "./statement-passwords";
import { decryptPivotStream, readStatementPivot } from "./statement-pivot-xls";

const PASSWORD = "pw-for-tests-1";
const FAKE_PII = ["테스트구매자", "010-0000-0000", "가상시 가상로 1"] as const;
const EXPECTED = [
  { label: "구성: 3박스", qty: 4 },
  { label: "구성: 6박스", qty: 2 },
];

const PIVOT_GRID: unknown[][] = [
  ["정산 피벗"],
  [],
  ["옵션명", "합계 : 수량", "합계 : 총판매가"],
  ["구성: 3박스", 4, 120000],
  ["구성: 6박스", 2, 120000],
  ["총합계", 6, 240000],
];

function plainWorkbookStream(): Buffer {
  const wb = XLSX.utils.book_new();
  // 시트 앞쪽을 길게 채워 피벗이 1024바이트 블록 경계를 넘긴 자리에 놓이게 한다(재키 확인).
  const filler = Array.from({ length: 150 }, (_, i) => [`정산내역 ${i}`, i * 1000]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["정산내역서"], ...filler]), "정산내역서");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(PIVOT_GRID), "피벗");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["주문일", "구매자", "연락처", "주소"],
      ["2026-10-01", FAKE_PII[0], FAKE_PII[1], FAKE_PII[2]],
    ]),
    "발주서",
  );
  const content = XLSX.write(wb, { bookType: "biff8", type: "buffer" }) as Buffer;
  const entry = XLSX.CFB.find(XLSX.CFB.read(content, { type: "buffer" }), "/Workbook");
  return Buffer.from(entry!.content as Uint8Array);
}

function cfbWith(workbook: Buffer): Buffer {
  const container = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(container, "Workbook", workbook);
  return Buffer.from(XLSX.CFB.write(container, { type: "buffer" }) as Uint8Array);
}

// ---- 테스트용 암호화(명세를 따로 옮겨 씀) ----
const md5 = (data: Buffer) => createHash("md5").update(data).digest();
const sha1 = (data: Buffer) => createHash("sha1").update(data).digest();
const le32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n += 1) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) % 256];
  }
  return out;
}

type Scheme = { kind: "rc4" } | { kind: "cryptoapi"; bits: number };

function keyFor(scheme: Scheme, password: string, salt: Buffer, block: number): Buffer {
  const pw = Buffer.from(password, "utf16le");
  if (scheme.kind === "rc4") {
    const h0 = md5(pw).subarray(0, 5);
    const h1 = md5(Buffer.concat(Array(16).fill(Buffer.concat([h0, salt])) as Buffer[])).subarray(0, 5);
    return md5(Buffer.concat([h1, le32(block)]));
  }
  const hFinal = sha1(Buffer.concat([sha1(Buffer.concat([salt, pw])), le32(block)]));
  return scheme.bits === 40 ? Buffer.concat([hFinal.subarray(0, 5), Buffer.alloc(11)]) : hFinal.subarray(0, scheme.bits / 8);
}

function filePassPayload(scheme: Scheme, password: string, salt: Buffer): Buffer {
  const verifier = Buffer.from("0123456789abcdef");
  const hashFn = scheme.kind === "rc4" ? md5 : sha1;
  const encrypted = rc4(keyFor(scheme, password, salt, 0), Buffer.concat([verifier, hashFn(verifier)]));
  if (scheme.kind === "rc4") {
    return Buffer.concat([Buffer.from([1, 0, 1, 0, 1, 0]), salt, encrypted]);
  }
  const csp = Buffer.from("Microsoft Enhanced Cryptographic Provider v1.0\0", "utf16le");
  const header = Buffer.concat([le32(0x24), le32(0), le32(0x6801), le32(0x8004), le32(scheme.bits), le32(1), le32(0), le32(0), csp]);
  return Buffer.concat([
    Buffer.from([1, 0, 4, 0, 2, 0]),
    le32(0x24),
    le32(header.length),
    header,
    le32(16),
    salt,
    encrypted.subarray(0, 16),
    le32(20),
    encrypted.subarray(16),
  ]);
}

const NEVER = new Set([0x0809, 0x002f, 0x0194, 0x0195, 0x00e1, 0x0196, 0x0138]);

function encryptStream(plain: Buffer, scheme: Scheme, password: string): Buffer {
  const salt = Buffer.from("saltsaltsaltsalt");
  const payload = filePassPayload(scheme, password, salt);
  const record = Buffer.concat([Buffer.from([0x2f, 0x00]), Buffer.from([payload.length & 0xff, payload.length >> 8]), payload]);
  const bofEnd = 4 + plain.readUInt16LE(2);
  const stream = Buffer.concat([plain.subarray(0, bofEnd), record, plain.subarray(bofEnd)]);
  // FILEPASS 가 끼어 뒤 위치가 밀렸다 — 모든 BoundSheet8 의 시트 위치를 그만큼 민다.
  for (let offset = 0; offset + 4 <= stream.length; ) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    if (type === 0x0085) stream.writeUInt32LE(stream.readUInt32LE(offset + 4) + record.length, offset + 4);
    offset += 4 + length;
  }
  const mask = new Uint8Array(stream.length);
  for (let offset = 0; offset + 4 <= stream.length; ) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    if (!NEVER.has(type)) mask.fill(1, offset + (type === 0x0085 ? 8 : 4), offset + 4 + length);
    offset += 4 + length;
  }
  const out = Buffer.from(stream);
  for (let block = 0; block * 1024 < stream.length; block += 1) {
    const start = block * 1024;
    const end = Math.min(start + 1024, stream.length);
    const keystream = rc4(keyFor(scheme, password, salt, block), Buffer.alloc(end - start));
    for (let p = start; p < end; p += 1) if (mask[p]) out[p] ^= keystream[p - start];
  }
  return out;
}

const SCHEMES: Array<[string, Scheme]> = [
  ["옛 RC4(1.1)", { kind: "rc4" }],
  ["RC4 CryptoAPI 128비트", { kind: "cryptoapi", bits: 128 }],
  ["RC4 CryptoAPI 40비트", { kind: "cryptoapi", bits: 40 }],
];

describe("암호 걸린 정산 첨부(.xls) 읽기", () => {
  it("테스트용 RC4 가 공개 표준 시험값과 맞는다(키 Key · 평문 Plaintext)", () => {
    expect(rc4(Buffer.from("Key"), Buffer.from("Plaintext")).toString("hex")).toBe("bbf316e8d940af0ad3");
  });

  it("합성 스트림이 1024바이트 블록을 여러 개 넘는다(양성 대조 — 재키 위치를 실제로 건드린다)", () => {
    expect(plainWorkbookStream().length).toBeGreaterThan(4096);
  });

  it.each(SCHEMES)("%s — 비밀번호로 풀어 피벗을 읽는다", (_name, scheme) => {
    const encrypted = cfbWith(encryptStream(plainWorkbookStream(), scheme, PASSWORD));
    const result = readStatementPivot(encrypted, { passwords: [PASSWORD] });
    expect(result).toEqual({ ok: true, rows: EXPECTED });
    expect(JSON.stringify(result)).not.toContain(FAKE_PII[0]);
  });

  it("여러 후보 중 두 번째가 맞아도 푼다(틀린 후보는 검증값으로 걸러진다)", () => {
    const encrypted = cfbWith(encryptStream(plainWorkbookStream(), { kind: "rc4" }, PASSWORD));
    expect(readStatementPivot(encrypted, { passwords: ["wrong-one", PASSWORD] })).toEqual({ ok: true, rows: EXPECTED });
  });

  it.each(SCHEMES)("%s — 비밀번호가 없거나 틀리면 ATTACHMENT_UNREADABLE", (_name, scheme) => {
    const encrypted = cfbWith(encryptStream(plainWorkbookStream(), scheme, PASSWORD));
    expect(readStatementPivot(encrypted)).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
    expect(readStatementPivot(encrypted, { passwords: [] })).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
    expect(readStatementPivot(encrypted, { passwords: ["wrong-one"] })).toEqual({ ok: false, code: "ATTACHMENT_UNREADABLE" });
  });

  it("암호가 없는 파일은 비밀번호가 주어져도 그대로 읽는다", () => {
    const plain = cfbWith(plainWorkbookStream());
    expect(readStatementPivot(plain, { passwords: [PASSWORD] })).toEqual({ ok: true, rows: EXPECTED });
  });

  it("전역 + 피벗만 풀고 발주서 시트(구매자 정보)는 암호문으로 남는다", () => {
    const plain = plainWorkbookStream();
    const encrypted = encryptStream(plain, { kind: "rc4" }, PASSWORD);
    const containsPii = (buffer: Buffer) =>
      FAKE_PII.some((pii) => buffer.includes(Buffer.from(pii, "utf16le")) || buffer.includes(Buffer.from(pii, "latin1")));
    // 양성 대조: 전부 풀면 가짜 구매자 글자가 보이고(= 합성 파일에 정말 들어 있고), 암호문 상태에서는 안 보인다.
    const everything = Buffer.from(encrypted);
    const info = parseFilePass(findFilePass(encrypted)!.payload)!;
    expect(decryptBiffRange(everything, openBiffCipher(info, [PASSWORD])!, 0, everything.length)).toBe(true);
    expect(containsPii(everything)).toBe(true);
    expect(containsPii(encrypted)).toBe(false);

    const partial = decryptPivotStream(encrypted, findFilePass(encrypted)!, [PASSWORD]);
    expect(containsPii(partial.stream)).toBe(false);
    expect(partial.names).toEqual(["정산내역서", "피벗", "발주서"]);
    // FILEPASS 는 무력화돼 다시 암호로 읽히지 않는다.
    expect(findFilePass(partial.stream)).toBeNull();
  });
});

describe("parseFilePass · openBiffCipher", () => {
  const salt = Buffer.from("saltsaltsaltsalt");

  it("옛 RC4 · CryptoAPI 를 가려 읽는다", () => {
    expect(parseFilePass(filePassPayload({ kind: "rc4" }, PASSWORD, salt))?.scheme).toBe("rc4");
    const api = parseFilePass(filePassPayload({ kind: "cryptoapi", bits: 128 }, PASSWORD, salt));
    expect(api).toMatchObject({ scheme: "cryptoapi", keyBits: 128 });
  });

  it("XOR(종류 0)·모르는 버전·모자란 길이·모르는 알고리즘은 null", () => {
    expect(parseFilePass(Buffer.from([0, 0, 1, 0, 1, 0]))).toBeNull();
    expect(parseFilePass(Buffer.from([1, 0, 9, 0, 9, 0, 0, 0]))).toBeNull();
    expect(parseFilePass(Buffer.from([1, 0, 1, 0, 1, 0, 1, 2, 3]))).toBeNull();
    expect(parseFilePass(filePassPayload({ kind: "rc4" }, PASSWORD, salt).subarray(0, 40))).toBeNull();
    const aes = filePassPayload({ kind: "cryptoapi", bits: 128 }, PASSWORD, salt);
    aes.writeUInt32LE(0x660e, 14 + 8); // algId = AES-128 → 지원하지 않는다
    expect(parseFilePass(aes)).toBeNull();
  });

  it("후보가 없거나 너무 길면 열지 않는다", () => {
    const info = parseFilePass(filePassPayload({ kind: "rc4" }, PASSWORD, salt))!;
    expect(openBiffCipher(info, [])).toBeNull();
    expect(openBiffCipher(info, ["", "x".repeat(300)])).toBeNull();
    expect(openBiffCipher(info, [PASSWORD])).not.toBeNull();
  });
});

describe("readStatementAttachmentPasswords", () => {
  it("값이 없으면 빈 목록", () => {
    expect(readStatementAttachmentPasswords({})).toEqual([]);
    expect(readStatementAttachmentPasswords({ STATEMENT_ATTACHMENT_PASSWORDS: "   " })).toEqual([]);
  });

  it("글자 하나면 그대로(앞뒤 공백 제거) · JSON 배열이면 여럿 · 중복·빈 값·문자열 아님은 버린다", () => {
    expect(readStatementAttachmentPasswords({ STATEMENT_ATTACHMENT_PASSWORDS: "  one-pw " })).toEqual(["one-pw"]);
    expect(readStatementAttachmentPasswords({ STATEMENT_ATTACHMENT_PASSWORDS: '["a1", " b2 ", "a1", "", 3]' })).toEqual(["a1", "b2"]);
  });

  it("깨진 JSON 은 빈 목록(예외·값 노출 없음)", () => {
    expect(readStatementAttachmentPasswords({ STATEMENT_ATTACHMENT_PASSWORDS: '["a1", ' })).toEqual([]);
  });
});
