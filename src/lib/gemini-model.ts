/**
 * Gemini 모델·thinking 티어 SSOT.
 *
 * 배경: 주모델 ID가 6개 호출부에 하드코딩돼 `2.5-flash`·`2.5-flash-lite`·`3.5-flash`가
 * 표류(drift)했다. 여기서 모델 문자열과 thinking 티어를 한 곳에 고정한다.
 * 각 호출부의 폴백 사다리(2차·3차 rung)는 그대로 유지한다(오너 지시 2026-07-24).
 *
 * 2단 티어(작업 성격 = 비용 배분):
 *  - REASONING(`GEMINI_PRIMARY_MODEL` + think:low) — 추론이 품질을 좌우하는 작업:
 *      도구호출 어시스턴트, 셀러 정성분석, 아웃리치 문구, 가격표 멀티모달 표 구조화.
 *      (오너 실측: `gemini-3.6-flash + think:low`가 가성비 정점)
 *  - LITE(`GEMINI_LITE_MODEL`, thinking 불요) — 단순·결정적 작업: 사업자등록증 OCR,
 *      검색어 추천. 최저가 flash-lite 티어로 비용을 바닥까지 내린다(오너 지시 2026-07-24).
 *      flash-lite는 thinkingLevel 파라미터를 받지 않으므로 thinking 설정 자체가 없다.
 *
 * thinkingLevel wire 표기는 API 표면마다 다르다(SDK 타입/컨버터로 검증, 추측 금지):
 *  - `generateContent`(raw REST v1beta + SDK `models.generateContent`):
 *      `...thinkingConfig.thinkingLevel` — SDK가 `ThinkingLevel` **enum**을 요구하고
 *      ToMldev 컨버터가 무변환 통과 → wire 값은 **대문자** "LOW".
 *  - `interactions.create`(SDK):
 *      `generation_config.thinking_level`(snake_case) — 소문자 유니온 → **소문자** "low".
 *  같은 "low" 개념이 표면마다 대/소문자가 갈린다 — 상수를 분리해 각 표면에 맞춘다.
 */

import { ThinkingLevel } from "@google/genai";

/** REASONING 티어 주모델 — 추론이 품질을 좌우하는 작업. think:low와 함께 쓴다. */
export const GEMINI_PRIMARY_MODEL = "gemini-3.6-flash";

/**
 * LITE 티어 — 단순·결정적 작업(사업자등록증 OCR·검색어 추천 등)의 최저가 모델.
 * flash-lite는 이 코드베이스에서 이미 검증됨(OCR 멀티모달 폴백 rung·extract-info 원 주모델).
 * 2.5 티어라 thinkingLevel을 받지 않는다 — 단순작업엔 thinking 자체가 불요.
 */
export const GEMINI_LITE_MODEL = "gemini-2.5-flash-lite";

/**
 * 이미지 생성 모델 — 촬영 컷 시안용(`interactions` 표면, `/v1beta/models/...` 아님).
 *
 * `gemini-3.1-flash-lite-image` 가 장당 더 싸지만(약 $0.034 vs $0.045) **512px·9:16
 * 지원이 공식 문서에 명시돼 있지 않다.** 시안은 세로 비율과 최소 해상도가 곧 비용·용도
 * 적합성이라, 규격이 문서로 확인된 쪽을 택했다. lite 의 규격 지원이 확인되면 그때
 * 바꾼다(모델만 교체하면 되게 호출부는 이 상수만 본다).
 */
export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

// --- generateContent 표면(raw REST + SDK models.generateContent): enum 이름(대문자) ---
export const GEMINI_THINK_LOW = ThinkingLevel.LOW; // "LOW"

// --- interactions.create 표면: 소문자 유니온 ---
export const GEMINI_THINK_LOW_INTERACTION = "low" as const;
