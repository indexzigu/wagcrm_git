import type { CampaignStatus } from "./crm-types";

/**
 * 정체(stagnant) 판정 SSOT — 화면(`campaign-actions.ts`) 배지가 소비하는 단일
 * 정의. (크론 알림 소비자는 알림센터 해체와 함께 2026-07-24 제거됐다 — 정체
 * 신호의 표면은 칸반 지연 칩/필터뿐이며, 이 임계·연산자가 그 정본이다.)
 *
 * ## 왜 SSOT 가 됐나 (2026-07-17)
 *
 * 이 파일과 `campaign-actions.ts` 에 정체 정의가 **두 벌** 있었고 서로 달랐다:
 * PREPARATION 임계가 여기선 7일·화면은 3일, 비교가 여기선 `>`·화면은 `>=`.
 * 오너 체감으로는 "배지는 떴는데 알림은 안 온다"(또는 그 반대)가 된다. 임계와
 * 연산자를 여기로 모으고 `campaign-actions.ts` 가 이 판정을 소비한다.
 *
 * ⚠️ 정체는 `updatedAt`(Prisma `@updatedAt`) 기반이라 **약한 대리지표**다 — 무관한
 * 필드 write 나 배치 작업 한 번이면 조용히 리셋된다. 실측(2026-07-17)에서 세팅 대기
 * 카드 7건이 전부 15초 이내 같은 배치에 쓰였고(2026-07-11T07:00:35~50), 배지는
 * 캠페인이 아니라 그 배치의 나이를 표시하고 있었다. 그래서 **일정 앵커가 있는
 * 단계에는 쓰지 않는다**(아래 PREPARATION 주석). 앵커가 없는 단계에서만 "아무도 안
 * 들여다본 지 오래됐다" 정도의 약한 신호로 남긴다.
 */
export const STAGNANT_THRESHOLDS: Record<CampaignStatus, number> = {
  PROPOSAL: 3,
  /**
   * `Infinity` = 정체 판정 안 함 (2026-07-17 오너 확정).
   *
   * 세팅 대기는 **판매 시작일이라는 일정 앵커가 있는** 단계다. 확정 후 판매일까지
   * 최대 11개월(prod 실측 최장 324일) 대기하는 게 정상이라, `updatedAt` 기반 정체는
   * 구조적으로 오탐만 낸다 — 실측 16건 중 7건이 발화했고 그중 6건이 오탐이었다.
   * 이 단계에서 오너가 실제로 봐야 하는 것은 `campaign-setup.ts` 가 판정한다
   * (세팅 창 D-10 + 주문관리 등록 필요 여부). 임계값을 되살리지 말 것.
   */
  PREPARATION: Infinity,
  ACTIVE: 2,
  CLOSED: 2,
  SETTLEMENT_WAIT: 5,
  SETTLEMENT_IN_PROGRESS: 5,
  COMPLETED: Infinity,
  DROPPED: Infinity,
};

export const STAGNANT_SUGGESTIONS: Record<CampaignStatus, string> = {
  PROPOSAL: "셀러에게 재연락하거나 다른 셀러를 탐색하세요",
  // PREPARATION 은 임계가 Infinity 라 도달 불가 — Record 완전성을 위해 남긴다.
  PREPARATION: "세팅 완료 후 ACTIVE로 전환하세요",
  ACTIVE: "캠페인 성과를 확인하고 종료 여부를 결정하세요",
  CLOSED: "정산 처리를 시작하세요",
  // 「몰 정산금」은 자사몰 전용 개념인데 3채널 공통 문구에 박혀 있었다 — 채널 중립으로
  // 통일(오너 확정 2026-08-25). 이 Record 는 상태 단위라 애초에 채널을 알 수 없다.
  SETTLEMENT_WAIT: "반품기간과 정산금 입금 여부를 확인하세요",
  SETTLEMENT_IN_PROGRESS: "정산 체크리스트의 미완료 항목을 처리하세요",
  COMPLETED: "",
  DROPPED: "",
};

export function getStagnantSuggestion(status: CampaignStatus): string {
  return STAGNANT_SUGGESTIONS[status] ?? "";
}

/**
 * 정체 판정의 유일한 술어 — 임계 비교가 여기 한 줄뿐이어야 화면과 크론이 갈라지지
 * 않는다. 호출부는 `daysSinceUpdate` 만 각자 계산해 넘긴다(화면은 표시용으로 그
 * 값이 따로 필요하고, 크론은 아니라서 계산 위치를 강제하지 않는다).
 *
 * 미지 status(런타임에 union 밖 문자열이 흘러들어오는 경우 — DB 는 `status String`)
 * 는 `undefined` 임계가 되어 `Number.isFinite` 에서 걸러진다 → 미발화(안전 실패).
 */
export function isStagnantAfterDays(status: CampaignStatus, daysSinceUpdate: number): boolean {
  const threshold = STAGNANT_THRESHOLDS[status];
  return Number.isFinite(threshold) && daysSinceUpdate >= threshold;
}

export function isStagnant(campaign: {
  status: CampaignStatus;
  updatedAt: string | Date;
}): boolean {
  const updatedAt =
    typeof campaign.updatedAt === "string" ? new Date(campaign.updatedAt) : campaign.updatedAt;
  const daysSinceUpdate = Math.floor((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));
  return isStagnantAfterDays(campaign.status, daysSinceUpdate);
}

export function getStagnantClass(campaign: {
  status: CampaignStatus;
  updatedAt: string | Date;
}): string {
  return isStagnant(campaign) ? "text-red-400 font-semibold" : "";
}
