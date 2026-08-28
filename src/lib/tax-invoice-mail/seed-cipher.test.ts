import { describe, it, expect } from "vitest";
import { seedEncryptBlock, seedDecryptBlock, seedDecryptCbc } from "./seed-cipher";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

/**
 * 벡터의 출처와 신뢰 근거.
 *
 * 1번은 **공개 표준 시험 벡터**(RFC 4269 / KS X 1213)다 — 전키 0 · 평문 `00..0f` →
 *    `5ebac6e0054e166819aff1cc6d346cdb`. 외부에서 검증 가능한 앵커라 맨 앞에 둔다.
 * 나머지는 국세청이 실제로 쓰는 참조 구현과 **무작위 800쌍 차분 테스트**로 일치를 확인한
 *    뒤 그중 일부를 고정한 것이다(차분 테스트 자체는 외부 파일 의존이라 커밋하지 않는다).
 *
 * ⚠️ 이 값이 깨지면 구현이 틀린 것이지 테스트가 낡은 것이 아니다 — 표준은 변하지 않는다.
 */
const VECTORS = [
  {
    label: "RFC 4269 표준 벡터 (전키 0 · 순차 평문)",
    key: "00000000000000000000000000000000",
    pt: "000102030405060708090a0b0c0d0e0f",
    ct: "5ebac6e0054e166819aff1cc6d346cdb",
  },
  {
    label: "순차 키 · 전평문 0",
    key: "000102030405060708090a0b0c0d0e0f",
    pt: "00000000000000000000000000000000",
    ct: "c11f22f20140505084483597e4370f43",
  },
  {
    label: "전 0xff",
    key: "ffffffffffffffffffffffffffffffff",
    pt: "ffffffffffffffffffffffffffffffff",
    ct: "bcb9e68bc5296b2b8e42fb4cf7a2b3ca",
  },
  {
    label: "무작위 1",
    key: "d282e9e11a394675584c7d1902ed1331",
    pt: "be566f530b5d0f36fa6c805d9c70a6fc",
    ct: "2ad45966e7a0e5d3f45db1d337107e00",
  },
  {
    label: "무작위 2",
    key: "d9574739bccb893695c1cd1de7bada25",
    pt: "a1092d60298f2f5952eb6f4567b56886",
    ct: "3dd4715eb2b1dd21ce7582a7b8ae929f",
  },
  {
    label: "무작위 3",
    key: "83d4d52ec91c3125dc3766d5f32b5fb0",
    pt: "3d41fd7ac16c03b97556a78b3c8711ef",
    ct: "6ef7b100ea0d1bd0b303fd643c19f145",
  },
];

describe("SEED 블록 암호", () => {
  for (const vector of VECTORS) {
    it(`암호화: ${vector.label}`, () => {
      expect(hex(seedEncryptBlock(bytes(vector.pt), bytes(vector.key)))).toBe(vector.ct);
    });

    it(`복호화: ${vector.label}`, () => {
      expect(hex(seedDecryptBlock(bytes(vector.ct), bytes(vector.key)))).toBe(vector.pt);
    });
  }

  it("키 길이가 16바이트가 아니면 거부한다", () => {
    expect(() => seedEncryptBlock(new Uint8Array(16), new Uint8Array(8))).toThrow();
  });
});

describe("SEED-CBC 복호", () => {
  /** CBC 는 IV 를 타므로 블록이 여러 개일 때 연쇄가 맞는지 봐야 한다. */
  it("여러 블록을 IV 연쇄로 복호한다(왕복)", () => {
    const key = bytes("000102030405060708090a0b0c0d0e0f");
    const iv = bytes("0f0e0d0c0b0a09080706050403020100");
    const plain = Buffer.from("전자세금계산서 수취 확인 테스트 문자열", "utf8");

    // PKCS#7 패딩 후 CBC 로 직접 암호화(구현의 역방향을 손으로 만든다).
    const padLength = 16 - (plain.length % 16);
    const padded = Buffer.concat([plain, Buffer.alloc(padLength, padLength)]);
    const cipher = Buffer.alloc(padded.length);
    let prev: Uint8Array = iv;
    for (let offset = 0; offset < padded.length; offset += 16) {
      const block = new Uint8Array(16);
      for (let i = 0; i < 16; i += 1) block[i] = padded[offset + i] ^ prev[i];
      const encrypted = seedEncryptBlock(block, key);
      cipher.set(encrypted, offset);
      prev = encrypted;
    }

    const decrypted = seedDecryptCbc(new Uint8Array(cipher), key, iv);
    expect(Buffer.from(decrypted).toString("utf8")).toBe(plain.toString("utf8"));
  });

  it("IV 를 생략하면 0으로 채운 16바이트를 쓴다(국세청 보안메일 규약)", () => {
    const key = bytes("000102030405060708090a0b0c0d0e0f");
    const plain = new Uint8Array(16).fill(7);
    const padded = new Uint8Array(32);
    padded.set(plain);
    padded.fill(16, 16);

    const cipher = Buffer.alloc(32);
    let prev: Uint8Array = new Uint8Array(16);
    for (let offset = 0; offset < 32; offset += 16) {
      const block = new Uint8Array(16);
      for (let i = 0; i < 16; i += 1) block[i] = padded[offset + i] ^ prev[i];
      const encrypted = seedEncryptBlock(block, key);
      cipher.set(encrypted, offset);
      prev = encrypted;
    }

    expect(hex(seedDecryptCbc(new Uint8Array(cipher), key))).toBe(hex(plain));
  });

  /**
   * ⛔ 비밀번호가 틀렸을 때 **쓰레기 평문을 조용히 돌려주면 안 된다** — 호출부가 그걸
   * 계산서로 해석하려 들고, 실패가 "이상한 계산서"로 둔갑한다(P0 No Silent Failure).
   */
  it("패딩이 깨지면 던진다(비밀번호 불일치 신호)", () => {
    const key = bytes("000102030405060708090a0b0c0d0e0f");
    const wrongKey = bytes("ffffffffffffffffffffffffffffffff");
    const cipher = new Uint8Array(32).fill(0x5a);
    // 올바른 키로도 무작위 암호문은 패딩이 맞을 확률이 낮다 — 둘 다 던지는 것이 정상이다.
    expect(() => seedDecryptCbc(cipher, wrongKey)).toThrow(/패딩/);
    expect(() => seedDecryptCbc(new Uint8Array(20), key)).toThrow(/16의 배수/);
    expect(() => seedDecryptCbc(new Uint8Array(0), key)).toThrow();
  });
});
