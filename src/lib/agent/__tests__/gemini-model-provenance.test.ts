import { describe, expect, it } from "vitest";
import { parseGeminiResponse } from "@/lib/agent/gemini-client";
import { GEMINI_PRIMARY_MODEL } from "@/lib/gemini-model";

/**
 * 모델명 **출처**의 계약.
 *
 * 🪤 **실측 2026-07-31:** `parseGeminiResponse` 가 `model: GEMINI_MODEL` 로 **요청 상수를
 * 그대로 반향**하고 있었다. 그래서 호출부는 "설정된 모델"을 받아 놓고 "실제 응답한
 * 모델"로 착각했다. 코드가 틀렸다기보다 **주석이 거짓 보증을 했다** — `DealAssetDraft`
 * 에 모델명을 남기는 쪽(#187)에 *"상수를 다시 읽지 않고 결과에서 가져온다"* 고 적혀
 * 있어서, 폴백 사다리를 붙이는 사람이 이 파일을 확인하지 않게 돼 있었다.
 *
 * 감사 기록은 **틀린 값이 남는 쪽이 빈 값보다 나쁘다** — 없으면 모르는 줄 알지만,
 * 있으면 맞는 줄 안다. C3 §6 평가 루프가 모델 교체 전후를 가르는 축이라 특히 그렇다.
 */

const base = { candidates: [{ content: { parts: [{ text: "본문" }] } }] };

describe("parseGeminiResponse — 모델명은 응답이 정본", () => {
  it("응답의 modelVersion 을 상수보다 우선한다", () => {
    // 별칭(-latest 류)이나 구글의 마이너 리비전 롤에서 요청 문자열과 갈린다.
    const r = parseGeminiResponse(
      { ...base, modelVersion: "gemini-3.6-flash-002" },
      12,
    );
    expect(r.model).toBe("gemini-3.6-flash-002");
    expect(r.model).not.toBe(GEMINI_PRIMARY_MODEL);
  });

  it("응답에 modelVersion 이 없으면 요청 상수로 떨어진다", () => {
    // 폴백은 있어야 한다 — 여기서 빈 값을 내면 감사 기록이 통째로 비고,
    // 그건 "모델을 못 남겼다"가 아니라 "이 자료엔 모델이 없다"로 읽힌다.
    expect(parseGeminiResponse(base, 12).model).toBe(GEMINI_PRIMARY_MODEL);
  });

  it("공백뿐인 modelVersion 은 값으로 치지 않는다", () => {
    expect(parseGeminiResponse({ ...base, modelVersion: "   " }, 12).model).toBe(
      GEMINI_PRIMARY_MODEL,
    );
  });

  it("modelVersion 이 문자열이 아니면 무시한다", () => {
    expect(parseGeminiResponse({ ...base, modelVersion: 42 }, 12).model).toBe(
      GEMINI_PRIMARY_MODEL,
    );
  });
});
