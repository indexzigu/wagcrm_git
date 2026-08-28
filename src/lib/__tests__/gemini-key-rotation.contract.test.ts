import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectGeminiApiKeys,
  extractErrorStatus,
  getGeminiApiKeys,
  rotateKeys,
  withGeminiKeyRotation,
  __resetGeminiKeyCursorForTest,
} from "@/lib/agent/gemini-client";

/**
 * Gemini 키 로테이션 계약 (오너 지시 2026-07-30 "3개 계정을 돌려가며").
 *
 * 배경(실측): 계정별 **월 지출 상한**에 걸리면 그 키의 모든 모델이 429가 된다
 * (3.6-flash·2.5-flash·2.5-flash-lite 전부 429, 무과금 models.list 만 200).
 * 키가 하나면 그 순간 전 AI 기능이 멈춘다 — 실제로 그 상태였다.
 *
 * 여기서 지키는 것: ①설정된 키를 전부 모으고 ②호출마다 시작 키를 돌리고
 * ③재시도 가치가 있는 실패에서만 다음 키로 넘어간다.
 */

const KEY_ENVS = ["GEMINI_API_KEY", "BACKUP_GEMINI_API_KEY"] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of KEY_ENVS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  __resetGeminiKeyCursorForTest();
});

afterEach(() => {
  for (const name of KEY_ENVS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  __resetGeminiKeyCursorForTest();
});

describe("collectGeminiApiKeys — 변수 하나에 콤마로 여러 계정", () => {
  it("콤마로 나열한 키를 순서대로 모은다", () => {
    process.env.GEMINI_API_KEY = "k1,k2,k3";
    expect(collectGeminiApiKeys()).toEqual(["k1", "k2", "k3"]);
  });

  it("각 조각의 앞뒤 공백을 없앤다 (읽기 좋게 띄어 써도 된다)", () => {
    process.env.GEMINI_API_KEY = " k1 , k2 ,k3 ";
    expect(collectGeminiApiKeys()).toEqual(["k1", "k2", "k3"]);
  });

  it("빈 조각(연속 콤마·후행 콤마)은 무시한다", () => {
    process.env.GEMINI_API_KEY = "k1,,k2,";
    expect(collectGeminiApiKeys()).toEqual(["k1", "k2"]);
  });

  it("BACKUP_GEMINI_API_KEY 는 하위 호환으로 뒤에 이어 붙는다", () => {
    process.env.GEMINI_API_KEY = "k1,k2";
    process.env.BACKUP_GEMINI_API_KEY = "k3,k4";
    expect(collectGeminiApiKeys()).toEqual(["k1", "k2", "k3", "k4"]);
  });

  it("단일 키(콤마 없음)도 그대로 동작한다 — 기존 설정 무변경", () => {
    process.env.GEMINI_API_KEY = "only";
    expect(collectGeminiApiKeys()).toEqual(["only"]);
  });

  it("중복 키는 제거한다 — 같은 계정을 두 번 넣으면 폴백이 무의미하다", () => {
    process.env.GEMINI_API_KEY = "same,other";
    process.env.BACKUP_GEMINI_API_KEY = "same";
    expect(collectGeminiApiKeys()).toEqual(["same", "other"]);
  });

  it("주석·공백 오염을 제거한다(기존 cleanApiKey 규약 유지)", () => {
    process.env.GEMINI_API_KEY = "  k1 , k2 # 계정 2개  ";
    expect(collectGeminiApiKeys()).toEqual(["k1", "k2"]);
  });

  it("설정이 없으면 빈 목록", () => {
    expect(collectGeminiApiKeys()).toEqual([]);
  });
});

describe("rotateKeys", () => {
  it("커서만큼 시작점을 민다", () => {
    expect(rotateKeys(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
    expect(rotateKeys(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotateKeys(["a", "b", "c"], 2)).toEqual(["c", "a", "b"]);
    expect(rotateKeys(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
  });

  it("키가 1개 이하면 그대로 둔다", () => {
    expect(rotateKeys(["only"], 5)).toEqual(["only"]);
    expect(rotateKeys([], 5)).toEqual([]);
  });
});

describe("getGeminiApiKeys — 호출마다 시작 키가 돈다", () => {
  it("3개 키의 시작점이 순환하고, 매번 전체 키를 폴백 후보로 유지한다", () => {
    process.env.GEMINI_API_KEY = "k1,k2,k3";

    expect(getGeminiApiKeys()).toEqual(["k1", "k2", "k3"]);
    expect(getGeminiApiKeys()).toEqual(["k2", "k3", "k1"]);
    expect(getGeminiApiKeys()).toEqual(["k3", "k1", "k2"]);
    expect(getGeminiApiKeys()).toEqual(["k1", "k2", "k3"]);
  });

  it("키가 1개면 회전하지 않는다", () => {
    process.env.GEMINI_API_KEY = "only";
    expect(getGeminiApiKeys()).toEqual(["only"]);
    expect(getGeminiApiKeys()).toEqual(["only"]);
  });
});

describe("extractErrorStatus", () => {
  it("status·code·메시지 순으로 상태를 찾는다", () => {
    expect(extractErrorStatus({ status: 429 })).toBe(429);
    expect(extractErrorStatus({ code: 503 })).toBe(503);
    expect(extractErrorStatus({ message: "got 429 RESOURCE_EXHAUSTED" })).toBe(429);
  });

  it("못 찾으면 null — 인증 오류를 키 소진으로 오인해 전 키를 태우지 않는다", () => {
    expect(extractErrorStatus({ message: "API key not valid" })).toBeNull();
    expect(extractErrorStatus(null)).toBeNull();
    expect(extractErrorStatus("boom")).toBeNull();
  });
});

describe("withGeminiKeyRotation — SDK 호출부 폴백", () => {
  it("429면 다음 키로 넘어간다", async () => {
    process.env.GEMINI_API_KEY = "k1,k2";
    const run = vi.fn(async (key: string) => {
      if (key === "k1") throw Object.assign(new Error("quota"), { status: 429 });
      return `ok:${key}`;
    });
    await expect(withGeminiKeyRotation(run)).resolves.toBe("ok:k2");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("재시도 가치가 없는 오류(401 등)는 즉시 던진다 — 전 키를 태우지 않는다", async () => {
    process.env.GEMINI_API_KEY = "k1,k2";
    const run = vi.fn(async () => {
      throw Object.assign(new Error("bad key"), { status: 401 });
    });
    await expect(withGeminiKeyRotation(run)).rejects.toThrow("bad key");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("모든 키가 429면 마지막 오류를 던진다", async () => {
    process.env.GEMINI_API_KEY = "k1,k2";
    const run = vi.fn(async () => {
      throw Object.assign(new Error("quota"), { status: 429 });
    });
    await expect(withGeminiKeyRotation(run)).rejects.toThrow("quota");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("키가 하나도 없으면 호출 전에 막는다", async () => {
    const run = vi.fn();
    await expect(withGeminiKeyRotation(run)).rejects.toThrow(/키가 서버에 설정/);
    expect(run).not.toHaveBeenCalled();
  });
});
