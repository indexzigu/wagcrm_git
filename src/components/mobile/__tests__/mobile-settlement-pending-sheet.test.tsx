import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildSettlementPending,
  MobileSettlementPendingSheet,
} from "../mobile-settlement-pending-sheet";
import type { MobileSettlementCampaign } from "@/lib/mobile-settlement-data";

const TODAY = "2026-07-08";

// #149 리뷰 후속: 시트는 전용 경량 스냅샷(MobileSettlementCampaign)을 소비한다 —
// 과거 CampaignRow 캐스트 목 대신 실제 계약 타입으로 전 필드를 정직하게 채운다.
function makeCampaign(
  overrides: Partial<MobileSettlementCampaign> = {},
): MobileSettlementCampaign {
  return {
    id: `camp-${Math.random().toString(36).slice(2, 8)}`,
    groupId: null,
    dealName: "비타민C 앰플",
    sellerName: "하늘맘",
    roundNumber: null,
    status: "SETTLEMENT_WAIT",
    // 셀러몰 = [입금(셀러), 지급(공급사)] — 종전 픽스처의 암묵 채널이다.
    salesChannel: "SELLER_MALL",
    startDate: "2026-06-01",
    endDate: "2026-06-15",
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    settlementSales: null,
    actualSales: null,
    actualPayoutAmount: null,
    sellerExpense: null,
    settlementGoodsCost: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    ...overrides,
  };
}

describe("buildSettlementPending — 대기 목록 계산 (§6 조회 전용)", () => {
  it("정산 단계(SETTLEMENT_WAIT/IN_PROGRESS) 캠페인만 집계한다", () => {
    const pending = buildSettlementPending(
      [
        // 픽스처 채널은 셀러몰이라 **입금 근거는 `actualSales − sellerExpense`** 다
        // (세금계산서 의무표). ⛔ `settlementSales`(브랜드몰 입금 근거)로 되돌리지 말 것 —
        // 그게 종전 손수 사본이 이 채널에서 다른 거래의 숫자를 띄우던 지점이다(T-057).
        makeCampaign({ status: "ACTIVE", actualSales: 999, sellerExpense: 0 }),
        makeCampaign({ status: "SETTLEMENT_WAIT", actualSales: 150, sellerExpense: 50 }),
        makeCampaign({ status: "SETTLEMENT_IN_PROGRESS", actualSales: 250, sellerExpense: 50 }),
        makeCampaign({ status: "COMPLETED", actualSales: 999, sellerExpense: 0 }),
      ],
      TODAY,
    );
    expect(pending.deposit.count).toBe(2);
    expect(pending.deposit.total).toBe(300);
  });

  it("금액은 슬롯 SSOT 를 따른다 — 셀러몰 입금 = 매출 − 수수료 · 공급사 지급 = 물품대금", () => {
    // ⛔ 종전 계약 「입금=settlementSales, 지급=sellerExpense」는 **SUPERSEDED**(T-057).
    //    그건 이 시트가 손으로 재구현한 사본의 규칙이었고 슬롯 SSOT 와 갈라져 있었다 —
    //    셀러몰 입금에 브랜드몰 근거를 써서 **다른 거래의 숫자**가 대기 금액에 떴다.
    const pending = buildSettlementPending(
      [
        makeCampaign({
          actualSales: 7_970_000,
          sellerExpense: 3_150_000,
          settlementGoodsCost: 3_150_000,
        }),
      ],
      TODAY,
    );
    expect(pending.deposit.total).toBe(4_820_000);
    expect(pending.payout.total).toBe(3_150_000);
  });

  it("공급사 지급은 물품대금 미입력이면 대기 금액에 잡히지 않는다(모름 ≠ 0원)", () => {
    const pending = buildSettlementPending(
      [makeCampaign({ actualSales: 7_970_000, sellerExpense: 3_150_000 })],
      TODAY,
    );
    expect(pending.payout.count).toBe(1); // 칸은 남는다 — 지급 자체가 사라지면 안 된다
    expect(pending.payout.rows[0].amount).toBeNull();
  });

  it("입금 완료 건은 입금 섹션에서 빠지고 지급 대기에는 남는다", () => {
    const pending = buildSettlementPending(
      // 셀러몰의 지급 상대는 **공급사**라 금액 근거는 물품대금이다(수수료가 아니다).
      [makeCampaign({ isDepositReceived: true, settlementGoodsCost: 500 })],
      TODAY,
    );
    expect(pending.deposit.count).toBe(0);
    expect(pending.payout.count).toBe(1);
    expect(pending.payout.total).toBe(500);
  });

  it("연체(예정일<오늘 && 미완료)는 섹션 상단으로 분리 정렬된다", () => {
    const pending = buildSettlementPending(
      [
        makeCampaign({ id: "future", expectedDepositDate: "2026-07-20", actualSales: 1, sellerExpense: 0 }),
        makeCampaign({ id: "overdue", expectedDepositDate: "2026-07-01", actualSales: 1, sellerExpense: 0 }),
        makeCampaign({ id: "no-date", expectedDepositDate: null, actualSales: 1, sellerExpense: 0 }),
      ],
      TODAY,
    );
    expect(pending.deposit.rows.map((row) => row.campaign.id)).toEqual([
      "overdue",
      "future",
      "no-date",
    ]);
    expect(pending.deposit.rows[0].overdue).toBe(true);
    expect(pending.deposit.rows[1].overdue).toBe(false);
  });

  it("예정일이 과거라도 완료된 건은 아예 목록에 없다(연체 아님)", () => {
    const pending = buildSettlementPending(
      [
        makeCampaign({
          isDepositReceived: true,
          isPayoutCompleted: true,
          expectedDepositDate: "2026-07-01",
          expectedPayoutDate: "2026-07-01",
        }),
      ],
      TODAY,
    );
    expect(pending.deposit.count).toBe(0);
    expect(pending.payout.count).toBe(0);
  });
});

describe("MobileSettlementPendingSheet 렌더", () => {
  it("카드 헤더 칩에 건수와 합계를 표시한다", () => {
    render(
      <MobileSettlementPendingSheet
        open
        onOpenChange={() => {}}
        campaigns={[
          makeCampaign({
            actualSales: 7_970_000,
            sellerExpense: 3_150_000,
            settlementGoodsCost: 3_150_000,
          }),
        ]}
        todayYmd={TODAY}
        onOpenCampaign={() => {}}
      />,
    );
    // 합계는 제목 문장이 아니라 카드 헤더 우측 칩이 소유한다(UI 통일 목업 §2).
    // 카드(section)로 스코프해야 입금/지급 칩을 서로 구분할 수 있다.
    const depositCard = screen.getByRole("region", { name: "입금 대기" });
    const payoutCard = screen.getByRole("region", { name: "지급 대기" });
    expect(within(depositCard).getByText("1건 · ₩4,820,000")).toBeInTheDocument();
    expect(within(payoutCard).getByText("1건 · ₩3,150,000")).toBeInTheDocument();
  });

  /**
   * ⛔ **예정일 경과는 어떤 시각 표기도 갖지 않는다** — 오너 지시 2026-08-26
   * (*"예정일이 지난건 색을 다르게 표시하거나 배지나 서브텍스트로 표기하지마"*,
   * 범위 재확인 답 *"전부 다 제거"*). 종전 이 테스트는 정확히 반대(「지연」 배지가
   * **있다**)를 고정하고 있었다 — 삭제가 아니라 **역단언**으로 뒤집어, 다음 세션이
   * "예정일 지났는데 신호가 없네" 하고 조용히 되살리는 것을 계약으로 막는다.
   *
   * `data-overdue` 와 연체 우선 정렬은 **남는다**: 전자는 CSS 소비처가 0곳이라 아무것도
   * 그리지 않고, 후자는 순서이지 표기가 아니다(오너가 금지한 것은 표기다).
   */
  it("연체 행은 data-overdue·정렬만 갖고 지연 표기는 하지 않는다", () => {
    render(
      <MobileSettlementPendingSheet
        open
        onOpenChange={() => {}}
        campaigns={[
          makeCampaign({ expectedDepositDate: "2026-07-01", settlementSales: 100 }),
        ]}
        todayYmd={TODAY}
        onOpenCampaign={() => {}}
      />,
    );
    const overdueRows = document.querySelectorAll('[data-overdue="true"]');
    expect(overdueRows.length).toBe(1);
    // ⛔ 「지연」 배지를 되살리지 말 것(오너 지시).
    expect(screen.queryByText("지연")).not.toBeInTheDocument();
    // 날짜는 예정일 그대로 — 경과했다고 문구를 바꾸지도 않는다(서브텍스트 표기 금지).
    expect(screen.getByText("7월 1일 (수) 예정")).toBeInTheDocument();
  });

  it("행 탭 시 캠페인 상세 열기 콜백을 호출한다 (버튼·토글 없음)", async () => {
    const user = userEvent.setup();
    const onOpenCampaign = vi.fn();
    const campaign = makeCampaign({ settlementSales: 100 });
    render(
      <MobileSettlementPendingSheet
        open
        onOpenChange={() => {}}
        campaigns={[campaign]}
        todayYmd={TODAY}
        onOpenCampaign={onOpenCampaign}
      />,
    );
    // 행은 상세를 여는 진짜 버튼이어야 한다(표시 전용 div 가 아님)
    await user.click(screen.getAllByRole("button", { name: /비타민C 앰플 · 하늘맘/ })[0]);
    expect(onOpenCampaign).toHaveBeenCalledWith(campaign);
    // v3.1 조회 전용 — 처리용 토글·스위치 금지
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  // §1 공통 시트 헤더 — 탭 상단바(MobileTopBar)와 같은 위계. 예비 일정 시트도 같은
  // 셸(MobileSheetHeader)을 쓰므로 여기서 깨지면 두 시트가 함께 깨진 것이다.
  it("헤더는 캡션 + 제목 + 닫기 버튼을 탭 상단바 위계로 렌더한다", () => {
    render(
      <MobileSettlementPendingSheet
        open
        onOpenChange={() => {}}
        campaigns={[]}
        todayYmd={TODAY}
        onOpenCampaign={() => {}}
      />,
    );
    // 캡션 슬롯은 제거됐다(오너 지시 2026-08-26) — 재유입 방지용 역단언.
    expect(screen.queryByText("WAG CRM")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "정산 대기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "대기 목록 닫기" })).toBeInTheDocument();
  });

  it("대기 0건 섹션은 '대기 없음'을 표시한다", () => {
    render(
      <MobileSettlementPendingSheet
        open
        onOpenChange={() => {}}
        campaigns={[]}
        todayYmd={TODAY}
        onOpenCampaign={() => {}}
      />,
    );
    expect(screen.getAllByText("대기 없음").length).toBe(2);
  });
});

/**
 * 자사몰(2026-08-25 2단계) — 슬롯이 [공급사 지급, 셀러 지급]이고 입금 칸이 없다.
 * 종전 `!isDepositReceived` / `!isPayoutCompleted` 두 축 코드에서는 ①공급사 지급이
 * 대기 목록에 아예 없었고 ②자사몰 전건이 「입금 대기」에 유령 행으로 상주했다.
 */
describe("buildSettlementPending — 자사몰 슬롯", () => {
  const ownMall = (overrides: Partial<MobileSettlementCampaign> = {}) =>
    makeCampaign({
      salesChannel: "OWN_MALL_NAVER",
      // 레거시 입금 예정일 — 칸이 없으므로 대기 행이 되면 안 된다.
      expectedDepositDate: "2026-07-01",
      expectedSupplierPayoutDate: "2026-07-05",
      expectedPayoutDate: "2026-07-20",
      settlementSales: 5_000_000,
      sellerExpense: 3_000_000,
      ...overrides,
    });

  it("입금 대기는 비고 지급 대기에 두 줄(공급사·셀러)이 선다", () => {
    const pending = buildSettlementPending([ownMall()], TODAY);
    expect(pending.deposit.count).toBe(0);
    expect(pending.payout.rows.map((row) => row.counterpartLabel)).toEqual(["공급사", "셀러"]);
  });

  it("공급사 지급 행의 금액은 0 이 아니라 null(모름)이라 합계에 섞이지 않는다", () => {
    const pending = buildSettlementPending([ownMall()], TODAY);
    const supplier = pending.payout.rows.find((row) => row.counterpartLabel === "공급사")!;
    expect(supplier.amount).toBeNull();
    expect(supplier.overdue).toBe(true); // 2026-07-05 < TODAY(2026-07-08)
    expect(pending.payout.total).toBe(3_000_000); // 셀러 지급분만
  });

  it("공급사 지급이 완료되면 그 행만 사라진다", () => {
    const pending = buildSettlementPending(
      [ownMall({ isSupplierPayoutCompleted: true })],
      TODAY,
    );
    expect(pending.payout.rows.map((row) => row.counterpartLabel)).toEqual(["셀러"]);
  });
});

/**
 * 조합 캠페인 접기 (T-062, 오너 확정 2026-08-27).
 *
 * 묶음은 실캠페인 1개이고 대금도 한 번에 오간다. 종전 이 목록만 접지 않아
 * 멤버 4건짜리 묶음 하나가 4줄을 차지하고 홈 자금 칩의 「입금 대기 N건」도 4로 셌다
 * (데스크톱 아젠다는 같은 판정을 이미 묶음당 1행으로 접고 있었다 — 실측 2026-08-27).
 *
 * **판정은 둘로 나뉜다** — 어느 묶음이 한 단위인가·줄 이름은 `settlement-stage`,
 * 그 단위의 칸·예정일·완료·금액은 `calendar-entities` 의 폴딩 SSOT(T-057)다.
 * 픽스처 채널은 셀러몰이라 입금 근거는 `실매출 − 셀러수수료`, 공급사 지급 근거는
 * **수기 물품대금**이다. ⛔ `settlementSales`(브랜드몰 입금 근거)로 되돌리지 말 것.
 */
describe("buildSettlementPending — 조합 캠페인 접기", () => {
  const member = (overrides: Partial<MobileSettlementCampaign> = {}) =>
    makeCampaign({
      groupId: "grp-1",
      groupName: "여름 공구 묶음",
      expectedDepositDate: "2026-07-20",
      actualSales: 1_400_000,
      sellerExpense: 400_000, // 입금 = 1,400,000 − 400,000 = 1,000,000
      settlementGoodsCost: 400_000, // 공급사 지급 근거
      ...overrides,
    });

  it("멤버 4건짜리 묶음은 칸당 한 줄이고 건수도 1로 센다", () => {
    const pending = buildSettlementPending(
      [
        member({ id: "m1", dealName: "딜A" }),
        member({ id: "m2", dealName: "딜B" }),
        member({ id: "m3", dealName: "딜C" }),
        member({ id: "m4", dealName: "딜D" }),
      ],
      TODAY,
    );
    expect(pending.deposit.count).toBe(1);
    expect(pending.payout.count).toBe(1);
  });

  it("금액은 멤버 합산이라 접기 전후로 총액이 같다", () => {
    const pending = buildSettlementPending(
      [
        member({ id: "m1", actualSales: 1_400_000, sellerExpense: 400_000 }),
        member({ id: "m2", actualSales: 3_100_000, sellerExpense: 600_000 }),
      ],
      TODAY,
    );
    expect(pending.deposit.total).toBe(3_500_000); // 1,000,000 + 2,500,000
    expect(pending.payout.total).toBe(800_000); // 물품대금 400,000 × 2
  });

  it("줄 이름은 저장된 묶음 이름이고, 없으면 대표 + 「외 N건」이다", () => {
    const named = buildSettlementPending([member({ id: "m1" }), member({ id: "m2" })], TODAY);
    expect(named.deposit.rows[0].title).toBe("여름 공구 묶음");

    const unnamed = buildSettlementPending(
      [
        member({ id: "m1", groupName: null, dealName: "딜A" }),
        member({ id: "m2", groupName: null, dealName: "딜B" }),
      ],
      TODAY,
    );
    expect(unnamed.deposit.rows[0].title).toBe("딜A · 하늘맘 외 1건");
  });

  it("줄을 누르면 대표 멤버의 상세가 열린다 — 멤버 전원은 members 로 남긴다", () => {
    const pending = buildSettlementPending(
      [member({ id: "m1" }), member({ id: "m2" }), member({ id: "m3" })],
      TODAY,
    );
    expect(pending.deposit.rows[0].campaign.id).toBe("m1");
    expect(pending.deposit.rows[0].members.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  /**
   * **일부만 미정일 때 어떻게 접는가는 기준마다 다르다**(`MoneySlotGroupFold`, T-057).
   * ⛔ 소비처가 한 규칙으로 통일하지 말 것 — 아래 두 단언이 서로 반대인 것이 계약이다.
   */
  it("멤버마다 독립인 기준(입금)은 아는 멤버만 더한다", () => {
    const pending = buildSettlementPending(
      [
        member({ id: "m1", actualSales: 1_400_000, sellerExpense: 400_000 }),
        member({ id: "m2", actualSales: null, sellerExpense: null }),
      ],
      TODAY,
    );
    expect(pending.deposit.rows[0].amount).toBe(1_000_000);
    expect(pending.deposit.total).toBe(1_000_000);
  });

  it("물품대금은 한 멤버라도 모르면 묶음 전체가 모름이다 — 그룹이 계산서 한 장이라", () => {
    const pending = buildSettlementPending(
      [
        member({ id: "m1", settlementGoodsCost: 400_000 }),
        member({ id: "m2", settlementGoodsCost: null }),
      ],
      TODAY,
    );
    // ⛔ 400,000 으로 되돌리지 말 것 — 입력된 멤버만 더하면 「일부만 반영된 합계」가
    //    실물 총액인 것처럼 보이고, 그 오답은 곧 금액 불일치이거나 오확정이 된다.
    expect(pending.payout.rows[0].amount).toBeNull();
    expect(pending.payout.total).toBe(0);
  });

  it("멤버 금액이 전부 미정이면 묶음도 미정(null)이다 — 0원으로 접지 않는다", () => {
    const pending = buildSettlementPending(
      [
        member({ id: "m1", actualSales: null, sellerExpense: null }),
        member({ id: "m2", actualSales: null, sellerExpense: null }),
      ],
      TODAY,
    );
    expect(pending.deposit.rows[0].amount).toBeNull();
  });

  it("미그룹 캠페인은 종전과 동일하게 자기 한 줄이다", () => {
    const pending = buildSettlementPending(
      [
        makeCampaign({
          id: "solo",
          expectedDepositDate: "2026-07-20",
          actualSales: 100,
          sellerExpense: 0,
        }),
        member({ id: "m1" }),
        member({ id: "m2" }),
      ],
      TODAY,
    );
    expect(pending.deposit.count).toBe(2); // 미그룹 1 + 묶음 1
  });

  it("서로 다른 묶음은 각각 한 줄이다", () => {
    const pending = buildSettlementPending(
      [
        member({ id: "a1", groupId: "grp-1" }),
        member({ id: "b1", groupId: "grp-2", groupName: "겨울 공구 묶음" }),
        member({ id: "a2", groupId: "grp-1" }),
      ],
      TODAY,
    );
    expect(pending.deposit.rows.map((r) => r.title)).toEqual([
      "여름 공구 묶음",
      "겨울 공구 묶음",
    ]);
  });
});
