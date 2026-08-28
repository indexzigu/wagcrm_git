/**
 * 파트너/셀러 목록 표시용 유틸리티 함수
 * - 팔로워 수 포맷팅
 * - 팔로워 막대그래프 너비 계산
 * - 최근 컨택 날짜 포맷
 * - 첫 번째 담당자 연락처 표시
 */

/**
 * 팔로워 수를 표시 형식으로 포맷팅
 * - 10,000 이상: "X.Y만" (소수점 1자리 반올림)
 * - 10,000 미만: 천 단위 콤마 형식
 * - 0: "0"
 */
export function formatFollowerCount(count: number): string {
  if (count === 0) return "0";
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1)}만`;
  }
  return count.toLocaleString("ko-KR");
}

/**
 * 팔로워 막대그래프 너비 계산 (%)
 * - (count / 300,000) × 100
 * - 최소 1% (count > 0일 때)
 * - 최대 100%
 * - 0이면 0%
 */
export function calculateBarWidth(count: number): number {
  if (count <= 0) return 0;
  const width = (count / 300000) * 100;
  return Math.max(1, Math.min(100, width));
}

/**
 * 최근 컨택 날짜를 "YYYY-MM-DD" 형식으로 포맷팅
 */
export function formatLastContact(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 첫 번째 담당자의 연락처 반환
 * - phoneNumber 우선, 없으면 email 반환
 * - 담당자가 없거나 연락처가 없으면 빈 문자열 반환
 */
export function getDisplayContact(
  contacts: Array<{ phoneNumber?: string | null; email?: string | null }>,
): string {
  if (!contacts || contacts.length === 0) return "";
  const first = contacts[0];
  return first.phoneNumber || first.email || "";
}

/**
 * 셀러 목록 "누적 캠페인" 셀의 최근성 신호.
 *
 * 이 컬럼의 판단 가치는 횟수(거래 깊이)만이 아니라 **타이밍**이다 — 성장 전략이 소개·재거래
 * 기반 플라이휠이라, "많이 했는데 오래 멈춘" 셀러가 재접촉 후보다(오너 피드백 2026-07-16:
 * 색상 변경이 아니라 시각적 개선의 범위를 넓힐 것). 우선순위는 진행 중 > 시작 예정 > 마지막
 * 종료 경과 — 지금 살아있는 관계가 과거 이력보다 먼저다.
 *
 * DROPPED(기각 확정)는 관계 신호가 아니므로 제외한다. PROPOSAL(제안 단계)은 포함 —
 * 운영자 파이프라인에선 이미 작업 중인 관계다(칸반 작업 컬럼과 같은 관점).
 * 날짜 기반 판정(status의 ACTIVE 여부가 아니라 실제 기간)은 sale-window의 "표시는 창에서
 * 파생한다" 원칙과 정합.
 */
export type CampaignRecencySpan = {
  startDate: string;
  endDate: string;
  status?: string;
};

export type CampaignRecency = {
  kind: "active" | "upcoming" | "past";
  label: string;
};

/**
 * 캡(campaigns take:12) 무관 서버 집계 신호 — loadSellerSummaries(seller-summary.ts)가 채운다.
 * SellerSummary와 필드명이 같아 row를 그대로 넘길 수 있다. 필드가 undefined면(구 캐시
 * 페이로드·집계 실패) 캡 배열 폴백으로 판정한다.
 */
export type CampaignRecencySignals = {
  hasActiveCampaign?: boolean;
  hasUpcomingCampaign?: boolean;
  lastCampaignEndAt?: string | null;
};

const DAY_MS = 86_400_000;

function pastRecency(latestEndMs: number, nowMs: number): CampaignRecency {
  const days = Math.floor((nowMs - latestEndMs) / DAY_MS);
  const label =
    days <= 0
      ? "오늘 종료"
      : days < 30
        ? `${days}일 전 종료`
        : days < 365
          ? `${Math.floor(days / 30)}개월 전 종료`
          : `${Math.floor(days / 365)}년 전 종료`;
  return { kind: "past", label };
}

export function campaignRecency(
  campaigns: ReadonlyArray<CampaignRecencySpan> | null | undefined,
  nowMs: number,
  signals?: CampaignRecencySignals,
): CampaignRecency | null {
  // 신호 우선 — campaigns 배열은 startDate desc 상위 12건 캡이라 13건+ 셀러에서 "오래 전
  // 시작했지만 아직 진행 중"인 캠페인이 창 밖으로 밀려 '종료'로 오표시될 수 있다. 신호가
  // 아무 판정도 못 내면(전부 false/null = non-DROPPED 캠페인 없음) 배열로 계속 진행한다 —
  // 그 경우 배열도 비어 있거나 DROPPED뿐이라 결과가 같고, 집계·본조회 사이 레이스만 자기치유한다.
  if (signals) {
    if (signals.hasActiveCampaign) return { kind: "active", label: "진행 중" };
    if (signals.hasUpcomingCampaign) return { kind: "upcoming", label: "시작 예정" };
    const lastEndMs = signals.lastCampaignEndAt ? Date.parse(signals.lastCampaignEndAt) : NaN;
    if (Number.isFinite(lastEndMs)) return pastRecency(lastEndMs, nowMs);
  }
  if (!campaigns || campaigns.length === 0) return null;
  let hasUpcoming = false;
  let latestEndMs: number | null = null;
  for (const c of campaigns) {
    if (c.status === "DROPPED") continue;
    const start = Date.parse(c.startDate);
    const end = Date.parse(c.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start <= nowMs && nowMs <= end) return { kind: "active", label: "진행 중" };
    if (start > nowMs) {
      hasUpcoming = true;
      continue;
    }
    if (latestEndMs === null || end > latestEndMs) latestEndMs = end;
  }
  if (hasUpcoming) return { kind: "upcoming", label: "시작 예정" };
  if (latestEndMs === null) return null;
  return pastRecency(latestEndMs, nowMs);
}

/**
 * 채널 정보 부분 적용
 *
 * 채널 정보 API 응답(snsType, snsHandle, name, currentFollowers 중 임의의 부분집합)에 대해,
 * 반환된 필드만 기존 셀러 데이터에 적용하고 반환되지 않은 필드는 기존 값을 유지한다.
 */
export type ChannelInfoPartial = {
  snsType?: string;
  snsHandle?: string;
  name?: string;
  currentFollowers?: number;
};

export type SellerChannelData = {
  snsType: string | null;
  snsHandle: string | null;
  name: string | null;
  currentFollowers: number | null;
};

export function applyChannelInfo(
  existing: SellerChannelData,
  partial: ChannelInfoPartial,
): SellerChannelData {
  return {
    snsType: partial.snsType !== undefined ? partial.snsType : existing.snsType,
    snsHandle: partial.snsHandle !== undefined ? partial.snsHandle : existing.snsHandle,
    name: partial.name !== undefined ? partial.name : existing.name,
    currentFollowers: partial.currentFollowers !== undefined ? partial.currentFollowers : existing.currentFollowers,
  };
}

/**
 * 신규 등록 셀러 표시 창(오너 확정 2026-07-23) — 등록 후 이 일수 동안 목록에서 "신규"로 구분한다.
 * 이전에는 최근 정보갱신일 정렬로만 신규를 찾을 수 있어 구분 표시가 필요하다는 지적에서 나왔다.
 */
export const NEW_SELLER_WINDOW_DAYS = 7;

/**
 * 등록일이 신규 표시 창(NEW_SELLER_WINDOW_DAYS) 안인지 판정한다.
 * - createdAt 부재/파싱 불가 → false (표시하지 않음 — 신호가 없는데 신규로 꾸미지 않는다)
 * - 미래 시각(시계 오차)은 경과 0일로 간주해 신규로 판정한다
 */
export function isRecentlyRegistered(
  createdAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t < NEW_SELLER_WINDOW_DAYS * 86_400_000;
}
