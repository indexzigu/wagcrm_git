/**
 * Gemini 이미지 생성 클라이언트 — 촬영 컷 시안 전용.
 *
 * ⚠️ **텍스트와 엔드포인트가 다르다.** 텍스트는 `/v1beta/models/<id>:generateContent`
 * 이고 이미지는 **`/v1beta/interactions`** 다(SDK `interactions.create`). 이 레포엔
 * 이미 그 표면을 쓰는 선례가 있다(`seller-analysis/gemini.ts`) — 같은 패턴을 따른다.
 *
 * 키 로테이션과 실패 계측은 **기존 것을 그대로 재사용**한다:
 * `withGeminiKeyRotation` 이 429/503/5xx 에서 다음 키로 넘기고, 종국 실패는
 * `recordGeminiFailure` 가 `ApiCallLog` 에 남긴다(#215). 표면이 다르므로
 * `surface: "interactions"` 를 붙여 **어느 경로가 죽었는지** 가른다.
 *
 * 모델·규격은 추측하지 않았다 — 설치된 SDK 타입(`node_modules/@google/genai`)에서
 * 확인한 값이다. 특히 `image_size` 는 **`"512"`** 이지 `"512px"` 가 아니다
 * (`ImageResponseFormatImageSize = "512" | "1K" | "2K" | "4K"`).
 */
import { GoogleGenAI } from "@google/genai";
import {
  withGeminiKeyRotation,
  GeminiClientError,
} from "@/lib/agent/gemini-client";
import { recordGeminiFailure, truncateGeminiReason } from "@/lib/agent/gemini-usage";
import { GEMINI_IMAGE_MODEL } from "@/lib/gemini-model";
import {
  SKETCH_ASPECT_RATIO,
  SKETCH_IMAGE_SIZE,
  SKETCH_MIME_TYPE,
} from "@/lib/guide-sketch";

const clientFor = (apiKey: string) => new GoogleGenAI({ apiKey });

/** 이미지 1장의 생성 결과. */
export type GeneratedImage = {
  bytes: ArrayBuffer;
  mimeType: string;
};

/**
 * SDK 응답에서 이미지 바이트를 꺼낸다.
 *
 * ⚠️ **모양이 어긋나면 조용히 넘어가지 않는다**(P0 No Silent Failure) — 빈 이미지를
 * 저장하면 프레임에 깨진 그림이 박히고 원인 추적이 불가능해진다. SDK 타입상
 * `output_image` 는 `{ type:"image", data?: string(base64), uri?: string }` 이다.
 *
 * `data`(base64)가 정본인 근거는 **요청 파라미터가 아니라 서버 기본 동작**이다 —
 * ⛔ 종전 서술 *"`delivery:"inline"` 을 요청했으므로"* 는 **SUPERSEDED**(2026-08-01,
 * #231): 그 파라미터는 서버가 `400 Image delivery mode is not supported` 로 거부해
 * 제거했고, 제거 후 실호출에서 `data` 로 base64 가 그대로 왔다(image/jpeg 156KB).
 * `uri` 갈래는 이 코드가 쓰지 않는다 — 외부 URI 는 만료성이라 초안과 함께 보존되지
 * 않는다(레퍼런스 썸네일을 우리 스토리지로 재호스팅하는 이유와 같다).
 */
export function extractInlineImage(response: unknown): GeneratedImage {
  const image = (response as { output_image?: { data?: unknown; mime_type?: unknown } })
    ?.output_image;
  const data = image?.data;
  if (typeof data !== "string" || data.length === 0) {
    throw new GeminiClientError(
      "Gemini 이미지 응답에 inline 데이터가 없습니다(output_image.data 부재)",
    );
  }
  const buf = Buffer.from(data, "base64");
  if (buf.byteLength < 100) {
    throw new GeminiClientError(
      `Gemini 이미지 응답 바이트가 비정상입니다(${buf.byteLength}B)`,
    );
  }
  const mimeType =
    typeof image?.mime_type === "string" && image.mime_type.startsWith("image/")
      ? image.mime_type
      : SKETCH_MIME_TYPE;
  return {
    bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    mimeType,
  };
}

/**
 * 스케치 1장을 생성한다. 실패는 **던진다** — 호출부가 컷 단위로 잡아 나머지를
 * 계속 그린다(시안 하나가 실패했다고 전체가 무산되면 안 된다).
 */
export async function generateSketchImage(prompt: string): Promise<GeneratedImage> {
  const startedAt = Date.now();
  try {
    const response = await withGeminiKeyRotation(
      (apiKey) =>
        clientFor(apiKey).interactions.create({
        model: GEMINI_IMAGE_MODEL,
        input: [{ type: "user_input", content: [{ type: "text", text: prompt }] }],
        response_format: {
          type: "image",
          mime_type: SKETCH_MIME_TYPE,
          // ⛔ `delivery` 를 보내지 않는다 — SDK 타입에는 `"inline" | "uri"` 가 있지만
          // 서버가 **`400 Image delivery mode is not supported`** 로 거부한다(prod 실측
          // 2026-08-01, 5회 전량). 타입에 있다고 런타임에 되는 것이 아니다.
          // 기본 동작이 base64 인라인이라(`output_image.data`) 우리 요구와 일치한다.
          aspect_ratio: SKETCH_ASPECT_RATIO,
          image_size: SKETCH_IMAGE_SIZE,
        },
        } as Parameters<GoogleGenAI["interactions"]["create"]>[0]),
      // 라벨을 넘기지 않으면 이미지 실패가 텍스트 모델로 기록된다(위 실사고).
      { model: GEMINI_IMAGE_MODEL, surface: "interactions" },
    );
    return extractInlineImage(response);
  } catch (err) {
    // `withGeminiKeyRotation` 은 **키 소진·HTTP 실패**를 이미 계측한다. 여기서 남기는
    // 것은 그 뒤 단계(응답 모양 이상)의 실패다 — 둘을 겹쳐 세지 않도록 종류를 나눈다.
    if (err instanceof GeminiClientError && err.status === undefined) {
      await recordGeminiFailure({
        kind: "HTTP",
        model: GEMINI_IMAGE_MODEL,
        surface: "interactions",
        statusCode: 200,
        keysTried: 1,
        lastKeyFingerprint: null,
        elapsedMs: Date.now() - startedAt,
        reason: truncateGeminiReason(err),
      });
    }
    throw err;
  }
}
