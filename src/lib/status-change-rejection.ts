import { dealStatusLabels, taskStatusLabels, type DealStatus } from "@/lib/crm-types";
import { DEFAULT_MUTATION_ERROR } from "@/lib/use-mutation-feedback";

/**
 * 상태 변경 실패 → 오너에게 보일 토스트 문구. 딜·영업 테스크 PATCH 의 실패 본문을 받아 만든다.
 *
 * 왜 따로 두나: 서버가 상태 전이를 거절(422)해도 종전 화면은 사유를 버렸다 — 딜 패널은 영문
 * "Save failed", 영업 화면은 「상태 변경에 실패했습니다.」만 띄웠다. 거절은 대개 화면이 가진
 * 상태가 낡았을 때(봇·다른 탭이 먼저 바꿈) 생기므로, 현재 상태는 **서버가 읽어 실어 준 코드**
 * (`currentStatus`·`requestedStatus`)를 쓴다. 화면 상태로 문장을 만들면 틀린 현재 상태를 말한다.
 *
 * ⛔ 서버 `error` 문장을 거절 사유로 그대로 내지 말 것 — 영업 쪽 문장에는 영문 코드가 들어 있다
 * (product-ux UI Copy ③). 코드는 라벨 표(딜 `dealStatusLabels`, 영업 `taskStatusLabels` —
 * 영업 관리 화면 단계 낱말과 같은 표)를 거친다. 표에 없는 코드(예: 영업의 옛 저장값 CONFIRMED)면
 * 코드를 내지 않고 일반 거절 문장을 쓴다.
 * ⛔ 검증 실패(400)의 `error` 는 문자열이 아니라 객체다 — 토스트에는 문자열만 넘긴다.
 */

export type StatusChangeFailure = {
  /** 토스트 제목(원인). */
  title: string;
  /** 토스트 둘째 줄(할 일). 없으면 화면의 기본 안내를 쓴다. */
  hint?: string;
};

/** 거절 코드가 표에 없을 때의 문장. */
export const STATUS_REJECTION_FALLBACK = "지금 상태에서는 그 단계로 바꿀 수 없습니다.";

/** 거절일 때의 할 일 — 기본 안내(「연결을 확인하고…」)는 거절과 맞지 않는다. */
export const STATUS_REJECTION_HINT = "화면을 새로고침해 지금 상태를 확인하세요.";

const OUTREACH_STATUS_CHANGE_ERROR = "상태 변경에 실패했습니다.";

function serverErrorText(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim() !== "") return error;
  }
  return null;
}

/** 실패 본문이 상태 전이 거절이면 서버가 실어 준 두 코드를, 아니면 null. 거절 판정은 여기 한 곳. */
function rejectionCodes(
  body: unknown,
): { currentStatus: string; requestedStatus: string } | null {
  if (!body || typeof body !== "object") return null;
  const { currentStatus, requestedStatus } = body as {
    currentStatus?: unknown;
    requestedStatus?: unknown;
  };
  if (typeof currentStatus !== "string" || typeof requestedStatus !== "string") return null;
  return { currentStatus, requestedStatus };
}

function describeRejection(
  body: unknown,
  labels: Readonly<Record<string, string>>,
): StatusChangeFailure | null {
  const codes = rejectionCodes(body);
  if (!codes) return null;
  const { currentStatus, requestedStatus } = codes;

  const from = Object.hasOwn(labels, currentStatus) ? labels[currentStatus] : null;
  const to = Object.hasOwn(labels, requestedStatus) ? labels[requestedStatus] : null;
  const title =
    from && to
      ? `지금 “${from}” 상태라 “${to}”(으)로 바꿀 수 없습니다.`
      : STATUS_REJECTION_FALLBACK;
  return { title, hint: STATUS_REJECTION_HINT };
}

/**
 * 딜 패널 전용 할 일 — 상태만 거절되고 같은 묶음의 다른 수정은 남겼을 때. 패널이 서버의 현재 상태를
 * 이미 반영했으므로 「새로고침」을 권하면 남겨 둔 수정을 버리게 된다(T-312).
 */
export const DEAL_REJECTION_KEPT_EDITS_HINT =
  "지금 상태를 화면에 반영했습니다. 나머지 수정은 다시 저장하세요.";

/**
 * 딜 PATCH 실패 본문이 상태 전이 거절인가. 거절이면 서버가 읽은 현재 상태를 돌려준다
 * (딜 상태 표에 없는 코드면 `currentStatus: null` — 화면에 반영하지 않는다). 거절이 아니면 null.
 */
export function dealStatusRejection(body: unknown): { currentStatus: DealStatus | null } | null {
  const codes = rejectionCodes(body);
  if (!codes) return null;
  const { currentStatus } = codes;
  return {
    currentStatus: Object.hasOwn(dealStatusLabels, currentStatus)
      ? (currentStatus as DealStatus)
      : null,
  };
}

/** 딜 PATCH(`/api/deals/[id]`) 실패 본문 → 토스트 문구. */
export function dealSaveFailure(body: unknown): StatusChangeFailure {
  return (
    describeRejection(body, dealStatusLabels) ?? {
      title: serverErrorText(body) ?? DEFAULT_MUTATION_ERROR,
    }
  );
}

// 영문 코드 모양 낱말(CONVERTED 등). 두 코드가 실리지 않은 거절 문장이 와도 코드를 내지 않는다.
const RAW_CODE_WORD = /\b[A-Z][A-Z_]{2,}\b/;

/** 영업 테스크 상태 PATCH(`/api/outreach/[id]`) 실패 본문 → 토스트 문구. */
export function outreachStatusChangeFailure(body: unknown): StatusChangeFailure {
  const rejection = describeRejection(body, taskStatusLabels);
  if (rejection) return rejection;
  const text = serverErrorText(body);
  return {
    title: text && !RAW_CODE_WORD.test(text) ? text : OUTREACH_STATUS_CHANGE_ERROR,
  };
}
