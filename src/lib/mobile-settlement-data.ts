import { getPrisma } from "@/lib/prisma";
import { numberFromDecimal, toKstDateStr } from "@/lib/campaign-row";
import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";
import { SETTLEMENT_STAGE_STATUSES } from "@/lib/settlement-stage";

/**
 * 모바일 캘린더 홈(/schedule)의 정산 대기 스냅샷.
 * 자금 칩 합계·정산 대기 목록 시트(buildSettlementPending)·캠페인 상세 시트
 * (campaignRowToDetailData)가 소비하는 필드만 담는다.
 *
 * 기존에는 getCachedDashboardData("pipeline") 전체(9개 병렬 쿼리 + deep include)를
 * 읽고 campaigns만 소비했다 — pipeline 태그 무효화(카드 드래그 등 고빈도 쓰기)마다
 * kitchen-sink 재계산이 발생하는 구조라, 실소비 필드만 select하는 전용 쿼리로
 * 분리했다(#149 code-review). CampaignRow의 Pick이므로 전체 CampaignRow도
 * 구조적으로 대입 가능하다(공유 소비 함수 시그니처 호환).
 */
export type MobileSettlementCampaign = Pick<
  CampaignRow,
  | "id"
  | "groupId"
  | "dealName"
  | "sellerName"
  | "roundNumber"
  | "status"
  // 대금 칸 구성의 유일한 판정 입력 — 슬롯 SSOT `resolveCampaignMoneySlots`.
  // ⛔ 빼지 말 것: 없으면 모바일이 자사몰을 셀러몰 슬롯으로 오판해 공급사 지급이
  // 대기 목록·상세 시트·카드 상태에서 통째로 사라진다.
  | "salesChannel"
  | "startDate"
  | "endDate"
  | "expectedDepositDate"
  | "expectedPayoutDate"
  | "expectedSupplierPayoutDate"
  | "settlementSales"
  | "sellerExpense"
  | "actualSales"
  | "actualPayoutAmount"
  // 공급사 지급 칸의 금액 근거(수기 물품대금, T-057). ⛔ 빼지 말 것 — 없으면 그 칸이
  // 다시 「미정」으로 굳고 대기 총액에서 조용히 빠진다.
  | "settlementGoodsCost"
  | "isDepositReceived"
  | "isPayoutCompleted"
  | "isSupplierPayoutCompleted"
> & {
  /**
   * CG-1 묶음 이름 — 대기 목록이 묶음을 한 줄로 접을 때 쓰는 라벨(데스크톱 아젠다와
   * 같은 문법: `settlement-stage.foldedUnitLabel`). **선택 필드로 둔 것은 의도다** —
   * 위 주석대로 전체 `CampaignRow` 도 이 타입에 그대로 대입될 수 있어야 한다.
   * 미제공이면 대표 멤버 이름 + 「외 N건」으로 떨어진다.
   */
  groupName?: string | null;
};

type DecimalLike = number | string | { toString(): string } | null;

export type MobileSettlementCampaignSource = {
  id: string;
  groupId: string | null;
  roundNumber: number | null;
  status: string;
  salesChannel: string;
  startDate: Date;
  endDate: Date;
  expectedDepositDate: Date | null;
  expectedPayoutDate: Date | null;
  expectedSupplierPayoutDate: Date | null;
  settlementSales: DecimalLike;
  sellerExpense: DecimalLike;
  /** 대금 칸 금액의 근거 — 셀러몰 입금(매출−수수료)·셀러 지급(실지급액 우선)이 읽는다. */
  actualSales: DecimalLike;
  actualPayoutAmount: DecimalLike;
  /** 공급사 지급이 읽는 수기 물품대금(3-상태 — `0` = 합산 이관, null = 미입력). */
  settlementGoodsCost: DecimalLike;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
  group: {
    name: string | null;
    expectedDepositDate: Date | null;
    expectedPayoutDate: Date | null;
    expectedSupplierPayoutDate: Date | null;
    isDepositReceived: boolean;
    isPayoutCompleted: boolean;
    isSupplierPayoutCompleted: boolean;
  } | null;
};

export function toMobileSettlementCampaign(
  campaign: MobileSettlementCampaignSource,
): MobileSettlementCampaign {
  // CG-2 dual-read(toCampaignRow와 동일 계약): 그룹 캠페인은 그룹의 정산 예정일·완료
  // 플래그가 정본이다 — 그룹 값이 null이어도 캠페인 잔존값으로 폴백하지 않는다.
  // 정산 금액(settlement*·sellerExpense)은 캠페인 소유 유지(방화벽).
  const expectedDepositDate = campaign.group
    ? campaign.group.expectedDepositDate
    : campaign.expectedDepositDate;
  const expectedPayoutDate = campaign.group
    ? campaign.group.expectedPayoutDate
    : campaign.expectedPayoutDate;
  const expectedSupplierPayoutDate = campaign.group
    ? campaign.group.expectedSupplierPayoutDate
    : campaign.expectedSupplierPayoutDate;

  return {
    id: campaign.id,
    groupId: campaign.groupId,
    groupName: campaign.group?.name ?? null,
    dealName: campaign.deal.dealName,
    sellerName: campaign.seller.alias || campaign.seller.name,
    roundNumber: campaign.roundNumber,
    status: campaign.status as CampaignStatus,
    salesChannel: campaign.salesChannel as MobileSettlementCampaign["salesChannel"],
    startDate: toKstDateStr(campaign.startDate)!,
    endDate: toKstDateStr(campaign.endDate)!,
    expectedDepositDate: toKstDateStr(expectedDepositDate),
    expectedPayoutDate: toKstDateStr(expectedPayoutDate),
    expectedSupplierPayoutDate: toKstDateStr(expectedSupplierPayoutDate),
    settlementSales:
      campaign.settlementSales == null ? null : numberFromDecimal(campaign.settlementSales),
    sellerExpense:
      campaign.sellerExpense == null ? null : numberFromDecimal(campaign.sellerExpense),
    actualSales:
      campaign.actualSales == null ? null : numberFromDecimal(campaign.actualSales),
    actualPayoutAmount:
      campaign.actualPayoutAmount == null ? null : numberFromDecimal(campaign.actualPayoutAmount),
    // ⚠️ `0`(합산 이관)과 null(미입력)을 뭉개지 말 것 — 3-상태다.
    settlementGoodsCost:
      campaign.settlementGoodsCost == null
        ? null
        : numberFromDecimal(campaign.settlementGoodsCost),
    isDepositReceived: Boolean(
      campaign.group ? campaign.group.isDepositReceived : campaign.isDepositReceived,
    ),
    isPayoutCompleted: Boolean(
      campaign.group ? campaign.group.isPayoutCompleted : campaign.isPayoutCompleted,
    ),
    isSupplierPayoutCompleted: Boolean(
      campaign.group
        ? campaign.group.isSupplierPayoutCompleted
        : campaign.isSupplierPayoutCompleted,
    ),
  };
}

export async function getMobileSettlementCampaigns(): Promise<MobileSettlementCampaign[]> {
  const campaigns = await getPrisma().salesCampaign.findMany({
    // 모집단 SSOT — 데스크톱 아젠다(`api/agenda`)와 **반드시 같은 상수**를 쓴다.
    where: { status: { in: [...SETTLEMENT_STAGE_STATUSES] } },
    select: {
      id: true,
      groupId: true,
      roundNumber: true,
      status: true,
      salesChannel: true,
      startDate: true,
      endDate: true,
      expectedDepositDate: true,
      expectedPayoutDate: true,
      expectedSupplierPayoutDate: true,
      settlementSales: true,
      sellerExpense: true,
      actualSales: true,
      actualPayoutAmount: true,
      settlementGoodsCost: true,
      isDepositReceived: true,
      isPayoutCompleted: true,
      isSupplierPayoutCompleted: true,
      deal: { select: { dealName: true } },
      seller: { select: { name: true, alias: true } },
      group: {
        select: {
          // 접힌 묶음 한 줄의 이름 — 없으면 대표 멤버 + 「외 N건」 폴백.
          name: true,
          expectedDepositDate: true,
          expectedPayoutDate: true,
          expectedSupplierPayoutDate: true,
          isDepositReceived: true,
          isPayoutCompleted: true,
          isSupplierPayoutCompleted: true,
        },
      },
    },
    // ⛔ `updatedAt` 순으로 되돌리지 말 것 — 소비처가 조합 캠페인을 묶음당 한 줄로 접는데
    // (`foldGroupMoney`) **대표 = 첫 멤버**다. 갱신순이면 멤버 하나를 저장할 때마다 대표가
    // 바뀌어, 같은 상태인데 새로고침마다 줄 이름(묶음 이름이 없을 때의 「… 외 N건」)과
    // 눌렀을 때 열리는 상세가 달라진다. 폴딩 SSOT 도 안정된 순서를 계약으로 요구한다.
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });

  return campaigns.map(toMobileSettlementCampaign);
}
