import type { CampaignStatus } from "./crm-types";

/**
 * 판매 캠페인 상태값 전체 목록의 SSOT (client-safe 순수 모듈, 파이프라인 순서).
 *
 * `SalesCampaign.status` 는 DB 에서 자유 문자열이라 값 집합을 강제하는 것은 코드뿐이다.
 * 이 목록이 zod 스키마 5곳과 봇 도구 1곳에 손으로 복사돼 있었다 — 값이 하나 늘면 일부만
 * 바뀌어 "화면에선 되는데 봇 기안은 거절"되는 식으로 갈린다. ⛔ 8개 값을 다시 적지 말고
 * `z.enum(CAMPAIGN_STATUSES)` 로 쓴다. 재선언은 `status-list-ssot.contract.test.ts` 가 막는다.
 *
 * ℹ️ 부분 집합(정산 단계·칸반 열·DROPPED 를 뺀 7개 순서 목록 등)은 각자의 질문에 답하는
 * 별개 목록이라 이 규칙의 대상이 아니다.
 * ℹ️ 여기엔 **전이 규칙이 없다** — 서버는 어느 상태에서든 어느 상태로든 받는다(칸반 자유 이동·
 * 되돌리기가 그 위에서 돈다). 전이를 막으려면 오너 결정이 먼저다.
 */
export const CAMPAIGN_STATUSES = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
  "DROPPED",
] as const satisfies readonly CampaignStatus[];

// 타입(`CampaignStatus`)에 값이 늘었는데 목록에 빠지면 여기서 컴파일이 깨진다(반대 방향은 satisfies 가 잡는다).
type MissingFromList = Exclude<CampaignStatus, (typeof CAMPAIGN_STATUSES)[number]>;
const _exhaustive: MissingFromList extends never ? true : never = true;
void _exhaustive;
