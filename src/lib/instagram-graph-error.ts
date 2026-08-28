/**
 * Meta Graph `business_discovery`(BD) 실패의 **분류 SSOT** + 폴백 계측.
 *
 * 왜 분류가 필요한가: 수동 채널정보 갱신은 무료 공식 API(Graph BD)를 1순위로,
 * 유료 Apify 스크래퍼를 폴백으로 쓴다. 그런데 BD 실패는 성질이 두 갈래로 갈린다.
 *
 *  - **셀러별(per-seller)**: 개인계정(BD는 비즈니스·크리에이터만 조회 가능)·미존재
 *    핸들·비공개. 이건 그 셀러 하나만의 문제라 Apify 폴백이 정확히 맞는 처방이다.
 *  - **전역(global)**: 토큰 만료·권한 박탈·호출 한도 초과·Meta 장애. 이건 **모든**
 *    셀러에서 똑같이 터진다. 여기서 폴백하면 갱신을 누를 때마다 유료 호출이 나가
 *    무료 크레딧이 통째로 탄다 — 이 프로젝트의 실제 병목이 크레딧이라 치명적이다.
 *
 * 그래서 판정 방향을 못 박는다: **전역 실패 클래스를 명시 목록으로 막고, 나머지를
 * 폴백 대상으로 본다.** 반대로 짜면(= 계정 에러 화이트리스트) 목록에 없는 계정
 * 에러에서 그 셀러가 영영 갱신 불가가 된다 — 사용자 트리거 경로라 더 나쁘다.
 * 이 방향의 최악은 "미지의 전역 에러에서 유료 호출 1건"이고, 수동 갱신은 셀러
 * 1명씩 누르는 경로라 스탬피드가 아니다.
 *
 * ⚠️ HTTP 상태만 보고 판정하지 말 것. Graph 는 토큰 만료도 계정 에러도 대부분
 * **HTTP 400** 으로 내려보내고 구분은 본문 `error.code` 에만 있다.
 */
import { getPrisma } from "@/lib/prisma";
import { truncateReason } from "@/lib/seller-analysis/apify-comment-usage";

/** BD 실패의 성질. `account` 만 Apify 폴백 대상이다. */
export type GraphBdFailureKind =
  /** 조회 **대상 계정**의 문제 — 개인계정·미존재·비공개. 셀러별이라 폴백이 맞는 처방 */
  | "account"
  /** **우리 쪽 자격증명** 문제 — 토큰 만료·권한. 전역이라 폴백 금지(토큰을 갱신해야 풀린다) */
  | "auth"
  /** 호출 한도. 전역이고 시간이 지나면 무료로 풀린다 — 돈으로 때우면 안 된다 */
  | "rate_limit"
  /** Meta 5xx·네트워크 등 일시 장애. 전역이고 재시도가 무료다 */
  | "transient";

export type GraphBdFailure = {
  kind: GraphBdFailureKind;
  /** Apify 폴백 대상인가 — `kind === "account"` 와 동치(호출부가 조건을 재구성하지 않도록 노출) */
  shouldFallback: boolean;
  /** Graph `error.code` (본문에 없으면 null) */
  code: number | null;
  /** Graph `error.error_subcode` (없으면 null) */
  subcode: number | null;
  /** 사람이 읽는 사유 — 본문 message 우선, 없으면 HTTP 상태 */
  message: string;
};

/**
 * 자격증명·권한 실패 코드. 전부 **토큰을 고쳐야** 풀리는 것들이라 폴백 대상이 아니다.
 *  3=앱이 이 기능 권한 없음 · 10=권한 없음 · 102=세션 만료 · 190=OAuth 토큰 무효/만료 ·
 *  200=권한 오류 · 2500=유효한 액세스 토큰 필요
 */
const AUTH_CODES = new Set([3, 10, 102, 190, 200, 2500]);

/** 호출 한도 코드. 4=앱 한도 · 17=사용자 한도 · 32=페이지 한도 · 613=API 한도 */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/**
 * Instagram 플랫폼 전용 한도는 80000 번대에 몰려 있다(80001 이후로 계속 추가됨).
 * 개별 열거는 새 코드가 나올 때마다 조용히 폴백으로 새므로 **구간**으로 막는다.
 */
const IG_RATE_LIMIT_MIN = 80000;
const IG_RATE_LIMIT_MAX = 80999;

function pickInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * BD 응답(성공 파싱 실패 포함)을 실패 종류로 분류한다. **순수 함수 — 단위테스트 대상.**
 *
 * `httpStatus` 가 2xx 인데도 부를 수 있다: BD 는 페이로드에 `business_discovery` 를
 * 아예 안 실어 보내는 경우가 있어(200 + 빈 본문) 그것도 계정 문제로 다뤄야 한다.
 */
export function classifyGraphBdFailure(input: { httpStatus: number; body: unknown }): GraphBdFailure {
  const { httpStatus, body } = input;
  const error =
    body && typeof body === "object" && "error" in body && (body as Record<string, unknown>).error &&
    typeof (body as Record<string, unknown>).error === "object"
      ? ((body as Record<string, unknown>).error as Record<string, unknown>)
      : null;

  const code = pickInt(error?.code);
  const subcode = pickInt(error?.error_subcode);
  const rawMessage = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : null;
  const message = rawMessage
    ? `${rawMessage} (code ${code ?? "?"}${subcode != null ? `/${subcode}` : ""})`
    : `HTTP ${httpStatus}`;

  const kind = resolveKind(httpStatus, code);
  return { kind, shouldFallback: kind === "account", code, subcode, message };
}

function resolveKind(httpStatus: number, code: number | null): GraphBdFailureKind {
  // 본문 코드가 최우선 — Graph 는 토큰 만료도 한도 초과도 HTTP 400 으로 내려보낸다.
  if (code != null) {
    if (AUTH_CODES.has(code)) return "auth";
    if (RATE_LIMIT_CODES.has(code)) return "rate_limit";
    if (code >= IG_RATE_LIMIT_MIN && code <= IG_RATE_LIMIT_MAX) return "rate_limit";
  }
  // 코드가 없거나 미지일 때의 HTTP 보정. 401/403 은 자격증명, 429 는 한도, 5xx 는 일시 장애 —
  // 셋 다 전역이라 폴백하지 않는 쪽이 안전하다.
  if (httpStatus === 401 || httpStatus === 403) return "auth";
  if (httpStatus === 429) return "rate_limit";
  if (httpStatus >= 500) return "transient";
  // 나머지(대표적으로 code 100 = Invalid parameter, 200 OK + 빈 페이로드)는 대상 계정 문제로 본다.
  return "account";
}

/** `ApiCallLog.permissionScope` 판별자 — 폴백 조회가 이 값으로 인덱스를 탄다. */
export const GRAPH_BD_SCOPE = "instagram_bd_fallback";

/** `ApiCallLog.provider` — 기존 규약(provider=플랫폼, permissionScope=경로) 준수 */
export const GRAPH_BD_PROVIDER = "INSTAGRAM";

/** `ApiCallLog.endpoint` — 호스트·쿼리(=토큰) 없는 경로 라벨 */
export const GRAPH_BD_ENDPOINT = "/graph/business_discovery";

/**
 * BD 실패 1건 = `ApiCallLog` 1행. **폴백했든 안 했든 남긴다**(P0 No Silent Failure).
 *
 * 성공은 기록하지 않는다 — 이 계측이 답해야 할 질문은 "무료 경로가 언제·왜 못 했고
 * 그때 돈이 나갔는가" 하나이고, 성공까지 넣으면 수동 갱신 1회마다 1행이 쌓인다.
 * 계측이 본 작업을 깨뜨리면 안 되므로 쓰기 실패는 콘솔로만 표면화한다
 * (`instagram-collector` 의 `logApiCall` 과 동일 규약).
 */
export async function recordGraphBdFailure(params: {
  sellerId: string;
  handle: string;
  httpStatus: number;
  failure: GraphBdFailure;
  /** 실제로 Apify 유료 경로로 넘어갔는가 = **지출 발생 여부** */
  fellBack: boolean;
  /** 폴백했다면 Apify 런 ID(사후 대조용). 폴백 안 했으면 null */
  apifyRunId?: string | null;
  /** 폴백을 시도했지만 실패한 사유(토큰 미설정·액터 실행 실패). 정상이면 null */
  fallbackError?: string | null;
}): Promise<void> {
  const { sellerId, handle, httpStatus, failure, fellBack, apifyRunId = null, fallbackError = null } = params;
  try {
    await getPrisma().apiCallLog.create({
      data: {
        provider: GRAPH_BD_PROVIDER,
        permissionScope: GRAPH_BD_SCOPE,
        endpoint: GRAPH_BD_ENDPOINT,
        statusCode: httpStatus,
        success: false,
        errorMessage: truncateReason(failure.message),
        metadata: JSON.stringify({
          sellerId,
          handle,
          kind: failure.kind,
          code: failure.code,
          subcode: failure.subcode,
          /** 분류기가 폴백해도 된다고 봤는가(= 계정 문제) */
          shouldFallback: failure.shouldFallback,
          /** 실제 유료 호출이 나갔는가 — `shouldFallback` 과 갈라지면 토큰 미설정·액터 실패 */
          fellBack,
          apifyRunId,
          fallbackError: fallbackError ? truncateReason(fallbackError) : null,
        }),
      },
    });
  } catch (err) {
    console.error("[instagram-graph-error] 폴백 계측 기록 실패(수집 자체는 영향 없음):", err);
  }
}
