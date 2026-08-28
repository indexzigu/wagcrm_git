/**
 * 캠페인 PATCH 클라이언트 요청 SSOT.
 *
 * `PATCH /api/campaigns/[id]` 와 `PATCH /api/campaigns/[id]/settlement-status` 는
 * 저장 도중 그룹 멤버 구성이 바뀌면 **409** 를 반환한다(낙관적 동시성 제어 —
 * 라우트가 멤버십 스냅샷을 재확인하고 어긋나면 트랜잭션을 통째로 버린다).
 * 이 409 는 "저장 실패"가 아니라 **"다시 누르면 되는 상태"**다.
 *
 * ⛔ 호출처에서 `fetch("/api/campaigns/...", { method: "PATCH" })` 를 직접 쓰지 말 것.
 * 실사고(2026-08-07 전수조사): 8개 파일 17개 호출처가 전부 `if (!response.ok)` 만
 * 검사해 일반 실패 토스트를 띄웠고, 재시도 안내가 사용자에게 **한 곳도** 닿지
 * 않았다. 분기를 호출처마다 복사하면 같은 상태가 다시 갈라진다.
 * 재유입은 `campaign-patch.contract.test.ts` 의 소스 전수 스캔이 막는다.
 */

/**
 * 그룹 멤버십 충돌(409) 안내 — 문구 정본. 호출처에서 다시 적지 말 것.
 *
 * 문구 판정 근거(ss-ux-designer 검토 2026-08-07):
 * - **"다른 곳에서"를 쓰지 않는다** — 이 레포는 운영자 1인 도구라 충돌 주체는 대개
 *   본인의 다른 탭이다. 타인이 개입한 것처럼 읽히는 프레이밍은 부정확하다. 주체를
 *   특정하지 않고 시점("방금")만 알린다.
 * - **"해주세요"(붙여쓰기)** — 레포 실측 96건 vs 26건으로 붙여쓰기가 다수파다.
 * - **`toast.error` 로 띄운다** — 이 레포의 severity 분류는 "사전 차단=warning /
 *   시도 후 실패=error"이고, 409 는 PATCH 를 실제로 보낸 뒤 서버가 커밋을 버린
 *   것이라 후자다(선례: `campaign-group-join-toast.tsx`).
 */
export const CAMPAIGN_GROUP_CONFLICT_MESSAGE =
  "그룹 구성이 방금 바뀌었습니다. 다시 시도해주세요.";

/** 응답 본문의 error 를 못 읽었을 때 쓰는 기본 문구. */
const DEFAULT_FALLBACK_ERROR = "저장 실패";

/** fetch 자체가 던졌을 때(오프라인·중단 등) 쓰는 문구. */
const DEFAULT_NETWORK_ERROR = "네트워크 오류";

export type CampaignPatchResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** 사용자에게 그대로 보여도 되는 한국어 문구. 409 면 위 상수가 들어온다. */
      error: string;
      /** 응답을 못 받았으면 0. */
      status: number;
      /** 그룹 멤버십 충돌 여부 — 재시도 안내를 다르게 붙이고 싶을 때만 본다. */
      conflict: boolean;
    };

export type CampaignPatchOptions = {
  /** 409 가 아닌 실패에 쓸 문구. */
  fallbackError?: string;
  /** fetch 가 던졌을 때 쓸 문구. */
  networkError?: string;
  /**
   * 409 가 아닌 실패에서 응답 본문의 `error` 를 그대로 문구로 쓸지 여부(기본 false).
   *
   * ⚠️ 이 라우트의 오류 본문은 **영문**이고(`"Campaign not found"` ·
   * `"Drop reason is required"`) zod 실패 시엔 문자열도 아니다. 그래서 기본값은
   * `fallbackError` 다 — 켜는 곳은 종전부터 서버 문구를 노출하던 호출처뿐이며,
   * 동작 보존이 목적이다. 새 호출처에서 켜지 말 것.
   */
  preferServerError?: boolean;
};

async function requestCampaignPatch<T>(
  url: string,
  body: unknown,
  {
    fallbackError = DEFAULT_FALLBACK_ERROR,
    networkError = DEFAULT_NETWORK_ERROR,
    preferServerError = false,
  }: CampaignPatchOptions = {},
): Promise<CampaignPatchResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: networkError, status: 0, conflict: false };
  }

  if (!response.ok) {
    // 409 는 라우트 본문의 영문 문구("Campaign group membership changed; retry the
    // update")를 그대로 쓰면 안 된다 — 오너 대면 문구는 한국어 상수가 정본이다.
    if (response.status === 409) {
      return {
        ok: false,
        error: CAMPAIGN_GROUP_CONFLICT_MESSAGE,
        status: 409,
        conflict: true,
      };
    }
    let message = fallbackError;
    if (preferServerError) {
      const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error) message = payload.error;
    }
    return { ok: false, error: message, status: response.status, conflict: false };
  }

  const data = (await response.json().catch(() => null)) as T;
  return { ok: true, data };
}

/** `PATCH /api/campaigns/[id]` — 캠페인 필드 수정. */
export function patchCampaign<T>(
  campaignId: string,
  body: unknown,
  options?: CampaignPatchOptions,
): Promise<CampaignPatchResult<T>> {
  return requestCampaignPatch<T>(`/api/campaigns/${campaignId}`, body, options);
}

/** `PATCH /api/campaigns/[id]/settlement-status` — 정산 입금/지급 처리(그룹 전파). */
export function patchCampaignSettlementStatus<T>(
  campaignId: string,
  body: unknown,
  options?: CampaignPatchOptions,
): Promise<CampaignPatchResult<T>> {
  return requestCampaignPatch<T>(`/api/campaigns/${campaignId}/settlement-status`, body, options);
}
