// 암호화 키 정합 감사 계약 (2026-08-13 실사고).
//
// 고정하는 것 세 가지:
//   ① 판정 축 — 무엇이 빨강이고 무엇이 아닌가(오탐으로 빨강이 습관화되면 신호가 죽는다)
//   ② 감사 경로에 주민등록번호 **값**이 흐르지 않는다(P0 — 레포가 public 이고, 결과는
//      SystemTaskLog·크론 응답·서버 로그로 나간다)
//   ③ 크론 라우트가 실패를 선언한다(HTTP 200 = 성공이 아니다 — CronOutcomeBody 계약)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateEncryptionAudit,
  runEncryptionKeyAudit,
  type EncryptionAuditTally,
  type ResidentNumberAuditSource,
} from "../encryption-audit";
import { encrypt } from "../encryption";

const ORIGINAL_ENV = { ...process.env };
const KEY_A = "key-a-0123456789abcdef0123456789";
const KEY_B = "key-b-fedcba9876543210fedcba9876";
const SAMPLE = "sample-identity-value";
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * 소스 스캔에서 **주석을 걷어낸다.** 이 모듈들은 "왜 decrypt() 를 쓰지 않는가"·"왜
 * failed: true 로 선언하는가"를 주석으로 길게 설명하므로, 원문 그대로 스캔하면 **설명문이
 * 위반으로 잡힌다**(settlement-statement-surface-parity 계약이 밟은 함정과 같다).
 * 판정 대상은 실행되는 코드다.
 */
const codeOf = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

beforeEach(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
  // 원격 DB 를 가정한다 — sqlite 면 감사가 skip 되므로 판정 자체가 안 돈다.
  // 자격증명을 넣지 않는다(commit-guard 가 URL 내장 자격증명을 차단한다 — 정당한 차단이다).
  // 판정식은 `file:` 접두사만 보므로 호스트만 있으면 "원격"으로 충분하다.
  process.env.DATABASE_URL = "postgresql://127.0.0.1:5432/postgres";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const tally = (over: Partial<EncryptionAuditTally> = {}): EncryptionAuditTally => ({
  sellersScanned: 10,
  stored: 4,
  currentKey: 4,
  previousKeyOnly: 0,
  plaintext: 0,
  unreadable: 0,
  unreadableSellerIds: [],
  previousKeySellerIds: [],
  ...over,
});

const source = (rows: { id: string; value: string | null }[], sellers = 10): ResidentNumberAuditSource => ({
  countSellers: async () => sellers,
  listStoredValues: async () => rows,
});

describe("판정 축", () => {
  it("전부 현재 키로 열리면 ok", () => {
    expect(evaluateEncryptionAudit(tally()).status).toBe("ok");
  });

  it("현재·구 키 어느 쪽으로도 안 열리는 행이 있으면 degraded(빨강)", () => {
    const result = evaluateEncryptionAudit(tally({ currentKey: 2, unreadable: 2, unreadableSellerIds: ["s1", "s2"] }));
    expect(result.status).toBe("degraded");
    expect(result.status === "degraded" && result.summary).toContain("2건");
  });

  it("구 키로만 열리는 행도 빨강이다 — 화면은 멀쩡해 보이지만 전환이 안 끝났다", () => {
    // ENCRYPTION_KEY_PREVIOUS 를 제거하는 순간 이 행들이 이번 사고와 똑같이 빈칸이 된다.
    const result = evaluateEncryptionAudit(tally({ currentKey: 3, previousKeyOnly: 1, previousKeySellerIds: ["s9"] }));
    expect(result.status).toBe("degraded");
    expect(result.status === "degraded" && result.summary).toContain("재암호화 미완");
  });

  it("평문 행은 빨강으로 올리지 않는다 — 축이 다른 문제다(저장 위생)", () => {
    // 개수는 보고하되 키 정합 신호에 섞지 않는다. 섞으면 둘 다 흐려진다.
    const result = evaluateEncryptionAudit(tally({ currentKey: 3, plaintext: 1 }));
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.plaintext).toBe(1);
  });

  it("셀러가 0명이면 'ok' 가 아니라 broken(감사 불능)이다", () => {
    // db-exposure-audit 의 "테이블 0개는 깨끗함이 아니다" 와 같은 판정 — 위반 0건과
    // 대상을 못 보는 상태를 구분하지 않으면 감사기가 죽은 채 매일 초록을 찍는다.
    const result = evaluateEncryptionAudit(tally({ sellersScanned: 0, stored: 0, currentKey: 0 }));
    expect(result.status).toBe("broken");
  });

  it("주민등록번호 저장 행이 0건이면 empty — 실패는 아니지만 사유를 남긴다", () => {
    // 셀러는 있는데 저장된 값이 없는 상태는 **정상일 수 있다**(개인 셀러 원천징수용이라
    // 한 건도 없는 시점이 실재한다). 빨강으로 만들면 매일 빨강이 되어 신호가 죽는다.
    const result = evaluateEncryptionAudit(tally({ stored: 0, currentKey: 0 }));
    expect(result.status).toBe("empty");
    expect(result.status === "empty" && result.reason).toContain("0건");
  });
});

describe("실행(runEncryptionKeyAudit)", () => {
  it("현재 키로 암호화된 행만 있으면 ok", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const result = await runEncryptionKeyAudit(source([{ id: "s1", value: encrypt(SAMPLE) }]));
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.currentKey).toBe(1);
  });

  it("키가 바뀌어 열리지 않는 행을 센다 — 이 사고를 재현한다", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const beforeRotation = [encrypt(SAMPLE), encrypt(SAMPLE)];

    // 컷오버에서 키만 갈린 상태(구 키는 회수 불가라 PREVIOUS 도 없다).
    process.env.ENCRYPTION_KEY = KEY_B;
    const fresh = encrypt(SAMPLE);

    const result = await runEncryptionKeyAudit(
      source([
        { id: "s1", value: beforeRotation[0] },
        { id: "s2", value: beforeRotation[1] },
        { id: "s3", value: fresh },
      ]),
    );

    expect(result.status).toBe("degraded");
    expect(result.status === "degraded" && result.unreadable).toBe(2);
    expect(result.status === "degraded" && result.currentKey).toBe(1);
    expect(result.status === "degraded" && result.unreadableSellerIds).toEqual(["s1", "s2"]);
  });

  it("빈 문자열 행은 실패로 세지 않는다(열 것이 없다)", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const result = await runEncryptionKeyAudit(source([{ id: "s1", value: "" }, { id: "s2", value: null }]));
    expect(result.status).toBe("empty");
  });

  it("ENCRYPTION_KEY 미설정은 데이터 문제가 아니라 설정 문제로 갈라 보고한다", async () => {
    const result = await runEncryptionKeyAudit(source([{ id: "s1", value: "a:b:c" }]));
    expect(result.status).toBe("broken");
    expect(result.status === "broken" && result.reason).toContain("ENCRYPTION_KEY");
  });

  it("sqlite·데모 레인은 skip 이다(거짓 경보 금지)", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.DATABASE_URL = "file:./dev.db";
    const result = await runEncryptionKeyAudit(source([{ id: "s1", value: "a:b:c" }]));
    expect(result.status).toBe("skipped");
  });

  it("보고하는 셀러 id 수에 상한이 있다(이력 테이블 비대화 방지)", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const orphans = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, value: encrypt(SAMPLE) }));
    process.env.ENCRYPTION_KEY = KEY_B;

    const result = await runEncryptionKeyAudit(source(orphans, 30));
    expect(result.status).toBe("degraded");
    // 개수는 상한과 무관하게 실제 값이어야 한다 — 상한이 개수까지 깎으면 축소보고가 된다.
    expect(result.status === "degraded" && result.unreadable).toBe(30);
    expect(result.status === "degraded" && result.unreadableSellerIds.length).toBe(20);
  });
});

describe("값 비유출(P0)", () => {
  it("결과에는 개수와 셀러 id 만 담긴다 — 평문·암호문이 실리지 않는다", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const stored = encrypt(SAMPLE);
    process.env.ENCRYPTION_KEY = KEY_B;

    const result = await runEncryptionKeyAudit(source([{ id: "s1", value: stored }]));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SAMPLE);
    expect(serialized).not.toContain(stored);
    expect(serialized).not.toContain(KEY_A);
    expect(serialized).not.toContain(KEY_B);
  });

  it("감사 모듈이 복호화 **값**을 얻는 함수를 쓰지 않는다(소스 스캔)", () => {
    // decrypt()/decryptOrNull() 은 성공 시 평문을 반환한다. 감사기가 그걸 받으면 값이
    // 감사 경로로 흘러들 수 있으므로, 등급만 돌려주는 classifyDecryptability 만 쓴다.
    const code = codeOf("src/lib/encryption-audit.ts");
    expect(code, "앵커 없음(공허 통과 방지)").toContain("classifyDecryptability");
    expect(/\bdecryptOrNull\b/.test(code), "encryption-audit.ts 가 decryptOrNull 을 쓴다 — 평문을 손에 쥔다").toBe(false);
    expect(/\bdecrypt\(/.test(code), "encryption-audit.ts 가 decrypt() 를 쓴다 — 평문을 손에 쥔다").toBe(false);
  });

  it("크론 라우트도 값을 로그·응답에 싣지 않는다(소스 스캔)", () => {
    const code = codeOf("src/app/api/cron/encryption-key-audit/route.ts");
    expect(code, "앵커 없음").toContain("runEncryptionKeyAudit");
    expect(/\bdecrypt(OrNull)?\(/.test(code)).toBe(false);
    // 라우트가 행 값을 직접 만지는 유일한 지점은 어댑터의 매핑이고, 그 값은 감사기로만 간다.
    expect(code.includes("console.log")).toBe(false);
  });
});

describe("크론 계약", () => {
  it("이상이면 failed: true 로 선언한다(HTTP 200 = 성공이 아니다)", () => {
    const src = read("src/app/api/cron/encryption-key-audit/route.ts");
    expect(src).toContain("failed: true");
    expect(src).toContain("failureReason");
    // 래퍼를 안 태우면 레이더에 아무 기록이 남지 않는다 — 무증상 실패를 그대로 재생산한다.
    expect(src).toContain("withSystemTaskStatus");
    // 크론은 전부 시크릿 인증을 자체 검증한다(세션 게이트에서 prefix 로 면제되므로).
    expect(src).toContain("verifyCronAuth");
  });

  it("empty·skipped 는 실패로 선언하지 않는다(오탐 빨강 방지)", () => {
    const failedBlocks = codeOf("src/app/api/cron/encryption-key-audit/route.ts").split("failed: true");
    // failed 선언은 degraded·broken 두 갈래뿐이다.
    expect(failedBlocks.length - 1).toBe(2);
  });
});
