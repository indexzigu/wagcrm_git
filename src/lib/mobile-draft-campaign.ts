import type { Prisma } from "@prisma/client";
import type { SalesChannel } from "@/lib/crm-types";
import { getPrisma } from "@/lib/prisma";
import { parseBaseMarginPolicy } from "@/lib/base-margin-policy";
import { recalculateCampaignRounds } from "@/services/campaignService";

/**
 * 모바일 예비 캠페인 경량 생성 (MOBILE_UX_PLAN §4 · Phase 4).
 *
 * "예비"의 정의: baseNaverLink 빈값(링크 미확정) — 셀러 제안 단계(PROPOSAL)의
 * 일정 선점 레코드다. salesChannel·마진은 bulk 생성과 동일하게 딜의
 * baseMarginPolicy 첫 채널에서 자동 유도한다(수동 입력 없음).
 *
 * 캠페인명·차수는 저장하지 않고 같은 트랜잭션에서
 * recalculateCampaignRounds(딜×셀러 조합 전체 재번호+이름 재생성)로 부여한다 —
 * bulk 라우트의 캠페인명·차수 미설정 결함을 반복하지 않기 위함.
 */

export type DraftCampaignInput = {
  dealId: string;
  sellerId: string;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD (startDate 이상) */
  endDate: string;
};

export type DraftCampaignResult = {
  id: string;
  dealId: string;
  sellerId: string;
  campaignName: string | null;
  roundNumber: number | null;
  /** ISO 문자열 — 클라이언트 MobileCalendarCampaign 조립용 */
  startDate: string;
  endDate: string;
  status: string;
  /**
   * 딜 정책에서 유도된 채널(없으면 `UNSPECIFIED`) — 클라이언트가 낙관 반영할
   * `MobileCalendarCampaign` 의 자금 슬롯 판정 축이다. ⛔ 클라이언트에서 임의 값으로
   * 채우지 말 것: 예비 캠페인은 대금 예정일이 없어 지금은 마커가 안 서지만, 추측한
   * 채널이 캐시에 남으면 이후 일정이 붙는 순간 **틀린 슬롯 구성**으로 그려진다.
   */
  salesChannel: SalesChannel;
  dealName: string;
  /** alias 우선 (P2 Seller Alias Priority) */
  sellerName: string;
};

/** 라우트가 HTTP 상태로 변환할 수 있는 도메인 에러. */
export class DraftCampaignError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DraftCampaignError";
    this.status = status;
  }
}

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 이 경량 생성이 만들 수 있는 상태 — 입구별로 다르다.
 * - `PROPOSAL`: 모바일 예비 일정(셀러 제안 단계 선점). 캘린더에 올리지 않는다(`CALENDAR_EXCLUDED_STATUSES`).
 * - `PREPARATION`: [캘린더수집] 구글 캘린더에서 들어온 새 회차(오너 확정 ③, 2026-10-21) — PROPOSAL 로 만들면
 *   동기화가 넘겨받은 원본 일정을 지운다. 기안 액션 `create_campaign_round` 만 이 값을 쓴다.
 */
export type DraftCampaignStatus = "PROPOSAL" | "PREPARATION";

function assertDraftDates(input: DraftCampaignInput): void {
  if (!YMD_PATTERN.test(input.startDate) || !YMD_PATTERN.test(input.endDate)) {
    throw new DraftCampaignError("날짜는 YYYY-MM-DD 형식이어야 합니다.", 400);
  }
  // YYYY-MM-DD 는 사전순 비교 = 날짜 비교
  if (input.endDate < input.startDate) {
    throw new DraftCampaignError("종료일은 시작일보다 빠를 수 없습니다.", 400);
  }
}

/**
 * 모바일 예비 캠페인 경량 생성 — 자체 트랜잭션을 열고 `PROPOSAL` 로 만든다(종전 동작 그대로).
 * 본체는 `createDraftCampaignInTx` 하나다.
 */
export async function createDraftCampaign(
  input: DraftCampaignInput,
): Promise<DraftCampaignResult> {
  assertDraftDates(input);

  const prisma = getPrisma();
  return prisma.$transaction((tx) =>
    createDraftCampaignInTx(tx, { ...input, status: "PROPOSAL" }),
  );
}

/**
 * 경량 캠페인 생성 본체 — **호출부가 연 tx 안에서** 돈다. 승인 실행(`create_campaign_round`)은 기안의
 * EXECUTED 전이와 같은 트랜잭션이어야 해서(롤백 시 캠페인도 함께 사라진다) 자체 `$transaction` 을 열 수 없다.
 * ⛔ 생성 규칙(마진 유도·링크 빈값·회차 재부여)을 호출부에 다시 쓰지 말 것 — 두 입구가 이 함수 하나를 부른다.
 */
export async function createDraftCampaignInTx(
  tx: Prisma.TransactionClient,
  input: DraftCampaignInput & { status: DraftCampaignStatus },
): Promise<DraftCampaignResult> {
  assertDraftDates(input);

  const deal = await tx.deal.findUnique({
    where: { id: input.dealId },
    select: {
      id: true,
      dealName: true,
      dealType: true,
      status: true,
      baseMarginPolicy: true,
    },
  });
  if (!deal) {
    throw new DraftCampaignError("해당 판매 조건을 찾을 수 없습니다.", 404);
  }

  const seller = await tx.seller.findUnique({
    where: { id: input.sellerId },
    select: { id: true, name: true, alias: true },
  });
  if (!seller) {
    throw new DraftCampaignError("해당 셀러를 찾을 수 없습니다.", 404);
  }

  // bulk(campaigns/bulk POST)와 동일 패턴: 딜 정책의 첫 채널에서 마진 자동.
  // salesChannel 은 §4 확정대로 정책 첫 채널(없으면 미지정) — 예비 단계에
  // 임의 채널을 확정하지 않는다.
  const policy = parseBaseMarginPolicy(deal.baseMarginPolicy);
  const [firstChannelName, firstChannelRate] =
    Object.entries(policy.byChannel)[0] ?? [];
  const totalMarginRate = firstChannelRate?.totalMarginRate ?? 0;
  const sellerMarginRate = firstChannelRate?.sellerMarginRate ?? 0;

  const created = await tx.salesCampaign.create({
    data: {
      dealId: input.dealId,
      sellerId: input.sellerId,
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      status: input.status,
      salesChannel: firstChannelName ?? "UNSPECIFIED",
      totalMarginRate,
      sellerMarginRate,
      netMarginRate: totalMarginRate - sellerMarginRate,
      // 예비의 정의 — 링크 빈값. 추적 링크도 실링크 확정 전이므로 비워둔다
      // (bulk 의 가짜 랜덤 track.wag.kr 링크는 복사 사고 위험이라 미채택).
      baseNaverLink: "",
      generatedTrackingLink: "",
    },
  });

  // 같은 tx 안에서 캠페인명·차수 자동 부여(딜×셀러 조합 전체 재계산).
  await recalculateCampaignRounds(input.dealId, input.sellerId, tx);

  const campaign = await tx.salesCampaign.findUnique({
    where: { id: created.id },
    select: {
      id: true,
      campaignName: true,
      roundNumber: true,
      startDate: true,
      endDate: true,
      status: true,
      salesChannel: true,
    },
  });
  if (!campaign) {
    throw new DraftCampaignError("생성된 캠페인을 다시 읽지 못했습니다.", 500);
  }

  return {
    id: campaign.id,
    dealId: input.dealId,
    sellerId: input.sellerId,
    campaignName: campaign.campaignName ?? null,
    roundNumber: campaign.roundNumber ?? null,
    startDate: campaign.startDate.toISOString(),
    endDate: campaign.endDate.toISOString(),
    status: campaign.status,
    salesChannel: campaign.salesChannel as SalesChannel,
    dealName: deal.dealName,
    sellerName: seller.alias || seller.name,
  };
}
