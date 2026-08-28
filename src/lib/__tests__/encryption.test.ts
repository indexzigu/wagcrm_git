// 주민등록번호 암·복호화 계약 (2026-07-23).
// 이전 구현의 두 결함을 고정한다:
//   ① ENCRYPTION_KEY 부재 시 소스에 박힌 기본 키로 폴백 → 공개된 키로 암호화
//   ② 복호화 실패 시 원문(=암호문)을 그대로 반환 → 주민번호 자리에 암호문이 조용히 표시
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDecryptability, decrypt, decryptOrNull, encrypt, isEncrypted } from "../encryption";

const ORIGINAL_ENV = { ...process.env };
const KEY_A = "key-a-0123456789abcdef0123456789";
const KEY_B = "key-b-fedcba9876543210fedcba9876";
const SAMPLE = "900101-1234567";

beforeEach(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("fail-closed", () => {
  it("ENCRYPTION_KEY 가 없으면 약한 기본 키로 암호화하지 않고 던진다", () => {
    expect(() => encrypt(SAMPLE)).toThrow(/ENCRYPTION_KEY/);
  });

  it("ENCRYPTION_KEY 가 없으면 복호화도 던진다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const blob = encrypt(SAMPLE);
    delete process.env.ENCRYPTION_KEY;
    expect(() => decrypt(blob)).toThrow(/ENCRYPTION_KEY/);
  });

  it("빈 값은 키 없이도 빈 값이다(입력 없음은 오류가 아니다)", () => {
    expect(encrypt("")).toBe("");
    expect(decrypt("")).toBe("");
  });
});

describe("라운드트립", () => {
  it("같은 키로 암·복호화하면 원문이 돌아온다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const blob = encrypt(SAMPLE);
    expect(blob).not.toContain(SAMPLE);
    expect(isEncrypted(blob)).toBe(true);
    expect(decrypt(blob)).toBe(SAMPLE);
  });

  it("같은 원문이라도 매번 다른 암호문이 된다(IV 무작위)", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(encrypt(SAMPLE)).not.toBe(encrypt(SAMPLE));
  });
});

describe("키 전환(ENCRYPTION_KEY_PREVIOUS)", () => {
  it("구 키로 암호화된 값을 새 키 환경에서도 읽는다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const legacy = encrypt(SAMPLE);

    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.ENCRYPTION_KEY_PREVIOUS = KEY_A;
    expect(decrypt(legacy)).toBe(SAMPLE);
  });

  it("새 키로 쓴 값도 전환 기간에 정상적으로 읽힌다", () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.ENCRYPTION_KEY_PREVIOUS = KEY_A;
    expect(decrypt(encrypt(SAMPLE))).toBe(SAMPLE);
  });

  it("구 키를 제거하면 옛 값은 더 이상 읽히지 않는다(재암호화 누락을 드러낸다)", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const legacy = encrypt(SAMPLE);

    process.env.ENCRYPTION_KEY = KEY_B;
    expect(() => decrypt(legacy)).toThrow(/복호화 실패/);
  });
});

describe("실패를 삼키지 않는다", () => {
  it("키가 어긋나면 암호문을 그대로 반환하지 않고 던진다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const blob = encrypt(SAMPLE);

    process.env.ENCRYPTION_KEY = KEY_B;
    // 구 구현은 여기서 blob 을 그대로 돌려줬다 — 화면에 암호문이 뜨고 아무도 몰랐다.
    expect(() => decrypt(blob)).toThrow();
    let returned: string | null = null;
    try {
      returned = decrypt(blob);
    } catch {
      returned = null;
    }
    expect(returned).not.toBe(blob);
  });

  it("암호문 형식이 아닌 값(평문)은 그대로 통과시킨다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(decrypt(SAMPLE)).toBe(SAMPLE);
    expect(isEncrypted(SAMPLE)).toBe(false);
  });
});

describe("classifyDecryptability — 감사용 판독(값을 돌려주지 않는다)", () => {
  it("현재 키로 열리면 current", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(classifyDecryptability(encrypt(SAMPLE))).toBe("current");
  });

  it("구 키로만 열리면 previous — decrypt() 로는 구분할 수 없던 상태다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const legacy = encrypt(SAMPLE);

    process.env.ENCRYPTION_KEY = KEY_B;
    process.env.ENCRYPTION_KEY_PREVIOUS = KEY_A;
    // decrypt() 는 여기서 성공한다(사다리) — 그래서 "재암호화 미완"이 정상으로 보였다.
    expect(decrypt(legacy)).toBe(SAMPLE);
    expect(classifyDecryptability(legacy)).toBe("previous");
  });

  it("어느 키로도 안 열리면 unreadable (2026-08-13 사고의 상태)", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const orphan = encrypt(SAMPLE);
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(classifyDecryptability(orphan)).toBe("unreadable");
  });

  it("암호문 형식이 아니면 plaintext — 복호화 실패가 아니다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(classifyDecryptability(SAMPLE)).toBe("plaintext");
  });

  it("빈 값·null·undefined 는 empty", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(classifyDecryptability("")).toBe("empty");
    expect(classifyDecryptability(null)).toBe("empty");
    expect(classifyDecryptability(undefined)).toBe("empty");
  });

  it("키가 없어도 던지지 않는다 — 전 행 스캔이 예외로 중단되면 감사기가 죽는다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const blob = encrypt(SAMPLE);
    delete process.env.ENCRYPTION_KEY;
    expect(() => classifyDecryptability(blob)).not.toThrow();
    expect(classifyDecryptability(blob)).toBe("unreadable");
  });

  it("반환값에 평문·암호문이 섞이지 않는다(등급 문자열뿐)", () => {
    // 이 함수가 존재하는 이유의 절반이 여기다 — 감사 경로는 주민등록번호를 손에 쥐지 않는다.
    process.env.ENCRYPTION_KEY = KEY_A;
    const blob = encrypt(SAMPLE);
    const grade: string = classifyDecryptability(blob);
    expect(grade).not.toContain(SAMPLE);
    expect(grade).not.toContain(blob);
    expect(["empty", "plaintext", "current", "previous", "unreadable"]).toContain(grade);
  });
});

describe("decryptOrNull — 대량 조회 경로(프리렌더 포함)", () => {
  it("정상 값은 decrypt 와 동일하게 복호화한다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(decryptOrNull(encrypt(SAMPLE))).toBe(SAMPLE);
  });

  it("빈 값·null 은 null 이다", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(decryptOrNull("")).toBeNull();
    expect(decryptOrNull(null)).toBeNull();
    expect(decryptOrNull(undefined)).toBeNull();
  });

  it("키가 어긋나도 던지지 않고 null 이다 — 한 행이 페이지·빌드를 죽이지 않게", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const legacy = encrypt(SAMPLE);
    process.env.ENCRYPTION_KEY = KEY_B;

    expect(() => decryptOrNull(legacy)).not.toThrow();
    expect(decryptOrNull(legacy)).toBeNull();
  });

  it("실패해도 암호문을 돌려주지 않는다(구 동작 회귀 방지)", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const legacy = encrypt(SAMPLE);
    process.env.ENCRYPTION_KEY = KEY_B;

    // 구 구현은 여기서 legacy(암호문)를 그대로 화면에 흘렸다.
    expect(decryptOrNull(legacy)).not.toBe(legacy);
  });

  it("ENCRYPTION_KEY 자체가 없어도 던지지 않는다(설정 누락이 빌드를 죽이지 않게)", () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const blob = encrypt(SAMPLE);
    delete process.env.ENCRYPTION_KEY;

    expect(() => decryptOrNull(blob)).not.toThrow();
    expect(decryptOrNull(blob)).toBeNull();
  });
});
