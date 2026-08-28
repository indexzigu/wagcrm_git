// 대시보드 "지연된 정산" 목록 빌더 (client-safe 순수 로직).
//
// 그룹캠페인(CG-1) 규약: 대금 결제의 이벤트 필드(플래그·날짜)는 **그룹 소유**가 SoT다.
// 멤버 행의 플래그는 낡을 수 있으므로 멤버 값으로 지연을 판정하면 이미 입금된 그룹이
// 멤버 수만큼 지연 건으로 부풀려진다. 그래서 그룹 멤버는 ①그룹 플래그로 판정하고
// ②그룹당 1행(그룹명 라벨, 금액은 멤버 합산, id는 대표 멤버)으로 접는다.
// 대표 멤버 id를 그대로 쓰는 이유: PATCH /api/campaigns/[id]/settlement-status 가
// 그룹 멤버십을 감지해 그룹 플래그로 전파하므로 모달 액션이 그룹 전체에 적용된다.
//
// ⛔ **어느 칸이 존재하는지는 채널이 정한다** — `resolveCampaignMoneySlots`(슬롯 SSOT).
// 종전 이 파일은 「입금 → 지급」 두 축을 상수처럼 박아 뒀는데, 2026-08-25 자사몰이
// [공급사 지급, 셀러 지급]으로 갈리면서 ①공급사 지급 지연이 **아예 감지되지 않고**
// ②입금 플래그가 영원히 false 라 셀러 지급 예정일이 지나지 않아도 「입금 지연」이 뜰
// 수 있었다(입금 예정일이 남아 있는 레거시 행). 채널 분기를 여기 손으로 다시 쓰지 말 것.

import { resolveMoneySlotsForChannels, type CampaignMoneySlot } from "./tax-filing-board";
import {
  SETTLEMENT_STAGE_STATUSES,
  foldByGroup,
  foldedUnitLabel,
  isOverdueKst,
} from "./settlement-stage";

export type AgendaSettlementCampaign = {
  id: string;
  status: string;
  /** 슬롯 판정 입력 — 이 필드가 빠지면 자사몰이 셀러몰 슬롯으로 오판된다. */
  salesChannel: string;
  expectedDepositDate: Date | null;
  expectedPayoutDate: Date | null;
  expectedSupplierPayoutDate: Date | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
  settlementSales: { toString(): string } | number | string | null;
  actualPayoutAmount: { toString(): string } | number | string | null;
  groupId: string | null;
  group: {
    name: string | null;
    expectedDepositDate: Date | null;
    expectedPayoutDate: Date | null;
    expectedSupplierPayoutDate: Date | null;
    isDepositReceived: boolean;
    isPayoutCompleted: boolean;
    isSupplierPayoutCompleted: boolean;
  } | null;
  deal: { dealName: string };
  seller: { name: string; alias: string | null; accountNumber: string | null; snsType: string | null };
};

/**
 * 지연된 그 한 칸이 무엇인가 — 모달이 **어느 플래그를 쓸지·어느 금액을 대조할지**를
 * 여기서 받는다. ⛔ 소비처가 라벨 문자열을 파싱하거나 `kind` 로 필드를 다시 유도하지
 * 말 것(이 레포가 반복해서 겪은 「같은 판정의 두 번째 인코딩」).
 */
export type AgendaOverdueSlot = {
  kind: CampaignMoneySlot["kind"];
  verb: CampaignMoneySlot["verb"];
  counterpartLabel: string;
  flagField: CampaignMoneySlot["flagField"];
};

export type AgendaSettlementItem = {
  id: string;
  type: "SETTLEMENT";
  status: string;
  title: string;
  dealName: string;
  sellerName: string;
  dueDate: string | null;
  label: string;
  snsType: string | null;
  badgeColor: { bg: string; text: string; border: string };
  accountNumber: string | null;
  settlementSales: number;
  actualPayoutAmount: number;
  /** 지연된 칸 자체 — 모달의 쓰기 대상. */
  overdueSlot: AgendaOverdueSlot;
  /**
   * 모달이 대조할 금액. **null 은 0 이 아니라 「모름」이다** — 자사몰 공급사 지급 레그에는
   * 대응하는 금액 컬럼이 없다. 이 타입이 든 두 금액은 각각 **입금 축**(`settlementSales`
   * = 영업 수익)과 **셀러 지급 축**(`actualPayoutAmount`)이라 어느 쪽도 공급사 지급액이
   * 아니다.
   * 🪤 **후보였던 `settlementSupplyCost` 를 「죽은 컬럼」으로 읽지 말 것** — 그 필드는
   *    **공급가액**(= 우리 매출의 VAT 제외분, 패널이 `actualSales / 1.1` 로 계산)이라
   *    애초에 **축이 다르다.** 프로덕션 전건이 null 인 것은 죽어서가 아니라 **계산값
   *    폴백이 있는 수동 오버라이드**라 손으로 덮어쓸 일이 없었기 때문이다(입력란·PATCH
   *    스키마·저장 경로가 전부 살아 있다 — #480 이 지운 두 컬럼은 그 경로가 애초에
   *    0곳이었다는 점에서 성격이 다르다). 행 수만 세고 폴백 유무를 안 보면 같은 오판이
   *    반복된다(2026-08-27 실제로 한 번 났다). 설계 정본은
   *    `docs/private/specs/2026-08-07-settlement-money-separation-design.md` §표.
   * ⛔ 0 으로 접지 말 것: 금전 사고 예방용 대조 화면에서 「₩0」은 확인된 0으로 읽힌다.
   * ⚠️ 물품대금 공식(`goods-cost.ts`)을 끌어다 채우는 것도 금지다 — 그 모듈은 세무 대조
   * 전용이고 `expected-receivables-scope.contract.test.ts` 가 소스 스캔으로 막는다.
   */
  targetAmount: number | null;
};

// 정산 지연(대금 기한 초과) = urgent. status-badge.tsx의 DROPPED와 동일 레시피로,
// 대시보드 "오늘의 할 일" 카드에서 info 팔로업 배지와 나란히 놓여도 팔레트 정합 유지.
const URGENT_BADGE = {
  bg: "bg-status-urgent-bg",
  text: "text-status-urgent-text",
  border: "border-status-urgent/20",
};

function money(value: { toString(): string } | number | string | null): number {
  return value == null ? 0 : Number(value.toString());
}

function sellerLabel(c: AgendaSettlementCampaign): string {
  return c.seller.alias && c.seller.alias.trim() !== "" ? c.seller.alias : c.seller.name;
}

function earliest(dates: (Date | null)[]): Date | null {
  const valid = dates.filter((d): d is Date => d != null);
  return valid.length ? valid.reduce((a, b) => (a <= b ? a : b)) : null;
}

/** 그룹 dual-read 를 흡수한 「이 행의 유효 값」 조회기. */
type EffectiveSettlement = {
  flag: (field: CampaignMoneySlot["flagField"]) => boolean;
  date: (field: CampaignMoneySlot["expectedField"]) => Date | null;
};

function toItem(
  representative: AgendaSettlementCampaign,
  members: AgendaSettlementCampaign[],
  eff: EffectiveSettlement,
  now: Date,
): AgendaSettlementItem | null {
  // 슬롯 순서의 **첫 지연 칸**만 낸다. 종전 「입금 우선, 없으면 지급」과 같은 규칙이다
  // (브랜드몰·셀러몰 슬롯 순서가 [입금, 지급]이므로 동작이 바뀌지 않는다). 두 칸이 함께
  // 지연이어도 한 행만 내는 이유: 모달이 한 번에 한 칸만 쓰므로, 처리 후 새로고침에서
  // 다음 칸이 올라온다. 여러 행으로 쪼개면 같은 캠페인이 목록에서 두 자리를 차지한다.
  //
  // 칸 구성은 **묶음 전체 채널의 합집합**이다(`resolveMoneySlotsForChannels`) — 대표
  // 한 명의 채널로 정하면 형제가 다른 채널일 때 그 레그가 조용히 사라진다. 균일 채널
  // 묶음에서는 결과가 종전과 정확히 같다(운영상 조합은 채널이 하나다).
  const slots = resolveMoneySlotsForChannels(members.map((m) => m.salesChannel));
  let overdue: { slot: CampaignMoneySlot; date: Date } | null = null;
  for (const slot of slots) {
    if (eff.flag(slot.flagField)) continue;
    const date = eff.date(slot.expectedField);
    // ⛔ `date <= now` 로 되돌리지 말 것 — 예정일은 UTC 자정(=KST 09:00) 저장이라 그 식은
    // 오늘 예정인 건을 오전부터 지연으로 본다. 경계 SSOT 는 `settlement-stage.isOverdueKst`.
    if (date != null && isOverdueKst(date, now)) {
      overdue = { slot, date };
      break;
    }
  }
  if (!overdue) return null;

  const seller = sellerLabel(representative);
  const soloName = `${representative.deal.dealName} - ${seller}`;
  const title =
    representative.groupId == null
      ? soloName
      : foldedUnitLabel(
          members.map((m) => {
            const memberSeller = sellerLabel(m);
            return `${m.deal.dealName} - ${memberSeller}`;
          }),
          representative.group?.name,
        );

  // 정산 금액은 딜 고유 값(CG-1 정산 방화벽) — 그룹 표시는 멤버 합산이 실세계 금액이다.
  const settlementSales = members.reduce((sum, m) => sum + money(m.settlementSales), 0);
  const actualPayoutAmount = members.reduce((sum, m) => sum + money(m.actualPayoutAmount), 0);

  return {
    id: representative.id,
    type: "SETTLEMENT",
    status: representative.status,
    title,
    dealName: representative.deal.dealName,
    sellerName: seller,
    dueDate: overdue.date.toISOString(),
    // 상대를 병기한다 — 자사몰의 두 칸이 같은 「지급」이라 상대 없이는 구분이 안 되고,
    // 정산 목록 「정산일정」 열의 배지(`공급사 지급`)와 같은 문법이 된다(#453).
    label: `${overdue.slot.counterpartLabel} ${overdue.slot.verb} 지연`,
    snsType: representative.seller.snsType,
    badgeColor: URGENT_BADGE,
    accountNumber: representative.seller.accountNumber,
    settlementSales,
    actualPayoutAmount,
    overdueSlot: {
      kind: overdue.slot.kind,
      verb: overdue.slot.verb,
      counterpartLabel: overdue.slot.counterpartLabel,
      flagField: overdue.slot.flagField,
    },
    targetAmount:
      overdue.slot.flagField === "isDepositReceived"
        ? settlementSales
        : overdue.slot.flagField === "isPayoutCompleted"
          ? actualPayoutAmount
          : null,
  };
}

/**
 * 정산 단계(SETTLEMENT_WAIT/IN_PROGRESS) 캠페인 목록에서 지연 항목을 만든다.
 * 미그룹은 종전과 동일한 행 단위 판정, 그룹은 그룹 플래그(SoT)·그룹 날짜(null이면
 * 멤버 최솟값 폴백 — buildUpcomingEvents와 동일 규칙)로 그룹당 1건.
 */
export function buildOverdueSettlementItems(
  campaigns: AgendaSettlementCampaign[],
  now: Date,
): AgendaSettlementItem[] {
  const items: AgendaSettlementItem[] = [];

  // 모집단 게이트는 **여기에도** 둔다. 종전엔 라우트 쿼리에만 있어서 이 순수 함수 자체는
  // 어떤 상태든 받아 지연을 만들었다 — 짝인 `buildSettlementPending` 은 함수 안에서 걸러서,
  // 같은 입력을 두 표면에 넣으면 결과가 갈렸다(T-062 교차 픽스처에서 적발). 라우트 필터와
  // 중복이지만 **판정이 함수 밖에 있으면 계약으로 고정할 수 없다.**
  const inStage = campaigns.filter((c) =>
    (SETTLEMENT_STAGE_STATUSES as readonly string[]).includes(c.status),
  );

  // 접기 규칙은 `settlement-stage.foldByGroup`(SSOT) — 모바일 대기 목록이 같은 함수를 쓴다.
  for (const members of foldByGroup(inStage)) {
    const representative = members[0];
    if (representative.groupId == null) {
      const item = toItem(representative, members, {
        flag: (field) => representative[field],
        date: (field) => representative[field],
      }, now);
      if (item) items.push(item);
      continue;
    }
    const group = representative.group;
    const item = toItem(representative, members, {
      flag: (field) => group?.[field] ?? representative[field],
      date: (field) => group?.[field] ?? earliest(members.map((m) => m[field])),
    }, now);
    if (item) items.push(item);
  }

  // 마감일 오름차순(가장 오래 지연된 건 먼저) — 그룹 행이 뒤에 합류하므로 정렬 없이는
  // 대시보드 접힌 미리보기(상위 3건)에서 더 급한 그룹 건이 가려질 수 있다.
  return items.sort((a, b) => (a.dueDate ?? "￿").localeCompare(b.dueDate ?? "￿"));
}
