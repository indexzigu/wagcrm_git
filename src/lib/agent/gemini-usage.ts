/**
 * Gemini 호출 **종국 실패** 계측 — 실패 1회 = `ApiCallLog` 1행.
 *
 * 왜 필요한가(실사고 2026-08-01): Gemini 프로젝트가 **월 지출 상한을 초과**해
 * 모든 호출이 `429 RESOURCE_EXHAUSTED` 로 죽어 있었는데, 레포 어디에도 신호가
 * 없었다. `ApiCallLog` 최근 10일 기록은 NAVER 6행·INSTAGRAM 2행뿐이고 Gemini 는
 * **0행**이었다 — 계측이 애초에 없었기 때문이다. 그래서 운영자가 버튼을 눌러
 * 실패를 눈으로 보기 전까지 아무도 모르고, 시스템 레이더도 초록이다.
 * 이 침묵이 닫으려는 대상이다.
 *
 * 죽는 표면은 콘텐츠 가이드 하나가 아니다 — 검색 키워드 추출 · 셀러 분석 ·
 * 아웃리치 메시지 · 어시스턴트 · VOC 인사이트 · 가격표 추출 · 클레임 추출이
 * 전부 같은 클라이언트를 탄다.
 *
 * ⚠️ **실패만 남긴다 — 성공한 개별 호출은 절대 행으로 만들지 않는다**(P7
 * 「Naver Call Observability」와 같은 규율). `dashboard-data.ts` 가 `ApiCallLog`
 * 를 **provider 무관 `take: 20`** 으로 읽어 UI 3곳(Meta 증빙 페이지의 「최근 API
 * 로그」 표 · 캠페인 사이드패널 · 정산 패널)에 그대로 뿌린다. 어시스턴트·콘텐츠
 * 가이드(레이싱 2발)는 고볼륨이라 성공 행을 남기면 상위 20을 점거해 **Meta App
 * Review 증빙 표에서 Instagram 행이 사라진다.** 성공 계측이 필요해지면 행이
 * 아니라 요약 1행(오퍼레이션 단위) 방식을 쓸 것 — 개별 행으로 되살리지 말 것.
 *
 * ⚠️ **키를 절대 저장하지 않는다**(P0). Gemini 요청 URL 은 `?key=<원문>` 이므로
 * `endpoint` 는 **호스트·쿼리 없는 경로 라벨**만 쓰고, 어느 키가 죽었는지가
 * 필요하면 비가역 지문(sha256 앞 6자)만 남긴다. 응답 본문에도 키가 섞여 들어올
 * 수 있어 `redactGeminiSecrets` 로 한 겹 더 지운다. 계약은
 * `gemini-usage.contract.test.ts` 가 기계로 강제한다.
 */
import { createHash } from "node:crypto";
import { getPrisma } from "@/lib/prisma";

/** `ApiCallLog.permissionScope` 판별자 — 집계 쿼리가 이 값으로 인덱스를 탄다. */
export const GEMINI_SCOPE = "gemini_generate";

/**
 * `ApiCallLog.provider`. `ApiProvider` 유니온(INSTAGRAM/YOUTUBE/NAVER/INTERNAL)
 * 중 Gemini 는 외부 SNS 플랫폼이 아니라 내부 AI 경로라 `INTERNAL` 이다.
 * 유니온에 값을 늘리면 `dashboard-data.ts` 의 캐스트·필터가 함께 흔들린다.
 */
export const GEMINI_PROVIDER = "INTERNAL";

/** HTTP 응답을 받기 전에 끝난 호출(키 미설정·네트워크 오류)의 statusCode 규약. */
export const NO_HTTP_RESPONSE = 0;

/**
 * 실패의 종류. 사후에 "상한 초과인가 · 배선 문제인가 · 네트워크인가"를 가른다.
 * - `NO_KEYS` 키가 서버에 아예 없음(배포 설정 사고)
 * - `NETWORK` 응답 전 실패(타임아웃·DNS 등)
 * - `HTTP` 응답은 받았고 4xx/5xx (429 지출 상한이 여기 온다)
 * - `KEYS_EXHAUSTED` 모든 키가 재시도 대상 오류로 소진
 */
export type GeminiFailureKind =
  | "NO_KEYS"
  | "NETWORK"
  | "HTTP"
  | "KEYS_EXHAUSTED";

export type GeminiFailure = {
  kind: GeminiFailureKind;
  /** 주모델 SSOT 값. 모델별 상한·장애를 가르는 데 쓴다. */
  model: string;
  /** 호출 표면. 생략하면 텍스트(`generateContent`)로 본다. */
  surface?: GeminiSurface;
  /** HTTP 상태. 응답 전 실패는 `NO_HTTP_RESPONSE`(0). */
  statusCode: number;
  /** 시도한 키 개수(로테이션이 실제로 돌았는지). 키 **값**이 아니다. */
  keysTried: number;
  /** 마지막으로 쓴 키의 **지문**(비가역). 어느 키가 죽었는지 추적용. */
  lastKeyFingerprint: string | null;
  /** 호출 시작부터 포기까지. 타임아웃 판별용. */
  elapsedMs: number;
  /** 실패 사유(응답 본문 앞부분). 저장 전 반드시 redact·truncate 를 거친다. */
  reason: string;
};

/**
 * 키의 비가역 식별자 — sha256 앞 6자. 원문 복원 불가라 로그에 남겨도 안전하다.
 * 로테이션 풀에서 어느 키가 소진됐는지 사후 추적하는 용도.
 */
export function describeGeminiKey(key: string | undefined | null): string | null {
  if (!key) return null;
  return createHash("sha256").update(key).digest("hex").slice(0, 6);
}

/**
 * 문자열에서 키로 보이는 것을 지운다(심층 방어).
 *
 * 우리가 만드는 `endpoint` 에는 키를 넣지 않지만, **오류 본문은 우리가 만들지
 * 않는다** — 프록시·게이트웨이가 요청 URL 을 그대로 에코하는 경우가 있어
 * `?key=…` 가 섞여 들어올 수 있다. 한 번이라도 섞이면 public 레포 이슈·스크린샷
 * 경로로 새므로 저장 직전에 지운다.
 */
export function redactGeminiSecrets(text: string): string {
  return text
    .replace(/([?&](?:key|api_?key)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "[REDACTED]");
}

/** 사유 문자열 정규화 — redact → 개행 접기 → 상한(본문 통째 유입 방지). */
export function truncateGeminiReason(raw: unknown, max = 300): string {
  const text =
    raw instanceof Error ? raw.message : typeof raw === "string" ? raw : String(raw ?? "");
  const folded = redactGeminiSecrets(text).replace(/\s+/g, " ").trim();
  return folded.length > max ? `${folded.slice(0, max)}…` : folded;
}

/**
 * Gemini 의 호출 표면. **경로가 다르다** — 텍스트는 `/v1beta/models/<id>:generateContent`,
 * 이미지·구조화 출력은 `/v1beta/interactions`. 계측이 한쪽 경로를 하드코딩하면
 * 이미지 실패가 텍스트 실패처럼 기록돼 "어디가 죽었나"를 못 가른다.
 */
export type GeminiSurface = "generateContent" | "interactions";

/**
 * 경로 라벨 — 호스트·쿼리(=키) 없이 표면과 모델만. 실제 요청 URL 을 쓰지 말 것.
 */
export function geminiEndpointLabel(
  model: string,
  surface: GeminiSurface = "generateContent",
): string {
  return surface === "interactions"
    ? `POST /interactions (${model})`
    : `POST /models/${model}:generateContent`;
}

/**
 * `ApiCallLog.metadata` 에 담을 객체(순수 — 단위테스트 대상).
 * **키를 늘릴 때는 시크릿이 아닌지 먼저 확인할 것**(P0).
 */
export function buildGeminiFailureMetadata(failure: GeminiFailure) {
  return {
    kind: failure.kind,
    model: failure.model,
    surface: failure.surface ?? "generateContent",
    keysTried: failure.keysTried,
    lastKeyFingerprint: failure.lastKeyFingerprint,
    elapsedMs: failure.elapsedMs,
    /**
     * 지출 상한·쿼터 소진 여부. 429 는 "잠깐 몰렸다"와 "이번 달 예산이 끝났다"가
     * 같은 코드라, 사유 문자열에서 상한 표현을 뽑아 따로 세운다 — 후자는 사람이
     * 결제 콘솔에서 풀어야 하고 재시도로는 절대 낫지 않는다.
     */
    spendCapSuspected:
      failure.statusCode === 429 && /spending cap|quota|RESOURCE_EXHAUSTED/i.test(failure.reason),
  };
}

/**
 * 종국 실패를 `ApiCallLog` 에 영속한다. **성공에는 부르지 않는다**(위 볼륨 규율).
 *
 * 계측이 본 작업을 깨뜨리면 안 되므로 쓰기 실패는 콘솔로만 표면화한다 —
 * 기존 수집기(`instagram-collector`)·`recordApifyCommentUsage` 와 동일한 규약.
 * 이 함수는 **절대 throw 하지 않는다**.
 */
export async function recordGeminiFailure(failure: GeminiFailure): Promise<void> {
  try {
    await getPrisma().apiCallLog.create({
      data: {
        provider: GEMINI_PROVIDER,
        permissionScope: GEMINI_SCOPE,
        endpoint: geminiEndpointLabel(failure.model, failure.surface),
        statusCode: failure.statusCode,
        // 이 모듈은 실패 전용이다 — 리터럴 false 를 변수로 바꾸지 말 것.
        success: false,
        errorMessage: truncateGeminiReason(failure.reason),
        metadata: JSON.stringify(buildGeminiFailureMetadata(failure)),
      },
    });
  } catch (err) {
    console.error("[gemini-usage] 계측 기록 실패(호출 자체는 영향 없음):", err);
  }
}
