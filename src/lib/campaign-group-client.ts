/**
 * CG-1 캠페인 그룹 — 클라이언트 API 헬퍼 + 세션 억제 유틸.
 *
 * 4개 UI 표면(조합 다이얼로그 ⓐ · 합류 제안 ⓑ · 사이드패널 그룹 섹션 ⓒ · 카드 배지 ⓓ)이
 * 공유하는 fetch/억제/라벨 로직의 단일 정본. 순수 함수 + fetch 래퍼만 두어 컴포넌트에서
 * 재사용·테스트가 쉽도록 한다.
 *
 * 불변식(UI 스펙 §3): groupId는 오직 campaign-groups 라우트로만 바뀐다.
 * 여기서는 `PATCH /api/campaigns/[id]`를 절대 호출하지 않는다.
 */

import type {
  CampaignGroupDetailRow,
  CampaignGroupRow,
} from "./crm-types";

// ---------------------------------------------------------------------------
// 세션 억제(합류 제안 nag 방지, UI 스펙 §2)
// ---------------------------------------------------------------------------
//
// CG-1 스키마에는 "다시 제안 안 함"을 담을 영속 필드가 없다(blueprint §1.2).
// 세션 억제 + 이벤트 기반 트리거로 CG-1의 nag는 충분히 막힌다. 영속 억제는 CG-2.

const DISMISS_PREFIX = "cg1:dismiss:";

export function suggestionDismissKey(campaignId: string, groupId: string): string {
  return `${DISMISS_PREFIX}${campaignId}:${groupId}`;
}

export function isSuggestionDismissed(campaignId: string, groupId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.sessionStorage.getItem(suggestionDismissKey(campaignId, groupId)) === "1"
    );
  } catch {
    // sessionStorage 접근 불가(프라이빗 모드 등) — 억제 없이 진행(비차단).
    return false;
  }
}

export function dismissSuggestion(campaignId: string, groupId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(suggestionDismissKey(campaignId, groupId), "1");
  } catch {
    // 비차단 — 억제 저장 실패해도 흐름을 막지 않는다.
  }
}

// ---------------------------------------------------------------------------
// 표기 헬퍼
// ---------------------------------------------------------------------------

/**
 * 그룹 표시명. 서버가 자동/수동 이름을 `name`에 넣지만(D4), 방어적으로 null일 때
 * 셀러 라벨 기반 폴백을 쓴다(전 표면 셀러 별칭 우선은 서버 매핑이 이미 해결).
 */
export function formatGroupLabel(
  group: Pick<CampaignGroupRow, "name" | "sellerName">,
): string {
  const trimmed = group.name?.trim();
  if (trimmed) return trimmed;
  return group.sellerName ? `${group.sellerName} 그룹` : "이름 없는 그룹";
}

// ---------------------------------------------------------------------------
// API 래퍼
// ---------------------------------------------------------------------------

export type SuggestParams = {
  sellerId: string;
  startDate: string;
  endDate: string;
  excludeCampaignId?: string;
};

/** 합류 후보(기존 그룹) 조회 — 동일 셀러·기간 포락선 겹침. 세션 억제 미적용(원본). */
export async function fetchGroupSuggestions(
  params: SuggestParams,
): Promise<CampaignGroupRow[]> {
  const search = new URLSearchParams({
    sellerId: params.sellerId,
    startDate: params.startDate,
    endDate: params.endDate,
  });
  if (params.excludeCampaignId) {
    search.set("excludeCampaignId", params.excludeCampaignId);
  }
  const res = await fetch(`/api/campaign-groups/suggest?${search.toString()}`);
  if (!res.ok) throw new Error("합류 후보 조회에 실패했습니다.");
  const payload = (await res.json()) as { groups?: CampaignGroupRow[] };
  return payload.groups ?? [];
}

/**
 * 이벤트(단건 생성·날짜 수정) 직후 자동 제안용 — 세션 억제된 (campaignId, groupId)를 걸러낸다.
 * excludeCampaignId가 없으면 억제 필터를 적용하지 않는다.
 */
export async function fetchActiveSuggestions(
  params: SuggestParams,
): Promise<CampaignGroupRow[]> {
  const groups = await fetchGroupSuggestions(params);
  const excludeId = params.excludeCampaignId;
  if (!excludeId) return groups;
  return groups.filter((group) => !isSuggestionDismissed(excludeId, group.id));
}

/** 그룹 상세(멤버 목록 포함) 조회. */
export async function fetchGroupDetail(
  groupId: string,
): Promise<CampaignGroupDetailRow> {
  const res = await fetch(`/api/campaign-groups/${groupId}`);
  if (!res.ok) throw new Error("그룹을 불러오지 못했습니다.");
  return (await res.json()) as CampaignGroupDetailRow;
}

/** 캠페인을 기존 그룹에 합류(경로 ⓑ) — addCampaignIds 재사용. */
export async function joinCampaignToGroup(
  groupId: string,
  campaignId: string,
): Promise<CampaignGroupDetailRow> {
  const res = await fetch(`/api/campaign-groups/${groupId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addCampaignIds: [campaignId] }),
  });
  if (!res.ok) throw new Error("합류하지 못했습니다.");
  return (await res.json()) as CampaignGroupDetailRow;
}

export type RemoveMemberResult =
  | { dissolved: true }
  | { dissolved: false; group: CampaignGroupDetailRow };

/**
 * 멤버 제외. 서버가 멤버 ≤1이면 자동 해체하고 200 `{ dissolved: true }`를 반환한다.
 * 호출자는 dissolved 케이스를 에러가 아닌 정상 전이(그룹 해제)로 처리해야 한다.
 */
export async function removeGroupMember(
  groupId: string,
  campaignId: string,
): Promise<RemoveMemberResult> {
  const res = await fetch(`/api/campaign-groups/${groupId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removeCampaignIds: [campaignId] }),
  });
  if (!res.ok) throw new Error("그룹에서 제외하지 못했습니다.");
  const payload = (await res.json()) as
    | { dissolved: true }
    | CampaignGroupDetailRow;
  if ("dissolved" in payload && payload.dissolved) {
    return { dissolved: true };
  }
  return { dissolved: false, group: payload as CampaignGroupDetailRow };
}

/**
 * 그룹 이름 변경. 빈 문자열을 보내면 서버가 자동 이름(D4)으로 복귀시킨다.
 * 그룹은 ≥2를 유지하므로 이 경로에서 해체는 발생하지 않는다.
 */
export async function renameGroup(
  groupId: string,
  name: string,
): Promise<CampaignGroupDetailRow> {
  const res = await fetch(`/api/campaign-groups/${groupId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("이름을 변경하지 못했습니다.");
  return (await res.json()) as CampaignGroupDetailRow;
}
