import type { CampaignRow } from "./crm-types";

/**
 * 판매 시작 전 "세팅" 판정 SSOT — 판매관리 칸반(`/pipeline`)의 세팅 대기 컬럼이 쓴다.
 *
 * ## 왜 이 파일이 생겼나 (오너 확정)
 *
 * 세팅 대기 컬럼은 **성질이 다른 두 집단**을 한 그릇에 담고 있었다:
 *   ① 판매가 임박해 지금 세팅해야 하는 캠페인
 *   ② 확정만 됐고 판매일이 수개월 뒤라 **할 일이 없는** 캠페인
 * 판매 일정이 길게 확정되는 특성상 대부분이 ②라, 컬럼이 비대해 보이는 정체가 이것이다.
 *
 * 기존 `정체 N일` 배지는 이 둘을 구분하지 못했다 — `campaign.updatedAt`(Prisma
 * `@updatedAt`)을 봤기 때문이다. 그 필드는 **어떤 필드든 write되면 갱신**되므로
 * 캠페인의 진행 상태를 전혀 모른다. 무관한 배치 write 한 번이면 갱신되고, 반대로
 * 오래 방치돼도 배치가 한 번 훑으면 리셋된다 — 즉 배지는 캠페인이 아니라 "이 행을
 * 마지막으로 훑고 간 write 가 며칠 됐는가"를 표시하고 있었다(양방향 오류).
 *
 * ## 왜 체크리스트도, 링크도 신호가 아닌가 (기각된 후보들)
 *
 * - `CampaignChecklistItem`: PREPARATION 세팅 항목(판매 링크 준비 · 트래킹 링크 생성 ·
 *   셀러 전달 자료 확인 등)은 운영상 거의 체크되지 않는다 — 체크율이 낮아 여기에
 *   배지를 걸면 창에 들어오는 카드 대부분이 오탐이 된다.
 * - `baseNaverLink`: 실제 상품 링크가 채워진 캠페인이 드물고, 빈값 아니면 스토어 맨
 *   도메인(`https://smartstore.naver.com`)이 많다. 후자는 `""`·`"pending"` 만 거르는
 *   Unconfirmed Link Guard(P2)를 **truthy로 통과**해 신호가 되지 못한다.
 *
 * ## 유일하게 살아있는 신호 = `orderCampaignId`
 *
 * 오너 설명: *"우리 스토어에서 운영하게 되면 보통 주문관리에서 캠페인등록과정을 거치고,
 * 우리 스토어에서 하는 캠페인이 아니면 외부에서 링크 주는거 기다리는것밖에 없어"*.
 * 이 흐름이 데이터에도 그대로 있다 — 주문관리(`OrderCampaign`) 등록은 자사 네이버
 * 캠페인에서만 일어나고, 남의 스토어(브랜드몰·셀러몰)는 주문 접근 권한이 없어 등록
 * 자체가 불가능하다. 즉 등록은 자사 네이버 캠페인의 **판매 개시 전제조건**이고,
 * `orderCampaignId != null` 이 "세팅 완료"의 정직한 정의다. 오너가 이미 하는 행위가
 * 이미 기록되므로 **새 버튼·새 노동이 없다**.
 *
 * 나머지 채널은 "기다림"이 유일한 일이고 **기다림에는 완료 버튼을 달 수 없다**(오너의
 * 일이 아니라 상대방의 일이므로). 그래서 이 파일은 자사 스토어에만 할 일을 만든다 —
 * 그 외 채널에 신호를 만들려면 오너가 매번 링크를 붙여넣어야 하는데, 그 링크는 달리
 * 쓰이는 데가 없어 체크리스트·링크 필드처럼 방치될 것이 이미 여러 번 증명됐다.
 *
 * 등록 판정 대상 채널 (오너 확정): `OWN_MALL_NAVER` + `OWN_MALL`(자사몰 기타). 둘 다
 * 자사 스토어라 주문관리 등록을 거친다. `OWN_MALL_KAKAO` 는 제외한다: 오너가 "스토어
 * 세팅이 불편해 거의 이용하지 않을 것 · API 세팅도 안 함"으로 확정했고 자사몰은 네이버
 * 스토어 중심으로 간다.
 *
 * ## 채널 미지정은 "세팅 완료"가 아니라 "세팅 시작 전" (오너 확정)
 *
 * `UNSPECIFIED` 는 채워야 하는 값이다 — 채널을 정해야 등록 필요 여부도 판정되므로,
 * 세팅 창 안의 미지정 카드는 등록보다 먼저 "판매채널 지정 필요"를 표시한다
 * (`needsChannelAssignment`). 셀러 제안 단계에서는 채널이 지정돼 있으므로, 세팅 대기의
 * 미지정은 일괄 생성 등이 값을 안 채운 경우로 본다.
 */

/**
 * 세팅 창 — 판매 시작까지 남은 일수가 이 값 이하면 "세팅 중"으로 본다.
 *
 * 오너 진술: *"세팅은 보통 일주일전에 시작해 아무리 빨라도 10일"*. **가장 이른 착수
 * 시점**을 창의 경계로 잡는다 — 7일로 좁히면 8~10일 전에 착수하는 건이 창 밖에 접혀
 * 세팅 중인데 안 보이게 된다.
 *
 * ⚠️ 이 값은 완료 기한이 아니다. 준비 완료 기한은 `campaign-actions.ts`의
 * `ACTION_COPY.PREPARATION.offsetDays = -1`(판매 시작 전날)이며 오너가 확정한 값이다
 * — "7일 전 착수"를 "7일 전 완료"로 오독해 그 값을 건드리지 말 것(실제로 한 번 오독됨).
 */
export const SETUP_WINDOW_DAYS = 10;

/** 주문관리(order-converter) 캠페인 등록 대상 채널 — 자사 스토어. 위 doc 참조. */
const ORDER_REGISTRABLE_CHANNELS = new Set<CampaignRow["salesChannel"]>([
  "OWN_MALL_NAVER",
  "OWN_MALL",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function parseYmd(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

/** 자정 기준 일수 차이 — `campaign-actions.ts`의 `dayDiff`와 같은 계산이다. */
function dayDiff(from: Date, to: Date) {
  const fromDay = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const toDay = new Date(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()));
  return Math.floor((toDay.getTime() - fromDay.getTime()) / DAY_MS);
}

/**
 * 판매 시작까지 남은 일수. 오늘 시작이면 0, 이미 시작했으면 음수.
 * `startDate`가 비었거나 파싱 불가면 `null`(판정 불가).
 */
export function getDaysUntilStart(
  campaign: Pick<CampaignRow, "startDate">,
  now = new Date(),
): number | null {
  if (!campaign.startDate) return null;
  const start = parseYmd(campaign.startDate);
  if (Number.isNaN(start.getTime())) return null;
  return dayDiff(now, start);
}

/**
 * 세팅 창 안인가 — 판매 시작까지 `SETUP_WINDOW_DAYS` 이하로 남았는가.
 *
 * 이미 시작한 건(음수)도 창 안으로 본다: 세팅 대기에 남아 있는데 판매일이 지났다면
 * 그거야말로 봐야 할 카드다. `startDate` 판정 불가 시 **창 안으로 보수적 판정** —
 * 접어서 시야에서 지우는 것보다 펼쳐두는 쪽이 안전 실패다.
 */
export function isInSetupWindow(
  campaign: Pick<CampaignRow, "startDate">,
  now = new Date(),
): boolean {
  const days = getDaysUntilStart(campaign, now);
  if (days === null) return true;
  return days <= SETUP_WINDOW_DAYS;
}

/**
 * 주문관리 등록이 아직 필요한가 — 자사 스토어 캠페인인데 `OrderCampaign`이 없는 경우.
 *
 * 세팅 창 게이팅은 하지 않는다(호출부가 창 안 카드에만 묻는다). 창 밖(판매일이 먼 건)
 * 에서 미등록인 것은 정상이라 묻지 않고 접힌 채로 둔다.
 */
export function needsOrderRegistration(
  campaign: Pick<CampaignRow, "salesChannel" | "isOrderRegistered">,
): boolean {
  if (!ORDER_REGISTRABLE_CHANNELS.has(campaign.salesChannel)) return false;
  return !campaign.isOrderRegistered;
}

/**
 * 판매채널이 아직 안 정해졌는가 — `UNSPECIFIED`. 채널을 정해야 등록 필요 여부도
 * 판정되므로, 세팅 창 안에서는 등록보다 **먼저** 표시해야 하는 선행 할 일이다
 * (오너 확정 2026-07-18, 위 doc 참조). 등록과 마찬가지로 세팅 창 게이팅은 호출부가 한다.
 */
export function needsChannelAssignment(
  campaign: Pick<CampaignRow, "salesChannel">,
): boolean {
  return campaign.salesChannel === "UNSPECIFIED";
}
