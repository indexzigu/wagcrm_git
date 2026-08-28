"use client";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { formatCurrency, formatDateWithWeekday } from "@/lib/format";
import {
  foldGroupMoney,
  moneySlotAmountDisplay,
  sumMoneySlotAmounts,
  toMoneySlotAmountDisplay,
} from "@/lib/calendar-entities";
import { MONEY_DIRECTION_ICON, MONEY_DIRECTION_TEXT } from "@/lib/money-direction";
import type { MobileSettlementCampaign } from "@/lib/mobile-settlement-data";
import { type CampaignMoneySlot, type MoneySlotAmountDisplay } from "@/lib/tax-filing-board";
import {
  SETTLEMENT_STAGE_STATUSES,
  foldByGroup,
  foldedUnitLabel,
} from "@/lib/settlement-stage";
import {
  MobileSheetAmount,
  MobileSheetCard,
  MobileSheetRow,
} from "./mobile-sheet-card";
import { MobileSheetHeader } from "./mobile-sheet-header";

/**
 * 정산 대기 목록 시트 (MOBILE_UX_PLAN §6 · Phase 3, v3.1 조회 전용).
 *
 * - 읽기 전용: 버튼·토글 일절 없음. 입금 확인·지급 완료 처리는 PC 전용(소유자 확정).
 * - 홈 자금 칩(입금/지급 대기) 탭으로 진입. 행 탭 → 캠페인 상세 시트(§5).
 * - 데이터는 전용 정산 스냅샷 MobileSettlementCampaign[](#149 리뷰 — 파이프라인
 *   kitchen-sink 대체)에서 클라이언트 계산 — 신규 API 없음. CampaignRow의 Pick이라
 *   전체 행도 그대로 대입 가능하다.
 * - 금액은 슬롯 SSOT 가 정한다(`moneySlotAmount` — 채널마다 근거가 다르다). 홈 칩과 시트가
 *   같은 함수를 쓰므로 합계가 항상 일치한다. ⛔ 종전 서술 「입금=settlementSales /
 *   셀러 지급=sellerExpense」는 **SUPERSEDED**(T-057) — 그건 이 파일이 들고 있던 손수 사본의
 *   규칙이고 셀러몰에서 다른 거래의 숫자를 띄웠다.
 *
 * ⛔ **입금/지급 두 줄을 손으로 만들지 말 것** — 칸 구성은 채널이 정한다. 자사몰은
 * [공급사 지급, 셀러 지급]이라 종전 코드에서는 ①공급사 지급이 대기 목록에 **아예 없었고**
 * ②입금 플래그가 영원히 false 여서 자사몰 전건이 「입금 대기」에 영구 상주했다.
 *
 * ⛔ **조합 캠페인을 딜마다 한 줄로 펴지 말 것**(T-062, 오너 확정 2026-08-27). 묶음은
 * 실캠페인 1개이고 대금도 한 번에 오간다 — 종전엔 이 목록만 안 접어서 멤버 4건짜리
 * 묶음 하나가 4줄을 차지하고 홈 자금 칩의 「입금 대기 N건」도 4로 셌다(같은 판정을
 * 데스크톱 아젠다는 접고 있었다).
 *
 * **판정은 전부 위임한다** — 어느 묶음이 한 단위인가·묶음 이름은 `settlement-stage`
 * (`foldByGroup`·`foldedUnitLabel`), 그 단위의 칸·예정일·완료·금액은 `calendar-entities`
 * (`foldGroupMoney`·`sumMoneySlotAmounts`)다. 이 파일에는 판정 사본이 없어야 한다.
 */

export type SettlementPendingRow = {
  /** 이 줄을 눌렀을 때 열 캠페인 — 묶음이면 대표 멤버. */
  campaign: MobileSettlementCampaign;
  /** 묶음이면 멤버 전원, 미그룹이면 자기 하나. 금액 합산·라벨의 근거. */
  members: MobileSettlementCampaign[];
  /** 줄에 찍히는 이름 — 묶음이면 묶음 이름(없으면 「… 외 N건」). */
  title: string;
  /** 이 행이 대표하는 칸 — 자사몰의 두 지급 줄을 상대로 가른다. */
  counterpartLabel: string;
  /** 완료 플래그 필드 — 한 묶음이 같은 섹션에 두 행을 낼 수 있어 key 로도 쓴다. */
  flagField: CampaignMoneySlot["flagField"];
  /** 예정일 YYYY-MM-DD (없으면 null — 정렬 시 맨 뒤) */
  dueYmd: string | null;
  /** null = 금액 미정 (합계에는 0으로 반영 — 홈 칩과 동일) */
  amount: number | null;
  /**
   * 화면에 적을 것. **합계용 `amount` 와 일부러 나눠 둔다** — 합산 이관은 산술에서는
   * 0 이 맞는 기여값이지만 표시에서는 금액이 아니라 상태다(`₩0` 으로 적으면 「확인된
   * 0원」으로 읽힌다). 둘 다 같은 루프에서 같은 슬롯·캠페인으로 만들어 갈리지 않는다.
   */
  amountDisplay: MoneySlotAmountDisplay;
  /** 예정일 < 오늘 && 미완료 */
  overdue: boolean;
};

export type SettlementPendingSection = {
  rows: SettlementPendingRow[];
  count: number;
  total: number;
};

export type SettlementPending = {
  deposit: SettlementPendingSection;
  payout: SettlementPendingSection;
};

function sortRows(rows: SettlementPendingRow[]): SettlementPendingRow[] {
  // 연체 우선(섹션 상단 분리), 그 안에서 예정일 오름차순 — 날짜 미정은 뒤로.
  return [...rows].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueYmd === b.dueYmd) return 0;
    if (a.dueYmd == null) return 1;
    if (b.dueYmd == null) return -1;
    return a.dueYmd < b.dueYmd ? -1 : 1;
  });
}

/** 금액 근거 5종을 한 곳에서 만든다 — 합계용과 표시용이 다른 값을 보면 안 된다. */
function amountSource(campaign: MobileSettlementCampaign) {
  return {
    actualSales: campaign.actualSales ?? null,
    sellerExpense: campaign.sellerExpense ?? null,
    settlementSales: campaign.settlementSales ?? null,
    actualPayoutAmount: campaign.actualPayoutAmount ?? null,
    settlementGoodsCost: campaign.settlementGoodsCost ?? null,
  };
}

/**
 * 폴딩 SSOT(`foldGroupMoney`)가 읽는 모양으로 옮긴다.
 *
 * ⚠️ **`?? null` 정규화가 이 함수의 존재 이유다** — `MobileSettlementCampaign` 은
 * `CampaignRow` 의 Pick 이라 금액 필드가 `number | null | undefined` 인데 SSOT 는
 * `number | null` 을 받는다. 여기서 좁혀 두지 않으면 호출부마다 각자 좁히게 되고,
 * 그러다 한 곳이 `undefined` 를 그대로 흘리면 **모름이 아니라 0 처럼 처리**될 수 있다.
 * 완료일 3종은 이 화면이 안 쓴다(대기 목록은 미완료 칸만 낸다) — 넘기지 않으면 SSOT 가
 * null 로 채우고 예정일 경로를 탄다.
 */
function groupMoneyMember(campaign: MobileSettlementCampaign) {
  return {
    ...amountSource(campaign),
    salesChannel: campaign.salesChannel,
    expectedDepositDate: campaign.expectedDepositDate,
    expectedPayoutDate: campaign.expectedPayoutDate,
    expectedSupplierPayoutDate: campaign.expectedSupplierPayoutDate,
    isDepositReceived: campaign.isDepositReceived,
    isPayoutCompleted: campaign.isPayoutCompleted,
    isSupplierPayoutCompleted: campaign.isSupplierPayoutCompleted,
  };
}

/** 대기 목록 계산 — 순수 함수(테스트 대상). 홈 자금 칩 합계도 이 결과를 소비한다. */
export function buildSettlementPending(
  campaigns: MobileSettlementCampaign[],
  todayYmd: string,
): SettlementPending {
  const deposit: SettlementPendingRow[] = [];
  const payout: SettlementPendingRow[] = [];

  const inStage = campaigns.filter((c) =>
    (SETTLEMENT_STAGE_STATUSES as readonly string[]).includes(c.status),
  );

  for (const members of foldByGroup(inStage)) {
    const representative = members[0];
    const isGrouped = representative.groupId != null;
    const title = isGrouped
      ? foldedUnitLabel(
          members.map((m) => `${m.dealName} · ${m.sellerName}`),
          representative.groupName,
        )
      : `${representative.dealName} · ${representative.sellerName}`;

    // 칸 구성·예정일·완료 플래그는 **폴딩 SSOT**(`foldGroupMoney`, T-057)가 소유한다 —
    // 슬롯은 멤버 채널 합집합, 예정일은 대표(그룹 스칼라라 전원 동일), 완료는 전원 완료.
    // ⛔ 여기서 대표 필드를 직접 읽거나 채널을 다시 합치지 말 것: 종전 이 루프가 그
    //    사본이었고, 이 레포는 같은 조합이 화면마다 다른 숫자로 뜨는 사고를 이미 겪었다.
    //    멤버 1건 폴딩은 그 캠페인 자신이라 미그룹도 같은 경로를 탄다(분기 불요).
    const money = foldGroupMoney(members.map(groupMoneyMember));
    for (const slot of money.slots) {
      if (money[slot.flagField]) continue;
      const dueYmd = money[slot.expectedField]?.slice(0, 10) ?? null;
      // 합산도 SSOT 다 — **기준마다 접는 방식이 다르다**(`MoneySlotGroupFold`). 물품대금은
      // 그룹이 계산서 한 장이라 한 멤버라도 모르면 그룹 전체가 모름이고, 멤버마다 독립인
      // 기준은 아는 멤버만 더한다. ⛔ 여기서 `amountBasis` 를 다시 분기하지 말 것.
      const amount = sumMoneySlotAmounts(members.map(amountSource), slot);
      const row: SettlementPendingRow = {
        campaign: representative,
        members,
        title,
        counterpartLabel: slot.counterpartLabel,
        flagField: slot.flagField,
        dueYmd,
        amount,
        // 표시는 **단일이냐 접힌 묶음이냐로 갈린다**(SSOT 주석이 못박은 짝):
        // 합산 이관(`0`)은 캠페인 단위 마커라 단일에서만 상태로 성립하고, 접힌 값에는
        // 대응이 없어 숫자를 그대로 감싼다. ⛔ 한쪽 함수로 통일하지 말 것 —
        // `toMoneySlotAmountDisplay` 를 단일에 쓰면 합산 이관이 `₩0` 으로 새어 나가고,
        // `moneySlotAmountDisplay` 를 묶음에 쓰면 대표 한 명의 상태가 묶음 전체를 대변한다.
        amountDisplay:
          members.length === 1
            ? moneySlotAmountDisplay(amountSource(representative), slot)
            : toMoneySlotAmountDisplay(amount),
        overdue: dueYmd != null && dueYmd < todayYmd,
      };
      (slot.kind === "DEPOSIT" ? deposit : payout).push(row);
    }
  }

  const toSection = (rows: SettlementPendingRow[]): SettlementPendingSection => ({
    rows: sortRows(rows),
    count: rows.length,
    total: rows.reduce((sum, row) => sum + (row.amount ?? 0), 0),
  });

  return { deposit: toSection(deposit), payout: toSection(payout) };
}

/**
 * 행 아래줄 — "7월 20일 (월) 예정".
 *
 * ⛔ 예정일이 지나도 **문구를 바꾸지 않는다**(오너 지시 2026-08-26 — 색·배지·서브텍스트
 * 어느 것으로도 경과를 표기하지 않는다). 종전 주석은 *"지연 여부는 배지가 말한다"* 였는데
 * 그 배지는 제거됐다 — 그 공백을 여기 텍스트로 메우려 하지 말 것.
 */
function formatDueLabel(dueYmd: string | null): string {
  if (!dueYmd) return "예정일 미정";
  return `${formatDateWithWeekday(dueYmd)} 예정`;
}

type MobileSettlementPendingSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaigns: MobileSettlementCampaign[];
  todayYmd: string;
  /** 행 탭 → 캠페인 상세 시트(§5) 열기 */
  onOpenCampaign: (campaign: MobileSettlementCampaign) => void;
};

export function MobileSettlementPendingSheet({
  open,
  onOpenChange,
  campaigns,
  todayYmd,
  onOpenCampaign,
}: MobileSettlementPendingSheetProps) {
  const pending = buildSettlementPending(campaigns, todayYmd);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        // top-0: side=bottom 기본(inset-x-0 bottom-0)에 상단 고정을 더해 풀스크린으로 확장
        className="mobile-sheet-safe-bottom top-0 gap-0 overflow-y-auto rounded-none border-0 bg-slate-50 p-0"
      >
        <MobileSheetHeader
          title="정산 대기"
          description="조회 전용 · 입금·지급 처리는 PC에서"
          closeLabel="대기 목록 닫기"
        />

        <div className="flex flex-col gap-2.5 px-3 py-3">
          <PendingSection
            title="입금 대기"
            kind="deposit"
            section={pending.deposit}
            onOpenCampaign={onOpenCampaign}
          />
          <PendingSection
            title="지급 대기"
            kind="payout"
            section={pending.payout}
            onOpenCampaign={onOpenCampaign}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PendingSection({
  title,
  kind,
  section,
  onOpenCampaign,
}: {
  title: string;
  kind: "deposit" | "payout";
  section: SettlementPendingSection;
  onOpenCampaign: (campaign: MobileSettlementCampaign) => void;
}) {
  // 방향 아이콘: 입금 ↓ / 지급 ↑ — 색은 규칙 SSOT(lib/money-direction).
  // 구 리터럴 emerald-500 은 흰 배경 2.54:1 로 **비텍스트 3:1 도 미달**이었다(짝인 rose-500
  // 3.67 과 시각 무게도 안 맞았다) — 목업이 약속한 색 아이콘이 착지했는데도 밋밋했던 이유다.
  const Icon = MONEY_DIRECTION_ICON[kind === "deposit" ? "in" : "out"];
  const iconTone = MONEY_DIRECTION_TEXT[kind === "deposit" ? "in" : "out"];

  return (
    <MobileSheetCard
      title={title}
      chip={`${section.count}건 · ₩${formatCurrency(section.total)}`}
      ariaLabel={title}
    >
      {section.rows.length === 0 ? (
        <p className="border-t border-slate-100 px-6 py-3 text-[11px] text-muted-foreground">
          대기 없음
        </p>
      ) : (
        section.rows.map((row) => (
          <MobileSheetRow
            // 한 묶음이 같은 섹션에 두 행(공급사·셀러 지급)을 낼 수 있으므로 칸까지 key 에 넣는다.
            key={`${row.campaign.id}:${row.flagField}`}
            icon={<Icon aria-hidden="true" className={`size-4 shrink-0 ${iconTone}`} />}
            label={`${row.title} · ${row.counterpartLabel}`}
            value={formatDueLabel(row.dueYmd)}
            overdue={row.overdue}
            onClick={() => onOpenCampaign(row.campaign)}
            // ⛔ 예정일 경과를 색·배지·서브텍스트로 표기하지 않는다(오너 지시 2026-08-26,
            // "전부 다 제거"). 종전에는 금액 앞에 「지연」 배지가 붙었다 — 되살리지 말 것.
            // ⚠️ 위 `overdue={row.overdue}` 와 67줄의 **연체 우선 정렬은 유지한다**: 오너가
            // 금지한 것은 표기이지 순서가 아니고, 이 화면은 대기 건을 처리하러 오는 곳이라
            // 순서까지 잃으면 목적 자체가 무너진다.
            trailing={<MobileSheetAmount amount={row.amountDisplay} />}
          />
        ))
      )}
    </MobileSheetCard>
  );
}
