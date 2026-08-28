/**
 * SEED-128 CBC **복호 전용** 구현 (순수 TS · 의존성 0).
 *
 * ## 왜 직접 구현하나
 *
 * 국세청 전자세금계산서 보안메일(`nts-secure-mail.ts`)이 SEED 로 암호화돼 온다
 * (헤더 `ContentEncryptionAlgorithm:2`). 그런데 **Node 의 기본 OpenSSL 에는 SEED 가 없다**
 * (실측: OpenSSL 3.5.5 에서 `getCiphers()` 에 seed 계열 0건, ARIA 는 있다).
 *
 * 대안 2가지를 기각했다:
 * - `NODE_OPTIONS=--openssl-legacy-provider` — 실제로 `seed-cbc` 가 노출되긴 하지만
 *   **앱 전역**으로 폐기된 알고리즘군이 함께 되살아나고, 서버리스 런타임에서 플래그가
 *   먹는다는 보장이 없다. 기능 하나 때문에 앱 전체 크립토 정책을 낮추는 셈이다.
 * - npm 단일목적 크립토 패키지 — 공개 레포에서 세무 데이터를 다루는데 검증되지 않은
 *   의존성을 들이는 비용이 크다.
 *
 * **복호만 필요하고, 틀리면 XML 이 안 나오므로 오답이 조용히 지나갈 수 없다** — 그래서
 * 직접 구현이 안전한 선택이다.
 *
 * ## 상수의 출처 (지어내지 않았다)
 *
 * SEED 는 공개 표준(KS X 1213 · RFC 4269)이다. 아래 S-box 2종과 KC 16개는 국세청이 실제로
 * 쓰는 참조 구현에서 **수치로 추출한 뒤**, 표준이 정의하는 관계식이 성립하는지 기계로
 * 확인해 압축한 것이다:
 *
 *     SS0[x] = (S1[x] * 0x01010101) & 0x3FCFF3FC
 *     SS1[x] = (S2[x] * 0x01010101) & 0xFC3FCFF3
 *     SS2[x] = (S1[x] * 0x01010101) & 0xF3FC3FCF
 *     SS3[x] = (S2[x] * 0x01010101) & 0xCFF3FC3F
 *
 * 4개 테이블(1024개 상수) 전부가 이 식으로 재현됐고 S-box 가 치환(permutation)임도 확인했다.
 * 그래서 여기엔 **512바이트만** 둔다 — 1024개 매직넘버를 베껴 넣지 않는다.
 *
 * 정확성은 참조 구현과의 **차분 테스트**(무작위 키·블록)로 고정한다 — 벡터 몇 개보다 강하다.
 */

const S1_HEX =
  "a985d6d3541dac255d43181e51fcca632844209de0e2c817a58f037bbb13d2ee" +
  "708c3fa832ddf674ec950b575c5bbd01241c739810ccf2d92ce772839bd186c9" +
  "6050a3eb0db69e4fb75ac678a612afd561c3b441527d8d081f9900190453f7e1" +
  "fd762f27b08b0eaba26e934d697c090abfeff3c58714fe64de2e4b1a06216b66" +
  "02f5928a0cb37ed07a4796e52680addfa13037ae36152238f4a7454c81e98497" +
  "35cbce3c7111c78975fbdaf8945982c4ff493967c0cfd7b80f8e4223916cdba4" +
  "34f148c26f3d2d40be3ebcc1aaba4e553bdc687f9cd84a5677a0ed46b52b65fa" +
  "e3b9b19f5ef9e6b231ea6d5fe4f0cd88163a58d462290733e81b0579906a2a9a";

const S2_HEX =
  "38e82da6cfdeb3b8af6055c7446f6b5bc36233b529a0e2a7d39111061cbc364b" +
  "ef886ca817c416f4c245e1d63f3d8e98284ef63ea5f90ddfd82b667a272ff172" +
  "42d441c07367ac8bf7ad801fca2caa34d20beee95d9418f857ae08c513cd86b9" +
  "ff7dc131f58a6ab1d120d7022204687107db9d9961bee659dd5190dc9aa3abd0" +
  "810f471ae3ec8dbf967b5ca2a163234dc89e9c3a0c2eba6e9f5af292f34978cc" +
  "15fb70757f351003646dc674d5b4ea097619fe4012e0bd05fa01f02a5ea95643" +
  "8514899bb0e5487997fc1e82218c1b5f7754b21d254f0046ed5852eb7edac9fd" +
  "3095653cb6e4bb7c0e5039263284699337e724a4cb530a87d94c838fce3b4ab7";

/** SEED 키 스케줄 상수(황금비 파생). 참조 구현 값과 일치 확인. */
const KC = [
  0x9e3779b9, 0x3c6ef373, 0x78dde6e6, 0xf1bbcdcc, 0xe3779b99, 0xc6ef3733, 0x8dde6e67,
  0x1bbcdccf, 0x3779b99e, 0x6ef3733c, 0xdde6e678, 0xbbcdccf1, 0x779b99e3, 0xef3733c6,
  0xde6e678d, 0xbcdccf1b,
];

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function buildSs(sbox: Uint8Array, mask: number): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    table[i] = ((sbox[i] * 0x01010101) & mask) >>> 0;
  }
  return table;
}

const S1 = hexToBytes(S1_HEX);
const S2 = hexToBytes(S2_HEX);
const SS0 = buildSs(S1, 0x3fcff3fc);
const SS1 = buildSs(S2, 0xfc3fcff3);
const SS2 = buildSs(S1, 0xf3fc3fcf);
const SS3 = buildSs(S2, 0xcff3fc3f);

/** SEED 의 G 함수. */
function g(x: number): number {
  return (
    (SS3[(x >>> 24) & 0xff] ^ SS2[(x >>> 16) & 0xff] ^ SS1[(x >>> 8) & 0xff] ^ SS0[x & 0xff]) >>> 0
  );
}

function readWord(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function writeWord(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** 16 라운드분 라운드키(각 2워드)를 만든다. */
function expandKey(key: Uint8Array): number[][] {
  if (key.length !== 16) throw new Error("SEED 키는 16바이트여야 합니다.");
  let a = readWord(key, 0);
  let b = readWord(key, 4);
  let c = readWord(key, 8);
  let d = readWord(key, 12);

  const roundKeys: number[][] = [];
  for (let i = 0; i < 16; i += 1) {
    roundKeys.push([g((a + c - KC[i]) >>> 0), g((b - d + KC[i]) >>> 0)]);
    if (i % 2 === 0) {
      // (A||B) 를 8비트 오른쪽 회전
      const prevA = a;
      a = ((a >>> 8) | (b << 24)) >>> 0;
      b = ((b >>> 8) | (prevA << 24)) >>> 0;
    } else {
      // (C||D) 를 8비트 왼쪽 회전
      const prevC = c;
      c = ((c << 8) | (d >>> 24)) >>> 0;
      d = ((d << 8) | (prevC >>> 24)) >>> 0;
    }
  }
  return roundKeys;
}

/** F 함수 — 라운드키를 먹인 우측 절반을 섞는다. */
function f(r0: number, r1: number, k0: number, k1: number): [number, number] {
  let c0 = (r0 ^ k0) >>> 0;
  let c1 = (r1 ^ k1) >>> 0;
  c1 = g((c1 ^ c0) >>> 0);
  c0 = g((c0 + c1) >>> 0);
  c1 = g((c1 + c0) >>> 0);
  c0 = (c0 + c1) >>> 0;
  return [c0, c1];
}

function cryptBlock(block: Uint8Array, roundKeys: number[][], out: Uint8Array): void {
  let l0 = readWord(block, 0);
  let l1 = readWord(block, 4);
  let r0 = readWord(block, 8);
  let r1 = readWord(block, 12);

  for (let i = 0; i < 16; i += 1) {
    const [f0, f1] = f(r0, r1, roundKeys[i][0], roundKeys[i][1]);
    const nextR0 = (l0 ^ f0) >>> 0;
    const nextR1 = (l1 ^ f1) >>> 0;
    l0 = r0;
    l1 = r1;
    r0 = nextR0;
    r1 = nextR1;
  }

  // 마지막 스왑을 되돌린다(Feistel 관례).
  writeWord(out, 0, r0);
  writeWord(out, 4, r1);
  writeWord(out, 8, l0);
  writeWord(out, 12, l1);
}

/** 단일 블록 암호화 — 차분 테스트로 구현 정확성을 확인하기 위해 함께 노출한다. */
export function seedEncryptBlock(block: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  cryptBlock(block, expandKey(key), out);
  return out;
}

/** 단일 블록 복호화 — 라운드키를 뒤집으면 된다. */
export function seedDecryptBlock(block: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  cryptBlock(block, expandKey(key).reverse(), out);
  return out;
}

/**
 * SEED-128 CBC 복호 + PKCS#7 패딩 제거.
 *
 * 패딩이 깨져 있으면 **던진다** — 대개 비밀번호가 틀린 것이고, 조용히 쓰레기 평문을
 * 돌려주면 호출부가 그걸 계산서로 해석하려 든다(P0 No Silent Failure).
 */
export function seedDecryptCbc(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array = new Uint8Array(16),
): Uint8Array {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error("SEED-CBC 입력 길이가 16의 배수가 아닙니다.");
  }
  const roundKeys = expandKey(key).reverse();
  const out = new Uint8Array(ciphertext.length);
  const buffer = new Uint8Array(16);
  let prev = iv;

  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    const block = ciphertext.subarray(offset, offset + 16);
    cryptBlock(block, roundKeys, buffer);
    for (let i = 0; i < 16; i += 1) out[offset + i] = buffer[i] ^ prev[i];
    prev = block;
  }

  const pad = out[out.length - 1];
  if (pad < 1 || pad > 16 || pad > out.length) {
    throw new Error("PKCS#7 패딩이 올바르지 않습니다(비밀번호 불일치 가능).");
  }
  for (let i = out.length - pad; i < out.length; i += 1) {
    if (out[i] !== pad) throw new Error("PKCS#7 패딩이 올바르지 않습니다(비밀번호 불일치 가능).");
  }
  return out.subarray(0, out.length - pad);
}
