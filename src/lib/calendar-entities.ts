import type { CampaignStatus } from "@/lib/crm-types";
import type { ScheduleGap } from "@/lib/schedule-gap-briefing";
import {
  resolveMoneySlotAmountDisplay,
  resolveMoneySlotDisplayAmount,
  resolveMoneySlotEffectiveDate,
  resolveMoneySlotGroupFold,
  resolveMoneySlotsForChannels,
  type CampaignMoneySlot,
  type MoneySlotAmountDisplay,
} from "@/lib/tax-filing-board";

/**
 * 캠페인 캘린더 렌더 엔티티 빌더 (디자인 무관 순수 로직).
 *
 * 인앱 캠페인 캘린더는 `SalesCampaign` 한 건당 바 하나를 그려서, 조합 캠페인
 * (같은 groupId·같은 셀러·같은 기간의 딜별 N건)이 똑같이 생긴 바 N개로 흩어져
 * 보였다(그룹 미반영). 여기서 같은 groupId 멤버를 하나의 "그룹 엔티티"로 병합해
 * 구글 캘린더 동기화([syncGroupOne])와 동일하게 그룹당 1개 바로 표현한다.
 *
 * 월 뷰는 해당 월과 교차하는 멤버만 로드되므로, 그룹 병합은 "이 달에 보이는
 * 멤버"를 기준으로 한다(2건 이상이면 그룹 바, 1건이면 개별 바로 폴백하되 groupId
 * 태그는 유지).
 */

export type CalendarCampaignInput = {
  id: string;
  dealName: string;
  sellerName: string;
  sellerId: string;
  groupId?: string | null;
  roundNumber?: number | null;
  startDate: string;
  endDate: string;
  status: CampaignStatus;
  /**
   * 자금 마커 슬롯 판정 축. ⚠️ **선택 필드로 둔 것은 의도가 아니라 하위호환이다** —
   * 값이 없으면 `resolveCampaignMoneySlots` 가 기본(셀러몰) 슬롯으로 접어 자사몰의
   * 공급사 지급 마커가 사라진다. 새 호출부는 반드시 채워 넣는다.
   */
  salesChannel?: string | null;
  expectedDepositDate?: string | null;
  expectedPayoutDate?: string | null;
  expectedSupplierPayoutDate?: string | null;
  /**
   * 실제로 오간 날. 완료된 칸은 예정일이 아니라 여기에 선다
   * (`resolveMoneySlotEffectiveDate`). 값이 없으면 예정일에 남으므로 빠뜨려도 크래시는
   * 없지만 **고치기 전 동작으로 조용히 되돌아간다** — 새 호출부는 반드시 채운다.
   */
  depositReceivedAt?: string | null;
  payoutCompletedAt?: string | null;
  supplierPayoutCompletedAt?: string | null;
  // 대금 금액 축 — 어느 근거를 읽는지는 채널이 정한다(`resolveMoneySlotDisplayAmount`).
  // ⚠️ 위 날짜·플래그와 달리 **필수**다. 빠뜨리면 금액이 조용히 「미정」이 되는데
  // 크래시가 없어 아무도 모른다(그 상태로 오래 방치된 전례가 이 필드의 이력이다).
  settlementSales: number | null;
  actualSales: number | null;
  sellerExpense: number | null;
  actualPayoutAmount: number | null;
  /** 공급사 지급 칸의 근거(수기 물품대금). 위 넷과 같은 이유로 **필수**다. */
  settlementGoodsCost: number | null;
  isDepositReceived?: boolean;
  isPayoutCompleted?: boolean;
  isSupplierPayoutCompleted?: boolean;
};

export type CalendarEntity = {
  kind: "campaign" | "group";
  /** 렌더/충돌 키: 캠페인 id 또는 `group:{groupId}` */
  key: string;
  groupId: string | null;
  /** 바에 표시할 라벨 (셀러명 포함) */
  label: string;
  /**
   * 라벨의 딜 부분(개별은 "딜 N차", 조합은 "대표딜 외 N"). 자금 마커 툴팁처럼 셀러명을
   * 따로 배치하는 표면이 **같은 문자열 조립을 다시 하지 않게** 여기서 소유한다.
   */
  dealLabel: string;
  sellerName: string;
  sellerId: string;
  /** 그룹은 가장 덜 진행된 멤버 상태(대표 색) */
  status: CampaignStatus;
  /** 그룹은 멤버 min(startDate) */
  startDate: string;
  /** 그룹은 멤버 max(endDate) */
  endDate: string;
  memberCount: number;
  /** 상세/툴팁용 원본 멤버 (startDate 오름차순) */
  members: CalendarCampaignInput[];
};

// 그룹 대표 상태 = 가장 덜 진행된 멤버(status는 딜별 독립) — 전원이 끝나기
// 전까지 완료 색으로 보이지 않게 하는 보수적 선택. google-calendar-sync의
// STATUS_PRECEDENCE와 동일 규칙(DROPPED는 대표 계산에서 제외).
const REPRESENTATIVE_PRECEDENCE: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
];

export function representativeStatus(statuses: CampaignStatus[]): CampaignStatus {
  let minIndex = Number.POSITIVE_INFINITY;
  for (const status of statuses) {
    const index = REPRESENTATIVE_PRECEDENCE.indexOf(status);
    if (index !== -1 && index < minIndex) minIndex = index;
  }
  return Number.isFinite(minIndex)
    ? REPRESENTATIVE_PRECEDENCE[minIndex]
    : statuses[0] ?? "PROPOSAL";
}

function roundSuffix(roundNumber: number | null | undefined): string {
  return roundNumber && roundNumber > 1 ? ` ${roundNumber}차` : "";
}

function singleEntity(campaign: CalendarCampaignInput): CalendarEntity {
  const dealLabel = `${campaign.dealName}${roundSuffix(campaign.roundNumber)}`;
  return {
    kind: "campaign",
    key: campaign.id,
    groupId: campaign.groupId ?? null,
    label: `${dealLabel} · ${campaign.sellerName}`,
    dealLabel,
    sellerName: campaign.sellerName,
    sellerId: campaign.sellerId,
    status: campaign.status,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    memberCount: 1,
    members: [campaign],
  };
}

/**
 * 로드된 월 캠페인을 렌더 엔티티로 변환한다. 같은 groupId 멤버가 2건 이상이면
 * 그룹 바 하나로 병합(라벨=대표딜 외 N·셀러, 색=대표 상태, 기간=min~max),
 * 1건이면 개별 바로 폴백한다. 결과는 startDate→label 안정 정렬.
 */
export function buildCalendarEntities(
  campaigns: CalendarCampaignInput[],
): CalendarEntity[] {
  const byGroup = new Map<string, CalendarCampaignInput[]>();
  const singles: CalendarCampaignInput[] = [];

  for (const campaign of campaigns) {
    if (campaign.groupId) {
      const list = byGroup.get(campaign.groupId) ?? [];
      list.push(campaign);
      byGroup.set(campaign.groupId, list);
    } else {
      singles.push(campaign);
    }
  }

  const entities: CalendarEntity[] = [];

  for (const [groupId, members] of byGroup) {
    if (members.length < 2) {
      // 이 달에 보이는 멤버가 1건뿐 — 개별 바로 폴백(groupId 태그 유지).
      for (const member of members) entities.push(singleEntity(member));
      continue;
    }
    const sorted = [...members].sort((a, b) =>
      a.startDate.localeCompare(b.startDate),
    );
    const startDate = sorted.reduce(
      (min, c) => (c.startDate < min ? c.startDate : min),
      sorted[0].startDate,
    );
    const endDate = sorted.reduce(
      (max, c) => (c.endDate > max ? c.endDate : max),
      sorted[0].endDate,
    );
    const sellerName = sorted[0].sellerName;
    const dealLabel = `${sorted[0].dealName} 외 ${members.length - 1}`;
    entities.push({
      kind: "group",
      key: `group:${groupId}`,
      groupId,
      label: `${dealLabel} · ${sellerName}`,
      dealLabel,
      sellerName,
      sellerId: sorted[0].sellerId,
      status: representativeStatus(members.map((m) => m.status)),
      startDate,
      endDate,
      memberCount: members.length,
      members: sorted,
    });
  }

  for (const campaign of singles) entities.push(singleEntity(campaign));

  entities.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) || a.label.localeCompare(b.label),
  );
  return entities;
}

// ── 자금 마커 (입금/지급 예정·완료·지연) ──────────────────────────────
// 캘린더 부제 "입금/지급 예정일을 한눈에"를 실제 판단가치로 만든다. "예정"만이
// 아니라 "지연"(기한 경과·미완료)까지 3단으로 분류해야 리스크가 드러난다.
// 그룹 캠페인의 자금 예정일은 백엔드가 그룹 값을 멤버 전원에 dual-read해 내려준다
// (mobile-calendar-data). 그래서 멤버를 각각 순회해도 **날짜는** 맞았지만, 조합의 입금은
// 실세계에서 한 번 일어나는 사건인데 도트가 멤버 수만큼 섰다 — 마커는 바와 같은 엔티티를
// 순회해 조합당 슬롯 하나만 그린다(아래 collectMoneyMarkersByDate).

export type MoneyMarkerState = "completed" | "pending" | "overdue";

export type MoneyMarkerEvent = {
  /**
   * 이 마커를 만든 렌더 엔티티의 키(`CalendarEntity.key` — 캠페인 id 또는 `group:{id}`).
   * 팝오버가 이 키로 엔티티를 되찾아 **바를 눌렀을 때와 같은 상세**를 연다. ⛔ 대표 멤버
   * id 로 되돌리지 말 것 — 조합 마커가 멤버 한 건의 상세를 열어 금액이 1/N 로 보인다.
   */
  entityKey: string;
  /** 바 라벨에서 셀러명을 뺀 부분(조합이면 "대표딜 외 N") — 라벨 조립을 화면이 재발명하지 않는다. */
  dealLabel: string;
  sellerName: string;
  /** 접힌 멤버 수(개별은 1). 금액이 **몇 건의 합계**인지 밝히는 데 쓴다(P2). */
  memberCount: number;
  /**
   * **색·아이콘 축 = 자금 방향**(`money-direction.ts` 와 같은 축). 자사몰의 두 지급은
   * 상대만 다르고 방향은 같으므로 **둘 다 `payout`** 이다 — 색으로 가르지 않는다.
   */
  direction: "deposit" | "payout";
  /**
   * 슬롯 안정 키. 같은 캠페인의 두 지급이 같은 날에 겹칠 수 있어 **렌더 키가
   * `campaignId` 만으로는 충돌한다**(React key 중복 → 한 건이 사라진다).
   */
  slotKey: CampaignMoneySlot["key"];
  /** 라벨 어휘("입금"/"지급") — 슬롯 SSOT. ⛔ 화면에서 다시 삼항으로 만들지 말 것. */
  verb: CampaignMoneySlot["verb"];
  /** 상대("공급사"/"셀러") — 자사몰의 두 지급을 가르는 **유일한** 표기. */
  counterpartLabel: string;
  state: MoneyMarkerState;
  /** 조합이면 **멤버 합산**이다(`foldGroupMoney` 규약) — `memberCount` 와 함께 읽는다. */
  amount: number | null;
  /** 엔티티를 못 찾았을 때의 팝오버 폴백용 대표 멤버 */
  member: CalendarCampaignInput;
};

/**
 * 슬롯 금액을 읽을 수 있는 **최소 형태**. `CalendarCampaignInput` 을 요구하지 않는 이유는
 * 소비처가 화면 밖에도 있기 때문이다 — 구글 캘린더 동기화(`google-calendar-sync.ts`)는
 * 자기 쿼리 타입으로, 조합 팝오버는 폴딩 결과(`GroupMoneyFold`)로 이 금액을 읽는다.
 * 판정(어느 슬롯이 어느 컬럼을 보는가)을 그쪽에 복사하지 않으려면 이 함수가 구조적으로
 * 열려 있어야 한다. ⛔ 소비처가 `kind === "DEPOSIT" ? deposit : payout` 삼항을 다시 쓰지
 * 말 것 — 위 `Record` 의 컴파일 가드(새 슬롯 키가 늘면 여기서 깨진다)를 우회하는 사본이
 * 생긴다.
 *
 * ⚠️ **두 필드는 선택이 아니라 필수다(2026-08-25 승격).** 선택으로 두면 생산자가 금액을
 * 빠뜨려도 컴파일이 통과하고 화면에는 「미정」이 뜬다 — 크래시가 없어 아무도 모른다.
 * 실제로 컬럼을 갈아탈 때 이 강제가 없었다면 옛 필드를 그대로 넘기는 생산자가 조용히
 * 남았을 것이다. 값을 모르면 `null` 을 **명시**해서 넘긴다.
 */
export type MoneySlotAmountSource = {
  /** 총 거래액. 셀러몰 입금(= 매출 − 셀러수수료)의 근거. `null` 은 0 이 아니라 「미정」. */
  actualSales: number | null;
  /** 판매대행비(약정 셀러 정산금). 셀러 지급의 근거이자 셀러몰 입금의 차감분. */
  sellerExpense: number | null;
  /** 영업 수익. 브랜드몰 입금(총 RS)의 근거. */
  settlementSales: number | null;
  /** 실제 셀러 지급액. 있으면 셀러 지급 칸이 예정액(`sellerExpense`)보다 우선 읽는다. */
  actualPayoutAmount: number | null;
  /**
   * 수기 물품대금(매입 계산서 총액, 3-상태). **공급사 지급 칸의 유일한 근거**다
   * (오너 승인 2026-08-27, T-057). 공식 추정은 실물 대조에서 기각됐다 —
   * 근거는 `MoneySlotAmountInput.settlementGoodsCost`(tax-filing-board.ts).
   */
  settlementGoodsCost: number | null;
};

/**
 * 슬롯이 표시할 금액 — 판정은 슬롯 SSOT(`resolveMoneySlotDisplayAmount`)가 소유한다.
 *
 * ⚠️ **컬럼 고정 표로 되돌리지 말 것(오너 확정 2026-08-26).** 슬롯 키 → 컬럼 하나로
 * 박으면 **채널마다 다른 금액 기준을 표현할 수 없다** — 브랜드몰 입금은 영업수익이지만
 * 셀러몰 입금은 「매출 − 셀러수수료」다(세금계산서 의무표, 오너 확인). 채널을 무시하고
 * 한 컬럼으로 접으면 셀러몰 캠페인에서 **다른 거래의 숫자가 입금 칸에 뜬다**(프로덕션
 * 108건 중 셀러몰 그룹 19건이 여기 해당).
 */
export function moneySlotAmount(
  source: MoneySlotAmountSource,
  slot: CampaignMoneySlot,
): number | null {
  return resolveMoneySlotDisplayAmount(slot, source);
}

/**
 * 화면에 적을 것 — 금액이 아니라 **상태**인 경우(합산 이관)를 가려낸다.
 * 산술이 필요한 자리(합계·그룹 접기)는 위 `moneySlotAmount` 를 그대로 쓴다.
 */
export function moneySlotAmountDisplay(
  source: MoneySlotAmountSource,
  slot: CampaignMoneySlot,
): MoneySlotAmountDisplay {
  return resolveMoneySlotAmountDisplay(slot, source);
}

/**
 * 이미 계산된 숫자를 표시 판정으로 감싼다 — **합산 이관 상태가 성립하지 않는 자리** 전용
 * (그룹 합계처럼 캠페인 단위 마커에 대응이 없는 값). ⛔ 단일 캠페인에 쓰지 말 것:
 * 그러면 합산 이관이 `₩0` 으로 새어 나와 이 타입을 만든 이유가 사라진다.
 */
export function toMoneySlotAmountDisplay(amount: number | null): MoneySlotAmountDisplay {
  return amount == null ? { kind: "UNKNOWN" } : { kind: "AMOUNT", amount };
}

// ── 조합(그룹) 대금 폴딩 ──────────────────────────────────────────────
// 한 조합의 대금 칸을 만들 때 **세 규약이 각각 다르다.** 이 셋을 표면마다 손으로 다시
// 조합하면 같은 조합의 같은 칸이 화면마다 다른 숫자로 뜬다(실제로 그랬다 — 데스크톱
// 팝오버가 대표 멤버 한 명의 금액을 써서 3인 조합이 1/3 만 보였다).
//
//  ① **금액 = 멤버 합산.** `CampaignGroup` 에는 `settlementSales`·`actualPayoutAmount`
//     **컬럼 자체가 없다**(CG-1 정산 방화벽 — 정산 금액은 딜 고유 값). 날짜·플래그와
//     달리 dual-read 로 멤버에 복사되지도 않으므로 대표에서 읽으면 멤버 수만큼 과소
//     표시된다. 합산이 실세계 금액이라는 규약은 `agenda-settlements.ts` 가 먼저 썼다.
//  ② **예정일 = 대표 멤버 값.** 그룹 스칼라(CG-2 dual-read)라 전 멤버가 같은 값을 든다
//     (`mobile-calendar-data` 가 그룹 소속이면 그룹 값을 무조건 내려준다).
//  ③ **완료 플래그 = 전원 완료.** 한 멤버라도 남아 있으면 그 칸은 끝나지 않았다.
//
// 슬롯 판정은 멤버 채널 **합집합**(`resolveMoneySlotsForChannels`)이다 — 대표 채널
// 하나를 고르면 섞인 그룹에서 한 레그가 조용히 사라진다(#463 이 모바일에서 고친 것과
// 같은 결함이 데스크톱에 남아 있었다).

/** 폴딩이 읽는 멤버 필드. 캘린더 입력·모바일 항목이 그대로 구조적으로 만족한다. */
export type GroupMoneyMember = MoneySlotAmountSource & {
  salesChannel?: string | null;
  expectedDepositDate?: string | null;
  expectedPayoutDate?: string | null;
  expectedSupplierPayoutDate?: string | null;
  depositReceivedAt?: string | null;
  payoutCompletedAt?: string | null;
  supplierPayoutCompletedAt?: string | null;
  isDepositReceived?: boolean;
  isPayoutCompleted?: boolean;
  isSupplierPayoutCompleted?: boolean;
};

/**
 * 조합 하나의 대금 뷰 — 캠페인 행과 **같은 모양**이라 슬롯 구동 코드가 그대로 읽는다
 * (`fold[slot.expectedField]` · `fold[slot.flagField]` · `moneySlotAmount(fold, slot)`).
 */
export type GroupMoneyFold = {
  /** 이 조합에 존재하는 대금 칸(멤버 채널 합집합, 입력 순서 유지). */
  slots: CampaignMoneySlot[];
  expectedDepositDate: string | null;
  expectedPayoutDate: string | null;
  expectedSupplierPayoutDate: string | null;
  /** 실제로 오간 날 — 예정일과 같은 「대표 멤버 = 그룹 정본」 규약을 탄다. */
  depositReceivedAt: string | null;
  payoutCompletedAt: string | null;
  supplierPayoutCompletedAt: string | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
};

/**
 * ⛔ **null 을 0 으로 접지 말 것** — 전원 미입력은 「확인된 0원」이 아니라 「금액 미정」
 * 이고, 대금 대조 화면에서 둘이 같은 모양이 되면 과소집계가 조용히 통과한다
 * (`agenda-settlements` 의 `targetAmount` 주석과 같은 규약).
 */
function sumNullable(values: Array<number | null | undefined>): number | null {
  const numeric = values.filter((value): value is number => value != null);
  return numeric.length === 0 ? null : numeric.reduce((sum, value) => sum + value, 0);
}

/**
 * 조합 멤버들을 대금 칸 하나로 접는다(위 세 규약의 **유일한** 구현체).
 *
 * 호출부는 **안정된 순서**(예: startDate 오름차순)로 넘긴다 — ②가 대표 멤버를 읽고
 * 슬롯 라벨도 먼저 온 채널을 따르므로, 순서가 흔들리면 표시가 흔들린다.
 * ⚠️ 채널 미상 멤버는 빈 문자열로 넘겨 기본(셀러몰) 슬롯으로 접는다. 멤버를 **제외**
 * 하면 슬롯이 0개가 되어 대금 칸이 통째로 사라진다(크래시가 아니라 침묵형 오표시).
 */
export function foldGroupMoney(members: readonly GroupMoneyMember[]): GroupMoneyFold {
  const representative: GroupMoneyMember = members[0] ?? {};
  // 멤버가 없으면 「전원 완료」가 되는 `every()` 의 공허 참을 막는다.
  const allDone = (field: CampaignMoneySlot["flagField"]) =>
    members.length > 0 && members.every((member) => Boolean(member[field]));

  return {
    slots: resolveMoneySlotsForChannels(members.map((m) => m.salesChannel ?? "")),
    expectedDepositDate: representative.expectedDepositDate ?? null,
    expectedPayoutDate: representative.expectedPayoutDate ?? null,
    expectedSupplierPayoutDate: representative.expectedSupplierPayoutDate ?? null,
    // 완료일도 예정일과 같은 자리에서 온다 — 그룹 소속 멤버 행은 `campaign-row` /
    // `mobile-calendar-data` 가 이미 그룹 스칼라를 실어 주므로 대표 멤버가 곧 그룹 값이다.
    depositReceivedAt: representative.depositReceivedAt ?? null,
    payoutCompletedAt: representative.payoutCompletedAt ?? null,
    supplierPayoutCompletedAt: representative.supplierPayoutCompletedAt ?? null,
    isDepositReceived: allDone("isDepositReceived"),
    isPayoutCompleted: allDone("isPayoutCompleted"),
    isSupplierPayoutCompleted: allDone("isSupplierPayoutCompleted"),
  };
}

/**
 * **조합 캠페인의 슬롯 금액 = 멤버 합산.** `CampaignGroup` 에는 정산 금액 컬럼이 없고
 * (`settlementSales`·`actualPayoutAmount` 은 `SalesCampaign` 소유), `campaign-row.ts` 도
 * 날짜·플래그와 달리 금액은 그룹 값으로 폴딩하지 않는다. 그래서 그룹 한 건의 대금은
 * 멤버 값을 더해야 나온다(모바일 `mobile-calendar-groups.ts` 와 `agenda-settlements.ts`
 * 가 이미 쓰던 규약 그대로다).
 *
 * ⛔ **전원이 값 없음이면 0 이 아니라 `null`(= 「미정」)이다** — 금전 대조에서 「0원」은
 * 확인된 0 으로 읽힌다. 금액 컬럼 자체가 없는 슬롯(자사몰 공급사 지급)도 같은 이유로
 * 항상 `null` 이다.
 */
export function sumMoneySlotAmounts(
  members: readonly MoneySlotAmountSource[],
  slot: CampaignMoneySlot,
): number | null {
  // ⛔ **근거 필드를 먼저 합산해 기준을 나중에 적용하지 말 것.** 뺄셈 기준
  // (셀러몰 입금 = 매출 − 수수료)에서 한 멤버의 빼는 값만 없으면, 필드를 먼저 합치는
  // 순서는 그 멤버의 매출을 **그대로 남겨** 합계를 부풀린다. 멤버별로 계산하면 그
  // 멤버가 `null` 이 되어 합산에서 빠진다 — 모르는 건은 빼고 세는 것이 맞다.
  const amounts = members.map((member) => moneySlotAmount(member, slot));
  // ⚠️ **"모르는 건은 빼고 센다"가 전 기준에 통하지는 않는다.** 물품대금은 그룹이
  // **계산서 한 장**이라 입력된 멤버만 더하면 「일부만 반영된 합계」가 실물 총액인 것처럼
  // 보인다(`sumGroupManualGoodsCost` 가 같은 이유로 부분 합산을 금지한다). 기준별 규약은
  // 슬롯 SSOT 가 소유한다 — ⛔ 여기서 `amountBasis` 를 다시 분기하지 말 것.
  if (resolveMoneySlotGroupFold(slot) === "ALL_OR_NOTHING" && amounts.some((a) => a === null)) {
    return null;
  }
  return sumNullable(amounts);
}

function markerState(
  done: boolean | undefined,
  dateStr: string,
  todayStr: string,
): MoneyMarkerState {
  if (done) return "completed";
  return dateStr < todayStr ? "overdue" : "pending";
}

/**
 * 날짜(YYYY-MM-DD)별 자금 마커 목록.
 *
 * **입력이 캠페인 배열이 아니라 엔티티 배열인 것이 이 함수의 계약이다** — 바와 마커가
 * **같은 그룹 판정**을 쓰게 만드는 유일한 장치다. 종전에는 원본 캠페인을 순회해서, 바는
 * 조합 1개인데 도트는 멤버 수만큼 흩어졌다(3인 조합의 입금이 3건처럼 보였고 「+N」 접힘도
 * 한 조합이 혼자 차지했다). ⛔ 여기서 `groupId` 로 다시 묶지 말 것 — 두 번째 그룹핑이
 * 생기는 순간 같은 결함이 다른 얼굴로 돌아온다.
 *
 * 바 렌더(기간 교차)와 달리 마커는 **예정일** 기준이라 엔티티 전체를 순회한다 — 이 달에
 * 바는 없지만 자금 예정일만 이 달에 있는 캠페인도 API가 함께 실어오고
 * (`buildCalendarEntities` 도 월로 거르지 않으므로) 여기서 자연히 잡힌다.
 */
export function collectMoneyMarkersByDate(
  entities: CalendarEntity[],
  todayStr: string,
): Map<string, MoneyMarkerEvent[]> {
  const byDate = new Map<string, MoneyMarkerEvent[]>();
  const push = (dateStr: string, event: MoneyMarkerEvent) => {
    const list = byDate.get(dateStr) ?? [];
    list.push(event);
    byDate.set(dateStr, list);
  };

  for (const entity of entities) {
    // 개별 캠페인도 같은 경로를 탄다 — 멤버 1건 폴딩은 그 캠페인 자신이라(합산=자기 값,
    // 전원 완료=자기 플래그, 슬롯 합집합=자기 채널) 분기가 필요 없다.
    const money = foldGroupMoney(entity.members);
    const representative = entity.members[0];
    if (!representative) continue;
    // ⛔ 채널 분기를 여기서 다시 쓰지 말 것 — 마커가 몇 개이고 어느 필드를 읽는지는
    // 전부 슬롯이 들고 온다. 자사몰이면 지급 마커가 둘이고 **입금 마커가 없다**
    // (몰 정산금은 캠페인 기간 동안 일별로 들어와 단일 예정일이 실효가 없다 —
    // 오너 확정 2026-08-25. 과거 입금 기록도 캘린더에는 그리지 않는다).
    for (const slot of money.slots) {
      // ⛔ `money[slot.expectedField]` 를 직접 읽지 말 것 — 완료된 칸은 **실제로 오간 날**
      // 에 선다(오너 지적 2026-07-15). 판정은 슬롯 SSOT 소유다.
      const { date: effective } = resolveMoneySlotEffectiveDate(slot, money);
      if (!effective) continue;
      const dateStr = effective.slice(0, 10);
      push(dateStr, {
        entityKey: entity.key,
        dealLabel: entity.dealLabel,
        sellerName: entity.sellerName,
        memberCount: entity.memberCount,
        direction: slot.kind === "DEPOSIT" ? "deposit" : "payout",
        slotKey: slot.key,
        verb: slot.verb,
        counterpartLabel: slot.counterpartLabel,
        state: markerState(money[slot.flagField], dateStr, todayStr),
        amount: sumMoneySlotAmounts(entity.members, slot),
        member: representative,
      });
    }
  }

  return byDate;
}

// ── 일정 공백(매출 공백) 틴트 ──────────────────────────────────────────
// getScheduleGapBriefing()의 ScheduleGap(확정 캠페인이 하루도 없는 빈 구간)을
// 캘린더 셀 배경 틴트용 날짜별 긴급도 맵으로 펼친다. DANGER/URGENT만 그리드에
// 칠한다(CAUTION/PREPARE는 30~90일 밖이라 그리드까지 물들이면 "긴급" 신호가
// 희석됨 — 모바일 weekUrgency와 동일 정책). 갭 날짜에는 정의상 캠페인 바가
// 없으므로(바가 있으면 갭이 아님) 바와 틴트가 구조적으로 충돌하지 않는다.

export function buildGapUrgencyByDate(
  gaps: ScheduleGap[],
): Map<string, "DANGER" | "URGENT"> {
  const byDate = new Map<string, "DANGER" | "URGENT">();
  for (const gap of gaps) {
    if (gap.urgency !== "DANGER" && gap.urgency !== "URGENT") continue;
    const startMs = Date.parse(`${gap.startDate.slice(0, 10)}T00:00:00Z`);
    const endMs = Date.parse(`${gap.endDate.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
      const ymd = new Date(ms).toISOString().slice(0, 10);
      // DANGER가 URGENT를 덮어쓰되 그 반대는 아님(더 급한 신호 우선).
      if (byDate.get(ymd) !== "DANGER") byDate.set(ymd, gap.urgency);
    }
  }
  return byDate;
}
