import type { SalesChannel } from "@/lib/crm-types";
import { getPrisma } from "@/lib/prisma";

/**
 * 모바일 캘린더 홈의 월 데이터. 캠페인 기간∩월 뿐 아니라
 * 입금/지급 "예정일"이 이 달에 떨어지는 캠페인도 포함한다 —
 * 정산 예정일은 통상 캠페인 종료 후라 기간 교집합만으로는 자금 도트가 누락된다.
 */
export type MobileCalendarCampaign = {
  id: string;
  dealName: string;
  sellerName: string;
  sellerId: string;
  /** CG-3: 조합 캠페인 그룹 — 같은 그룹 멤버는 캘린더에서 충돌로 취급하지 않는다. */
  groupId: string | null;
  groupName: string | null;
  roundNumber: number | null;
  startDate: string;
  endDate: string;
  status: string;
  /**
   * 자금 마커가 **몇 개이고 누구와의 거래인지**를 정하는 축(슬롯 SSOT의 유일한 인자).
   * ⛔ 빼지 말 것 — 없으면 소비처가 채널을 모르는 채 입금·지급 두 개로 접어, 자사몰의
   * 공급사 지급이 사라지고 실효 없는 입금 마커가 되살아난다.
   *
   * ⛔ **`string` 으로 넓히지도 말 것**(2026-08-25 승격). 이 값은 상세 시트의 슬롯 판정
   * 입력으로 그대로 흘러가는데, 넓은 타입이면 빈 문자열·오타가 조용히 통과해
   * `resolveTaxFilingChannelGroup` 의 셀러몰 기본 갈래로 접힌다. 좁히는 자리는 아래 서버
   * 매퍼 한 곳(`as SalesChannel`)이고, 그 아래 소비자는 전부 이 보장 위에 선다.
   */
  salesChannel: SalesChannel;
  expectedDepositDate: string | null;
  expectedPayoutDate: string | null;
  /** 자사몰 공급사 지급 레그(2번째 지급 일정) — 슬롯 SSOT: resolveCampaignMoneySlots. */
  expectedSupplierPayoutDate: string | null;
  /**
   * **실제로 오간 날**. 완료된 칸은 예정일이 아니라 이 날짜에 선다
   * (`resolveMoneySlotEffectiveDate`) — 20일 예정건을 15일에 지급했으면 마커가 15일로
   * 옮겨간다(오너 지적 2026-07-15).
   *
   * ⛔ **선택 필드로 되돌리지 말 것** — 빠뜨려도 컴파일이 통과하고 화면은 완료 건을
   * 예정일에 그대로 그린다(= 고치기 전 상태). 크래시가 없어 아무도 모르는 형태다.
   */
  depositReceivedAt: string | null;
  payoutCompletedAt: string | null;
  supplierPayoutCompletedAt: string | null;
  // 컬럼 선택 근거는 `calendar-entities.MONEY_AMOUNT_FIELD` 주석(죽은 컬럼 이력 포함).
  settlementSales: number | null;
  actualSales: number | null;
  sellerExpense: number | null;
  actualPayoutAmount: number | null;
  /**
   * 수기 물품대금 — 공급사 지급 칸의 근거(T-057). 위 금액들과 같은 CG-1 정산 방화벽
   * 대상이라 **그룹이 아니라 캠페인이 소유**한다(`CampaignGroup` 에 컬럼 자체가 없다).
   */
  settlementGoodsCost: number | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
};

export async function getCalendarMonthCampaigns(
  year: number,
  month1based: number,
): Promise<MobileCalendarCampaign[]> {
  const firstDay = new Date(year, month1based - 1, 1);
  const lastDay = new Date(year, month1based, 0, 23, 59, 59, 999);

  const campaigns = await getPrisma().salesCampaign.findMany({
    where: {
      OR: [
        { startDate: { lte: lastDay }, endDate: { gte: firstDay } },
        { expectedDepositDate: { gte: firstDay, lte: lastDay } },
        { expectedPayoutDate: { gte: firstDay, lte: lastDay } },
        // 자사몰 공급사 지급일도 조회 창에 넣는다 — 빼면 그 날짜만 이 달에 있는
        // 자사몰 캠페인이 통째로 안 실려 공급사 지급 마커가 조용히 사라진다.
        { expectedSupplierPayoutDate: { gte: firstDay, lte: lastDay } },
        // 완료된 칸은 **실제로 오간 날**에 선다(resolveMoneySlotEffectiveDate). 그 날이
        // 예정일과 다른 달이면 — 9월 예정건을 8월에 지급 — 완료일을 창에 넣지 않는 한
        // 그 캠페인은 8월 응답에 아예 실리지 않아 마커가 조용히 사라진다.
        { depositReceivedAt: { gte: firstDay, lte: lastDay } },
        { payoutCompletedAt: { gte: firstDay, lte: lastDay } },
        { supplierPayoutCompletedAt: { gte: firstDay, lte: lastDay } },
        // CG-2: 그룹 캠페인의 공유 예정일은 CampaignGroup 소유 — 그룹 일정이
        // 이 달에 떨어지는 멤버도 포함해야 자금 도트가 누락되지 않는다.
        { group: { expectedDepositDate: { gte: firstDay, lte: lastDay } } },
        { group: { expectedPayoutDate: { gte: firstDay, lte: lastDay } } },
        { group: { expectedSupplierPayoutDate: { gte: firstDay, lte: lastDay } } },
        { group: { depositReceivedAt: { gte: firstDay, lte: lastDay } } },
        { group: { payoutCompletedAt: { gte: firstDay, lte: lastDay } } },
        { group: { supplierPayoutCompletedAt: { gte: firstDay, lte: lastDay } } },
      ],
    },
    include: {
      deal: { select: { dealName: true } },
      seller: { select: { name: true, alias: true } },
      group: true,
    },
    orderBy: { startDate: "asc" },
  });

  return campaigns.map((c) => {
    // CG-2 dual-read: 그룹 캠페인은 그룹 값이 정본 — 그룹 값이 null이어도 캠페인
    // 잔존 스칼라로 폴백하지 않는다. 그룹 캠페인의 정산 필드 쓰기는 그룹 레코드로만
    // 가고 캠페인 스칼라는 그룹핑 시점에 얼어붙으므로(campaigns route의
    // `!isGrouped ? campaignSharedEventUpdates : {}`), read-time 멤버 폴백은
    // 오너가 그룹 예정일을 "명시적으로 지운" 값을 되살린다("미설정 virgin"과
    // "명시 삭제"는 read 시점에 구분 불가). 근본수정은 형성 시 승계
    // (campaignGroupService.inheritGroupSettlement) + 기존 그룹 백필(#155)이고,
    // 데스크톱 campaign-row와 동일하게 렌더는 그룹-정본을 유지한다(폴백 제거).
    // 완료 플래그도 동일하게 그룹 소속이면 무조건 그룹이 정본. 정산 금액은
    // 캠페인 소유 유지(방화벽).
    const expectedDepositDate = c.group
      ? c.group.expectedDepositDate
      : c.expectedDepositDate;
    const expectedPayoutDate = c.group
      ? c.group.expectedPayoutDate
      : c.expectedPayoutDate;
    // 신규 3필드도 같은 CG-2 규약에 편입돼 있다(#452) — 그룹 소속이면 그룹 스칼라가
    // 정본이고 멤버 폴백을 되살리지 않는다.
    const expectedSupplierPayoutDate = c.group
      ? c.group.expectedSupplierPayoutDate
      : c.expectedSupplierPayoutDate;
    // 완료일도 같은 규약이다 — 플래그가 그룹 정본인데 날짜만 멤버에서 폴백하면, 그룹이
    // 완료 처리된 건이 **멤버의 옛 완료일**로 옮겨가 없는 날에 마커가 선다.
    const completedAt = <K extends "depositReceivedAt" | "payoutCompletedAt" | "supplierPayoutCompletedAt">(
      field: K,
    ): Date | null => (c.group ? c.group[field] : c[field]);
    return {
      id: c.id,
      dealName: c.deal.dealName,
      sellerName: c.seller.alias || c.seller.name,
      sellerId: c.sellerId,
      groupId: c.groupId ?? null,
      groupName: c.group?.name ?? null,
      roundNumber: c.roundNumber ?? null,
      startDate: c.startDate.toISOString(),
      endDate: c.endDate.toISOString(),
      status: c.status,
      salesChannel: c.salesChannel as SalesChannel,
      expectedDepositDate: expectedDepositDate ? expectedDepositDate.toISOString() : null,
      expectedPayoutDate: expectedPayoutDate ? expectedPayoutDate.toISOString() : null,
      expectedSupplierPayoutDate: expectedSupplierPayoutDate
        ? expectedSupplierPayoutDate.toISOString()
        : null,
      depositReceivedAt: completedAt("depositReceivedAt")?.toISOString() ?? null,
      payoutCompletedAt: completedAt("payoutCompletedAt")?.toISOString() ?? null,
      supplierPayoutCompletedAt: completedAt("supplierPayoutCompletedAt")?.toISOString() ?? null,
      settlementSales: c.settlementSales == null ? null : Number(c.settlementSales),
      actualSales: c.actualSales == null ? null : Number(c.actualSales),
      sellerExpense: c.sellerExpense == null ? null : Number(c.sellerExpense),
      actualPayoutAmount:
        c.actualPayoutAmount == null ? null : Number(c.actualPayoutAmount),
      // ⚠️ `Number()` 로 접을 때 `0`(합산 이관)과 null(미입력)을 뭉개지 말 것 — 3-상태다.
      settlementGoodsCost:
        c.settlementGoodsCost == null ? null : Number(c.settlementGoodsCost),
      isDepositReceived: Boolean(c.group ? c.group.isDepositReceived : c.isDepositReceived),
      isPayoutCompleted: Boolean(c.group ? c.group.isPayoutCompleted : c.isPayoutCompleted),
      isSupplierPayoutCompleted: Boolean(
        c.group ? c.group.isSupplierPayoutCompleted : c.isSupplierPayoutCompleted,
      ),
    };
  });
}
