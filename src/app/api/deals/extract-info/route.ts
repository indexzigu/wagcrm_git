import { NextResponse } from "next/server";
import { parseStoreMetadata } from "@/lib/price-monitor/store-metadata";
import { GEMINI_LITE_MODEL } from "@/lib/gemini-model";
import {
  getGeminiApiKeys,
  isRetryableGeminiStatus,
} from "@/lib/agent/gemini-client";

export type CrawlStatus = {
  attempted: boolean;
  ok: boolean;
  httpStatus?: number;
  reason?: string;
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    // 버그①복구: 호출부(deals-panel.tsx SupplementaryInfoFields.handleExtractKeyword)는
    // supplementaryInfo JSON의 referenceUrl 값을 "url" 키로 보낸다. 이 API가 "referenceUrl"만
    // 구조분해하고 있어 항상 undefined → 크롤링이 no-op이었다. 두 키 모두 수용해 하위호환 유지.
    const { url, referenceUrl, brandName, dealName, partnerName, partnerType } = body;
    const targetUrl = url || referenceUrl;

    let storeTitle = "";
    let storeKeywords = "";
    let storeDescription = "";
    let ldProduct: ReturnType<typeof parseStoreMetadata>["ldProduct"] = null;

    // 1. URL이 제공된 경우 메타데이터 크롤링 (P1-2: 실패를 조용히 삼키지 않고 crawl에 노출한다)
    const crawl: CrawlStatus = { attempted: false, ok: false };

    if (targetUrl) {
      crawl.attempted = true;
      try {
        const response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          signal: AbortSignal.timeout(5000), // 5초 타임아웃
        });
        if (response.ok) {
          const html = await response.text();
          const metadata = parseStoreMetadata(html);
          storeTitle = metadata.storeTitle;
          storeKeywords = metadata.storeKeywords;
          storeDescription = metadata.storeDescription;
          ldProduct = metadata.ldProduct;
          crawl.ok = true;
        } else {
          crawl.ok = false;
          crawl.httpStatus = response.status;
          crawl.reason = `HTTP ${response.status}`;
          console.warn(`Failed to fetch reference URL (status ${response.status}):`, targetUrl);
        }
      } catch (err) {
        crawl.ok = false;
        crawl.reason = err instanceof Error ? err.message : "요청 실패(타임아웃/네트워크 오류)";
        console.warn("Failed to fetch reference URL:", err);
      }
    }

    // 2. AI 정제 프롬프트 생성 (P1-3: 모델명/변형 식별자 보존 규칙 + JSON 구조화 출력)
    const ldProductLines = ldProduct
      ? [
          `- JSON-LD 상품명: ${ldProduct.name || "없음"}`,
          `- JSON-LD 브랜드: ${ldProduct.brand || "없음"}`,
          `- JSON-LD 모델: ${ldProduct.model || "없음"}`,
          `- JSON-LD SKU: ${ldProduct.sku || "없음"}`,
        ]
      : ["- JSON-LD 상품 정보: 없음"];

    const prompt = `당신은 이커머스 최저가 비교 시스템의 검색어 추출기입니다.
우리의 목표는 시장(쿠팡, 네이버쇼핑)에서 이 딜과 '완전히 똑같은 상품'을 찾기 위해 가장 최적화된 "핵심 상품명(로우데이터)"과 "모델명(있는 경우)"을 도출하는 것입니다.

[제공된 데이터]
- 스토어 타이틀: ${storeTitle || "없음"}
- 스토어 키워드: ${storeKeywords || "없음"}
- 스토어 설명(og:description/meta description): ${storeDescription || "없음"}
${ldProductLines.join("\n")}
- CRM 브랜드명: ${brandName || "없음"}
- CRM 딜명: ${dealName || "없음"}
- 파트너사 이름: ${partnerName || "없음"} (${partnerType || "알 수 없음"})

[제약 조건]
1. 제조사/브랜드명과 핵심 상품 고유명사만 결합된 문자열을 만들어주세요. (예: "종근당 락토핏 골드")
2. 포장 단위(박스, 개, 통, 1+1 등), 용량(ml, g 등), 광고성 수식어(무료배송, 특가, 추천 등)는 절대 포함하지 마세요. 단위와 수량은 추후 검색 시스템에서 별도로 붙여 검색할 것입니다.
3. 모델명/모델코드(영숫자 혼합, 예: "PB-10000X", "AX58")와 변형·구성 식별자("3 in 1", "3-in-1", "미니", "프로" 등 제품 구분에 실제로 쓰이는 명칭)는 절대 제거하지 말고 보존하세요. 이런 식별자는 증정 행사 표기("1+1", "2+1")와 다릅니다 — 혼동하지 마세요.
   - 반례(O, 보존): "휴브론 3 in 1 무선고데기" → searchKeyword "휴브론 3 in 1 무선고데기" ("3 in 1"은 제품 구성을 나타내는 식별자이지 증정 행사가 아님)
   - 반례(X, 제거): "락토핏 1+1 특가" → "1+1"과 "특가"를 제거해 "락토핏"만 남긴다
4. JSON-LD의 model/sku 필드가 존재하면 modelName 필드에 그 값을 사용하세요. 없으면 상품명에서 명확한 모델코드를 추론하고, 그마저 없으면 null로 두세요.
5. 반드시 아래 JSON 형식으로만 응답하세요. 다른 설명/코드블록/따옴표 없이 순수 JSON 객체 한 개만 반환합니다.
{"searchKeyword": "추출된 핵심 상품명", "modelName": "모델명 또는 null"}`;

    // 3. Gemini API 호출 — 키 선택은 SSOT(getGeminiApiKeys)에 맡긴다.
    // 종전에는 여기서 `GEMINI_API_KEY || BACKUP_...` 로 직접 골라 3번째 키를
    // 못 쓰고 로테이션도 못 받았다(2026-07-30 수렴).
    const apiKeys = getGeminiApiKeys();
    const apiKey = apiKeys[0] ?? "";

    if (!apiKey) {
      return NextResponse.json({ error: "Gemini API 키가 서버에 설정되지 않았습니다. (.env 파일을 확인해주세요)" }, { status: 500 });
    }

    // 검색어 추천은 짧은 결정적 제안(단순작업) — 최저가 flash-lite로 수행한다.
    // flash-lite는 thinkingLevel 미지원이라 thinking 설정 없이 호출한다(비용 최소화).
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1, // 창의성 배제, 일관성 유지
        maxOutputTokens: 500,
        responseMimeType: "application/json",
      },
    };

    const callGemini = (model: string, key: string) =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }
      );

    let model = GEMINI_LITE_MODEL;
    let geminiRes = await callGemini(model, apiKey);

    // 한 계정이 월 상한(429)에 걸리면 같은 모델로 다음 키를 먼저 시도한다 —
    // 모델 사다리를 타기 전에 계정을 바꾸는 것이 비용·품질 모두 유리하다.
    for (let i = 1; i < apiKeys.length && isRetryableGeminiStatus(geminiRes.status); i++) {
      geminiRes = await callGemini(model, apiKeys[i]);
    }

    // 그래도 503이면 상위 모델로 1회 재시도(기존 사다리 유지)
    if (geminiRes.status === 503) {
      console.warn(`Gemini ${model} 503 error. Retrying with gemini-2.5-flash...`);
      model = "gemini-2.5-flash";
      geminiRes = await callGemini(model, apiKey);
    }

    if (!geminiRes.ok) {
      const errorText = await geminiRes.text();
      console.error("Gemini API Error:", errorText);

      let errorMessage = "검색어 추천 생성에 실패했습니다.";
      if (errorText.includes("API_KEY_INVALID") || errorText.includes("API key not valid")) {
        errorMessage = "Gemini API 키가 유효하지 않거나 만료되었습니다. .env 파일의 GEMINI_API_KEY 값을 확인해 주세요.";
      } else if (geminiRes.status === 400) {
        errorMessage = `잘못된 요청입니다. (상태코드: 400)`;
      } else if (geminiRes.status === 429 || errorText.includes("RESOURCE_EXHAUSTED")) {
        errorMessage = "Gemini API 크레딧 잔액이 부족하거나 한도를 초과했습니다. 구글 AI Studio에서 결제 상태를 확인해주세요.";
      } else if (geminiRes.status === 503) {
        errorMessage = "구글 AI 서버에 요청이 폭주하여 일시적으로 지연되고 있습니다. 잠시 후 다시 시도해주세요. (503)";
      }
      return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
    }

    const geminiData = await geminiRes.json();
    const candidate = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const rawText = candidate.trim().replace(/^["']|["']$/g, '');

    // Major 1 회귀 수정: responseMimeType: "application/json"을 지시해도 Gemini가(특히 503
    // 폴백 모델에서) "```json\n{...}\n```" 같은 마크다운 코드펜스로 감싸 반환하는 경우가 있다.
    // 펜스가 있으면 JSON.parse 전에 선행/후행 펜스(언어태그 포함)를 제거한다. 펜스가 없으면
    // 원문 그대로 사용(기존 동작 불변).
    const fenceStripped = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    // P1-3: JSON 구조화 출력 파싱. 파싱 실패 시 폴백 — 전체 텍스트를 searchKeyword로, modelName null
    // (기존 동작 보존 — Gemini가 responseMimeType 지시를 어기고 순수 텍스트만 반환하는 경우 대비).
    let searchKeyword = rawText;
    let modelName: string | null = null;
    try {
      const parsed = JSON.parse(fenceStripped);
      if (parsed && typeof parsed === "object" && typeof parsed.searchKeyword === "string") {
        searchKeyword = parsed.searchKeyword.trim();
        modelName =
          typeof parsed.modelName === "string" && parsed.modelName.trim() ? parsed.modelName.trim() : null;
      }
    } catch {
      // 비JSON 응답 — 폴백: 전체 텍스트(펜스 제거 전 원문)를 searchKeyword로, modelName null
    }

    return NextResponse.json({ success: true, searchKeyword, modelName, crawl });

  } catch (error) {
    console.error("[POST /api/deals/extract-info] Error:", error);
    return NextResponse.json({ error: "처리 중 서버 오류가 발생했습니다." }, { status: 500 });
  }
}
