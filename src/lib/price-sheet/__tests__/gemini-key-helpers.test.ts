/**
 * gemini-client.ts에 추가한 키로테이션 헬퍼 export(getGeminiApiKeys/isRetryableGeminiStatus)가
 * pricesheet-extract-client.ts에서 기대하는 계약(순서/재시도 판정)을 그대로 지키는지 검증한다.
 * gemini-client 자체 로직은 불변이어야 하므로, 여기서는 export된 함수의 동작만 확인한다.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getGeminiApiKeys, isRetryableGeminiStatus } from "@/lib/agent/gemini-client";

describe("getGeminiApiKeys", () => {
  const originalPrimary = process.env.GEMINI_API_KEY;
  const originalBackup = process.env.BACKUP_GEMINI_API_KEY;

  afterEach(() => {
    process.env.GEMINI_API_KEY = originalPrimary;
    process.env.BACKUP_GEMINI_API_KEY = originalBackup;
  });

  it("1차 키만 설정되면 배열 길이 1", () => {
    process.env.GEMINI_API_KEY = "key1";
    delete process.env.BACKUP_GEMINI_API_KEY;
    expect(getGeminiApiKeys()).toEqual(["key1"]);
  });

  it("1차+백업 키 모두 설정되면 순서대로 반환", () => {
    process.env.GEMINI_API_KEY = "key1";
    process.env.BACKUP_GEMINI_API_KEY = "key2";
    expect(getGeminiApiKeys()).toEqual(["key1", "key2"]);
  });

  it("키가 없으면 빈 배열", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.BACKUP_GEMINI_API_KEY;
    expect(getGeminiApiKeys()).toEqual([]);
  });

  it("주석(#) 포함 키는 정리된다", () => {
    process.env.GEMINI_API_KEY = "key1 # comment";
    delete process.env.BACKUP_GEMINI_API_KEY;
    expect(getGeminiApiKeys()).toEqual(["key1"]);
  });
});

describe("isRetryableGeminiStatus", () => {
  it("429/503/5xx는 재시도 가능", () => {
    expect(isRetryableGeminiStatus(429)).toBe(true);
    expect(isRetryableGeminiStatus(503)).toBe(true);
    expect(isRetryableGeminiStatus(500)).toBe(true);
  });
  it("400/401/404는 재시도 불가", () => {
    expect(isRetryableGeminiStatus(400)).toBe(false);
    expect(isRetryableGeminiStatus(401)).toBe(false);
    expect(isRetryableGeminiStatus(404)).toBe(false);
  });
});
