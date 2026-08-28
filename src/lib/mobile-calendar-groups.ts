import type { CampaignStatus, SalesChannel } from "@/lib/crm-types";
import type { MobileCalendarCampaign } from "@/lib/mobile-calendar-data";
import { foldGroupMoney, representativeStatus } from "@/lib/calendar-entities";

export type MobileCalendarItem = {
  kind: "campaign" | "group";
  key: string;
  groupId: string | null;
  dealName: string;
  sellerName: string;
  sellerId: string;
  roundNumber: number | null;
  startDate: string;
  endDate: string;
  status: string;
  /**
   * 자금 마커 슬롯 판정 축 — **묶음이면 멤버 채널 전부**가 들어온다(개별 항목은 1개).
   *
   * ⛔ 단일 `salesChannel` 로 되돌리지 말 것. `CampaignGroup` 에는 채널 컬럼이 **없고**
   * 채널은 멤버 행이 소유하므로, 대표 멤버 하나를 고르면 채널이 섞인 그룹에서 대금 레그가
   * 조용히 사라진다(자사몰 멤버를 고르면 입금이, 브랜드몰 멤버를 고르면 공급사 지급이).
   * ⚠️ 그 조합은 **운영에 없다**(오너 확정 2026-08-25 — 조합은 딜만 여러 개이고 판매채널은
   * 하나다). 그래서 이 배열은 관측된 결함을 고친 게 아니라, 구글 동기화와 **같은 판정
   * 규칙**을 쓰게 만드는 것이 본체다 — 판정은 `resolveMoneySlotsForChannels` 에 넘기고
   * 소비처가 합집합을 손으로 만들지 않는다.
   *
   * 🪤 이 필드가 한때 `salesChannel: first.salesChannel` 이었고, 바로 위 날짜 3종이
   * **그룹 스칼라 dual-read** 라 `first` 에서 읽는 것이 맞다는 사실에 묻어 함께 들어갔다.
   * 날짜는 전 멤버가 같은 값을 들지만 **채널은 아니다** — 두 규약을 한 덩어리로 보지 말 것.
   */
  salesChannels: SalesChannel[];
  expectedDepositDate: string | null;
  expectedPayoutDate: string | null;
  expectedSupplierPayoutDate: string | null;
  /** 실제로 오간 날 — 완료된 칸은 예정일이 아니라 여기에 선다. */
  depositReceivedAt: string | null;
  payoutCompletedAt: string | null;
  supplierPayoutCompletedAt: string | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
  members: MobileCalendarCampaign[];
};

function campaignItem(campaign: MobileCalendarCampaign): MobileCalendarItem {
  return {
    kind: "campaign",
    key: campaign.id,
    groupId: campaign.groupId,
    dealName: campaign.dealName,
    sellerName: campaign.sellerName,
    sellerId: campaign.sellerId,
    roundNumber: campaign.roundNumber,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    status: campaign.status,
    salesChannels: [campaign.salesChannel],
    expectedDepositDate: campaign.expectedDepositDate,
    expectedPayoutDate: campaign.expectedPayoutDate,
    expectedSupplierPayoutDate: campaign.expectedSupplierPayoutDate,
    depositReceivedAt: campaign.depositReceivedAt,
    payoutCompletedAt: campaign.payoutCompletedAt,
    supplierPayoutCompletedAt: campaign.supplierPayoutCompletedAt,
    isDepositReceived: campaign.isDepositReceived,
    isPayoutCompleted: campaign.isPayoutCompleted,
    isSupplierPayoutCompleted: campaign.isSupplierPayoutCompleted,
    members: [campaign],
  };
}

function minIso(values: string[]): string {
  return values.reduce((min, value) => (value < min ? value : min), values[0]);
}

function maxIso(values: string[]): string {
  return values.reduce((max, value) => (value > max ? value : max), values[0]);
}

function groupItem(groupId: string, members: MobileCalendarCampaign[]): MobileCalendarItem {
  const sorted = [...members].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.dealName.localeCompare(b.dealName, "ko"),
  );
  const first = sorted[0];
  const groupName = first.groupName?.trim();
  // 폴딩이 함께 내주는 `slots` 는 여기서 버린다 — 이 항목은 채널 배열을 payload 로
  // 들고 다니고 소비처가 **같은 SSOT**(`resolveMoneySlotsForChannels`)로 슬롯을 파생하므로
  // 사본이 생기지 않는다(아래 `salesChannels` 주석).
  const { slots: _slots, ...moneyFold } = foldGroupMoney(sorted);
  return {
    kind: "group",
    key: `group:${groupId}`,
    groupId,
    dealName: groupName || `${first.dealName} 외 ${sorted.length - 1}`,
    sellerName: first.sellerName,
    sellerId: first.sellerId,
    roundNumber: null,
    startDate: minIso(sorted.map((member) => member.startDate)),
    endDate: maxIso(sorted.map((member) => member.endDate)),
    status: representativeStatus(sorted.map((member) => member.status as CampaignStatus)),
    // ⚠️ 여기서부터 **세 규약이 갈린다**(금액=합산 · 예정일=대표 · 완료=전원). 손으로
    // 다시 조합하지 말 것 — 정본은 `foldGroupMoney` 이고 데스크톱 캘린더 팝오버가 같은
    // 함수를 쓴다(그 표면이 대표 멤버 금액을 써서 3인 조합을 1/3 로 보이던 결함을 고친
    // 자리다). 채널 배열은 판정이 아니라 **멤버 컬럼 투영**이라 여기 남는다 — 소비처는
    // 그 배열을 `resolveMoneySlotsForChannels`(합집합 SSOT)에 넘긴다.
    salesChannels: sorted.map((member) => member.salesChannel),
    ...moneyFold,
    members: sorted,
  };
}

export function buildMobileCalendarItems(campaigns: MobileCalendarCampaign[]): MobileCalendarItem[] {
  const byGroup = new Map<string, MobileCalendarCampaign[]>();
  const singles: MobileCalendarCampaign[] = [];

  for (const campaign of campaigns) {
    if (!campaign.groupId) {
      singles.push(campaign);
      continue;
    }
    const list = byGroup.get(campaign.groupId) ?? [];
    list.push(campaign);
    byGroup.set(campaign.groupId, list);
  }

  const items: MobileCalendarItem[] = singles.map(campaignItem);
  for (const [groupId, members] of byGroup) {
    if (members.length < 2) {
      items.push(...members.map(campaignItem));
    } else {
      items.push(groupItem(groupId, members));
    }
  }

  return items.sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.dealName.localeCompare(b.dealName, "ko"),
  );
}
