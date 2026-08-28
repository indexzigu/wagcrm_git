// Gemini 계측 계약 (2026-08-01).
//
// 이 계측이 생긴 이유는 **침묵**이다 — Gemini 프로젝트가 월 지출 상한을 초과해 모든
// 호출이 429 로 죽어 있었는데 `ApiCallLog` 에 Gemini 행이 0건이라 아무도 몰랐다.
// 그래서 이 파일이 지키는 것은 두 가지다:
//   ① 실패가 **반드시** 행으로 남는가 (침묵 재발 방지)
//   ② 그 행에 **키가 새지 않는가** (P0 — 레포가 public 이다)
//   ③ 성공이 행으로 남지 **않는가** (P7 볼륨 규율 — top-20 창 점거 방지)
//
// ③ 을 지키는 이유: `dashboard-data.ts` 가 ApiCallLog 를 provider 무관 `take: 20`
// 으로 읽어 UI 3곳에 뿌린다. 어시스턴트·콘텐츠 가이드는 고볼륨이라 성공 행을 남기면
// Meta App Review 증빙 표에서 Instagram 행이 사라진다(NAVER 계측이 실제로 밟은 함정).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeGeminiKey,
  redactGeminiSecrets,
  truncateGeminiReason,
  geminiEndpointLabel,
  buildGeminiFailureMetadata,
  recordGeminiFailure,
  GEMINI_SCOPE,
  GEMINI_PROVIDER,
  NO_HTTP_RESPONSE,
  type GeminiFailure,
} from "../gemini-usage";

const create = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ apiCallLog: { create } }),
}));

const FAKE_KEY = "AIzaSyFAKEKEYFORTESTONLY_000000000000000";

const failure = (over: Partial<GeminiFailure> = {}): GeminiFailure => ({
  kind: "HTTP",
  model: "gemini-3.6-flash",
  statusCode: 429,
  keysTried: 2,
  lastKeyFingerprint: describeGeminiKey(FAKE_KEY),
  elapsedMs: 1234,
  reason: "quota exceeded",
  ...over,
});

beforeEach(() => create.mockReset());

describe("키 노출 차단 (P0 — public 레포)", () => {
  it("지문은 비가역이고 원문을 포함하지 않는다", () => {
    const fp = describeGeminiKey(FAKE_KEY);
    expect(fp).toHaveLength(6);
    expect(FAKE_KEY).not.toContain(fp!);
    expect(describeGeminiKey(null)).toBeNull();
  });

  it("URL 쿼리의 key 를 지운다 — 오류 본문은 우리가 만들지 않는다", () => {
    const echoed = `https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${FAKE_KEY}`;
    const out = redactGeminiSecrets(echoed);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain("[REDACTED]");
  });

  it("쿼리 밖에 맨몸으로 있는 AIza 키도 지운다", () => {
    expect(redactGeminiSecrets(`token is ${FAKE_KEY} ok`)).not.toContain(FAKE_KEY);
  });

  it("사유 문자열은 redact 를 거친 뒤 잘린다", () => {
    const reason = truncateGeminiReason(`fail ?key=${FAKE_KEY} ` + "x".repeat(500));
    expect(reason).not.toContain(FAKE_KEY);
    expect(reason.length).toBeLessThanOrEqual(301);
  });

  it("endpoint 라벨에 호스트·쿼리가 없다", () => {
    const label = geminiEndpointLabel("gemini-3.6-flash");
    expect(label).not.toContain("?");
    expect(label).not.toContain("googleapis.com");
    expect(label).toContain("gemini-3.6-flash");
  });

  it("저장되는 어느 필드에도 키가 실리지 않는다", async () => {
    await recordGeminiFailure(failure({ reason: `429 ?key=${FAKE_KEY}` }));
    const row = create.mock.calls[0][0].data;
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
  });
});

describe("행 규약", () => {
  it("실패는 반드시 1행 남는다 — 이 계측이 막으려는 것이 침묵이다", async () => {
    await recordGeminiFailure(failure());
    expect(create).toHaveBeenCalledTimes(1);
    const row = create.mock.calls[0][0].data;
    expect(row.provider).toBe(GEMINI_PROVIDER);
    expect(row.permissionScope).toBe(GEMINI_SCOPE);
    expect(row.statusCode).toBe(429);
  });

  it("success 는 언제나 false 다 — 성공 행을 만드는 경로가 없다", async () => {
    for (const kind of ["NO_KEYS", "NETWORK", "HTTP", "KEYS_EXHAUSTED"] as const) {
      create.mockReset();
      await recordGeminiFailure(failure({ kind }));
      expect(create.mock.calls[0][0].data.success).toBe(false);
    }
  });

  it("계측 쓰기 실패가 호출을 깨뜨리지 않는다 — throw 하지 않는다", async () => {
    create.mockRejectedValueOnce(new Error("DB down"));
    await expect(recordGeminiFailure(failure())).resolves.toBeUndefined();
  });

  it("응답 전 실패는 statusCode 0 규약을 쓴다", async () => {
    await recordGeminiFailure(failure({ kind: "NETWORK", statusCode: NO_HTTP_RESPONSE }));
    expect(create.mock.calls[0][0].data.statusCode).toBe(0);
  });
});

describe("지출 상한 판별", () => {
  it("429 + 상한 표현이면 spendCapSuspected 가 선다 — 재시도로는 안 낫는다", () => {
    const m = buildGeminiFailureMetadata(
      failure({ statusCode: 429, reason: "exceeded its monthly spending cap" }),
    );
    expect(m.spendCapSuspected).toBe(true);
  });

  it("429 라도 상한 표현이 없으면 서지 않는다 — 일시 폭주와 구분한다", () => {
    expect(buildGeminiFailureMetadata(failure({ statusCode: 429, reason: "too many requests" }))
      .spendCapSuspected).toBe(false);
  });

  it("429 가 아니면 서지 않는다", () => {
    expect(buildGeminiFailureMetadata(failure({ statusCode: 503, reason: "spending cap" }))
      .spendCapSuspected).toBe(false);
  });
});

describe("배선 — 클라이언트의 모든 종국 실패 경로가 계측된다", () => {
  // 소스 그렙: 새 throw 경로를 추가하면서 계측을 빠뜨리는 것이 이 계측의 주 회귀
  // 경로다(실제로 SDK 갈래 `withGeminiKeyRotation` 이 그렇게 폴백 없이 방치돼 있었다).
  const CLIENT = readFileSync(
    join(process.cwd(), "src/lib/agent/gemini-client.ts"),
    "utf8",
  );

  it("REST·SDK 양쪽 갈래가 모두 계측을 부른다", () => {
    const calls = CLIENT.match(/recordGeminiFailure\(/g) ?? [];
    // callGeminiWithTools 4곳(키없음·네트워크·HTTP·키소진) + withGeminiKeyRotation 2곳
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(CLIENT).toContain("withGeminiKeyRotation");
  });

  it("네 가지 실패 종류가 전부 쓰인다", () => {
    for (const kind of ["NO_KEYS", "NETWORK", "HTTP", "KEYS_EXHAUSTED"]) {
      expect(CLIENT, `${kind} 경로가 계측되지 않는다`).toContain(`"${kind}"`);
    }
  });

  it("클라이언트가 키 원문을 계측에 넘기지 않는다 — 지문만 넘긴다", () => {
    expect(CLIENT).toContain("describeGeminiKey(");
    expect(CLIENT).not.toMatch(/lastKeyFingerprint:\s*(apiKey|keys\[)/);
  });
});
