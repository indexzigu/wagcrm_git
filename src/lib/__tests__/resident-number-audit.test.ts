// 주민등록번호 감사 로그 계약 (2026-08-13).
// 고정하는 실사고: 컷오버로 ENCRYPTION_KEY 가 갈리자, 감사 로그를 만들려고 기존
// 암호문을 복호화하던 저장 경로가 throw 해서 PATCH 가 500 이 됐고 **올바른 값을
// 재입력하는 것조차 불가능**했다. 부가 기능이 주 기능을 죽이면 안 된다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt } from "../encryption";
import { UNDECRYPTABLE_MARK, buildResidentNumberAuditEntry } from "../resident-number-audit";

const ORIGINAL_ENV = { ...process.env };
const KEY_A = "key-a-0123456789abcdef0123456789";
const KEY_B = "key-b-fedcba9876543210fedcba9876";
// 픽스처는 주민등록번호 형태만 흉내낸 합성값이다(뒷자리는 숫자가 아니다).
// 마스킹은 앞 6자리만 쓰므로 검증에는 영향이 없고, 커밋 가드의 오탐도 피한다.
const SAMPLE = "900101-XXXXXXX";
const OTHER = "880202-YYYYYYY";

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY_A;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("이전 값이 열리지 않을 때", () => {
  it("던지지 않는다 — 저장 경로를 죽이지 않는다(회귀 방지의 핵심)", () => {
    const legacy = encrypt(SAMPLE);
    process.env.ENCRYPTION_KEY = KEY_B;

    expect(() => buildResidentNumberAuditEntry(legacy, OTHER)).not.toThrow();
  });

  it("이전 값 자리에 표식을 남긴다 — null(값 없음)과 구분한다", () => {
    const legacy = encrypt(SAMPLE);
    process.env.ENCRYPTION_KEY = KEY_B;

    const entry = buildResidentNumberAuditEntry(legacy, OTHER);
    expect(entry?.curVal).toBe(UNDECRYPTABLE_MARK);
    expect(entry?.val).toBe("880202-*******");
  });

  it("암호문을 감사 로그로 흘리지 않는다", () => {
    const legacy = encrypt(SAMPLE);
    process.env.ENCRYPTION_KEY = KEY_B;

    const entry = buildResidentNumberAuditEntry(legacy, OTHER);
    expect(entry?.curVal).not.toBe(legacy);
    expect(entry?.curVal).not.toContain(":");
  });

  it("새 값을 비우는 경우에도 기록은 남는다", () => {
    const legacy = encrypt(SAMPLE);
    process.env.ENCRYPTION_KEY = KEY_B;

    const entry = buildResidentNumberAuditEntry(legacy, null);
    expect(entry).toEqual({ fieldLabel: "주민등록번호", curVal: UNDECRYPTABLE_MARK, val: null });
  });
});

describe("정상 경로 — 기존 동작 보존", () => {
  it("값이 같으면 변경으로 기록하지 않는다", () => {
    expect(buildResidentNumberAuditEntry(encrypt(SAMPLE), SAMPLE)).toBeNull();
  });

  it("값이 바뀌면 양쪽 다 마스킹해서 기록한다", () => {
    expect(buildResidentNumberAuditEntry(encrypt(SAMPLE), OTHER)).toEqual({
      fieldLabel: "주민등록번호",
      curVal: "900101-*******",
      val: "880202-*******",
    });
  });

  it("평문 전체를 감사 로그에 남기지 않는다", () => {
    const entry = buildResidentNumberAuditEntry(encrypt(SAMPLE), OTHER);
    expect(entry?.curVal).not.toContain("XXXXXXX");
    expect(entry?.val).not.toContain("YYYYYYY");
  });

  it("이전 값이 없다가 새로 입력되면 이전 값은 null 이다", () => {
    expect(buildResidentNumberAuditEntry(null, SAMPLE)).toEqual({
      fieldLabel: "주민등록번호",
      curVal: null,
      val: "900101-*******",
    });
  });

  it("둘 다 없으면 변경이 아니다", () => {
    expect(buildResidentNumberAuditEntry(null, null)).toBeNull();
    expect(buildResidentNumberAuditEntry("", "")).toBeNull();
  });

  it("있던 값을 지우면 변경으로 기록한다", () => {
    expect(buildResidentNumberAuditEntry(encrypt(SAMPLE), null)).toEqual({
      fieldLabel: "주민등록번호",
      curVal: "900101-*******",
      val: null,
    });
  });
});
