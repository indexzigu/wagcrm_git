import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import {
  campaignRowToDetailData,
  getSlotDisplayLabel,
  MobileCampaignDetailSheet,
  type MobileCampaignDetailData,
} from "../mobile-campaign-detail-sheet";
import type { CampaignRow } from "@/lib/crm-types";
import { resolveCampaignMoneySlots } from "@/lib/tax-filing-board";
import type { MobileCampaignSalesResponse } from "@/lib/mobile-campaign-sales";
import { MONEY_DIRECTION_TEXT, MONEY_ROW_SETTLED_MUTED } from "@/lib/money-direction";

const TODAY = "2026-07-08";

function makeDetail(
  overrides: Partial<MobileCampaignDetailData> = {},
): MobileCampaignDetailData {
  return {
    id: "camp-1",
    dealName: "비타민C 앰플",
    sellerName: "하늘맘",
    roundNumber: 2,
    status: "ACTIVE",
    // 셀러몰(입금+지급) — 종전 픽스처의 암묵 채널. 이 세 필드는 **필수**다(선택으로
    // 되돌리면 생산자/소비자를 나눠 가진 PR 사이에서 연결 누락이 다시 조용해진다).
    salesChannel: "SELLER_MALL",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-15T00:00:00.000Z",
    expectedDepositDate: "2026-07-20T00:00:00.000Z",
    expectedPayoutDate: "2026-07-25T00:00:00.000Z",
    expectedSupplierPayoutDate: null,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    settlementSales: 4_820_000,
    actualSales: null,
    sellerExpense: null,
    actualPayoutAmount: 3_150_000,
    settlementGoodsCost: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    ...overrides,
  };
}

function makeSales(
  overrides: Partial<MobileCampaignSalesResponse> = {},
): MobileCampaignSalesResponse {
  return {
    campaignId: "camp-1",
    source: "live",
    asOf: "2026-07-08T05:00:00.000Z",
    cumulative: { orders: 340, quantity: 400, revenue: 38_200_000 },
    today: { orders: 12, quantity: 14, revenue: 1_240_000 },
    statusBreakdown: {
      newOrderBefore: 5,
      newOrderAfter: 3,
      pending: 2,
      shipping: 10,
      completed: 320,
    },
    claims: { canceled: 1, returned: 0, exchanged: 0 },
    daily: [
      { date: "2026-07-07", orders: 100, revenue: 10_000_000 },
      { date: "2026-07-08", orders: 12, revenue: 1_240_000 },
    ],
    items: [
      { name: "비타민C 앰플 · 30ml", orders: 220, quantity: 260, revenue: 26_000_000 },
      { name: "비타민C 앰플 · 50ml", orders: 120, quantity: 140, revenue: 12_200_000 },
    ],
    ...overrides,
  };
}

function stubSalesFetch(payload: MobileCampaignSalesResponse) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  stubSalesFetch(makeSales());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const noop = () => {};

describe("정산 상태 라벨 규칙 (§5-④, 조회 전용)", () => {
  // 판정 입력은 채널 슬롯이다 — 셀러몰 = [입금(셀러), 지급(공급사)],
  // 자사몰 = [지급(공급사), 지급(셀러)].
  const sellerMallSlots = resolveCampaignMoneySlots("SELLER_MALL");
  const depositSlot = sellerMallSlots.find((slot) => slot.kind === "DEPOSIT")!;
  const payoutSlot = sellerMallSlots.find((slot) => slot.kind === "PAYOUT")!;
  const ownMallSlots = resolveCampaignMoneySlots("OWN_MALL_NAVER");

  it("입금 미완료 + 예정일 미래 → 예정 / 지연 아님", () => {
    const label = getSlotDisplayLabel(
      depositSlot,
      { isDepositReceived: false, expectedDepositDate: "2026-07-20" },
      TODAY,
    );
    expect(label).toEqual({ label: "예정", overdue: false });
  });

  it("입금 완료(confirmed) → 확정, 예정일이 과거여도 지연 아님", () => {
    const label = getSlotDisplayLabel(
      depositSlot,
      { isDepositReceived: true, expectedDepositDate: "2026-07-01" },
      TODAY,
    );
    expect(label).toEqual({ label: "확정", overdue: false });
  });

  it("입금 미완료 + 예정일 과거 → 예정 + 지연", () => {
    const label = getSlotDisplayLabel(
      depositSlot,
      { isDepositReceived: false, expectedDepositDate: "2026-07-01" },
      TODAY,
    );
    expect(label).toEqual({ label: "예정", overdue: true });
  });

  it("입금 예정일 없음 → 지연 판정 불가(false)", () => {
    const label = getSlotDisplayLabel(
      depositSlot,
      { isDepositReceived: false, expectedDepositDate: null },
      TODAY,
    );
    expect(label).toEqual({ label: "예정", overdue: false });
  });

  it("지급 완료(paid) → 지급완료", () => {
    const label = getSlotDisplayLabel(
      payoutSlot,
      { isPayoutCompleted: true, expectedPayoutDate: "2026-07-01" },
      TODAY,
    );
    expect(label).toEqual({ label: "지급완료", overdue: false });
  });

  it("지급 미완료 + 예정일 과거 → 예정 + 지연", () => {
    const label = getSlotDisplayLabel(
      payoutSlot,
      { isPayoutCompleted: false, expectedPayoutDate: "2026-07-07" },
      TODAY,
    );
    expect(label).toEqual({ label: "예정", overdue: true });
  });

  // 자사몰 회귀 — 공급사 지급 레그가 전용 필드를 읽는지. 종전 `getPayoutDisplayLabel`
  // 은 `expectedPayoutDate`(셀러 축)만 봐서 이 레그를 표현할 방법이 아예 없었다.
  it("자사몰 공급사 지급 레그는 supplierPayout 필드를 읽는다", () => {
    const supplierSlot = ownMallSlots.find((slot) => slot.counterpartLabel === "공급사")!;
    expect(supplierSlot.expectedField).toBe("expectedSupplierPayoutDate");
    expect(
      getSlotDisplayLabel(
        supplierSlot,
        { isSupplierPayoutCompleted: false, expectedSupplierPayoutDate: "2026-07-01" },
        TODAY,
      ),
    ).toEqual({ label: "예정", overdue: true });
    expect(
      getSlotDisplayLabel(supplierSlot, { isSupplierPayoutCompleted: true }, TODAY),
    ).toEqual({ label: "지급완료", overdue: false });
  });

  it("CampaignRow 형제 목록에서 그룹 상세 데이터를 만든다", () => {
    const rows = [
      {
        id: "camp-1",
        groupId: "group-1",
        dealName: "마린콜라겐 A",
        sellerName: "하늘맘",
        startDate: "2026-07-01",
        endDate: "2026-07-10",
        status: "ACTIVE",
        settlementSales: 100,
        actualPayoutAmount: 70,
      },
      {
        id: "camp-2",
        groupId: "group-1",
        dealName: "마린콜라겐 B",
        sellerName: "하늘맘",
        startDate: "2026-07-03",
        endDate: "2026-07-12",
        status: "ACTIVE",
        settlementSales: 200,
        actualPayoutAmount: 130,
      },
    ] as unknown as CampaignRow[];

    expect(campaignRowToDetailData(rows[0])).toMatchObject({
      id: "camp-1",
      dealName: "마린콜라겐 A",
      sellerName: "하늘맘",
      status: "ACTIVE",
      startDate: "2026-07-01",
      endDate: "2026-07-10",
      settlementSales: 100,
      actualPayoutAmount: 70,
    });
  });
});

/*
 * 🪦 `describe("마감 D-day 라벨")` 의 단위 테스트 3건(`마감 D-7`·`마감 D-day`·`마감 지남`)은
 * `formatDeadlineLabel` 과 함께 제거됐다(오너 지시 2026-08-26 — 판매 마감엔 D-day 를 쓰지
 * 않는다). 부재를 고정하는 계약은 아래 **렌더 역단언**이 승계한다 — 단위 테스트는 함수가
 * 없으면 존재할 수 없지만 렌더 단언은 부활을 실제로 잡는다.
 */

describe("MobileCampaignDetailSheet 렌더", () => {
  it("헤더에 딜이름·셀러명·차수 배지를 하이픈 없이 렌더한다", async () => {
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );
    expect(screen.getByText("비타민C 앰플")).toBeInTheDocument();
    expect(screen.getByText("하늘맘")).toBeInTheDocument();
    expect(screen.getByText("2차")).toBeInTheDocument();
    // 딜이름과 셀러명 사이 하이픈 금지(P2) — 아이콘이 구분자
    expect(screen.queryByText(/비타민C 앰플\s*-\s*하늘맘/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/오늘/)).toBeInTheDocument());
  });

  it("매출상세현황: 오늘·누적·주문상태 분포·취소반품을 렌더한다", async () => {
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );
    // 오늘 판매 블록 — 누적 매출과 동일한 라벨+금액 위계(오너 피드백 2026-07-14)
    await waitFor(() => {
      expect(screen.getByText("오늘 판매")).toBeInTheDocument();
      expect(screen.getByText("₩1,240,000")).toBeInTheDocument();
    });
    // 누적 매출 헤드라인
    expect(screen.getByText("누적 매출")).toBeInTheDocument();
    expect(screen.getByText("₩38,200,000")).toBeInTheDocument();
    // 주문상태 분포 라벨(중복 없이 각 1회)
    expect(screen.getByText("주문확인 전")).toBeInTheDocument();
    expect(screen.getByText("배송완료")).toBeInTheDocument();
    // 취소·반품 라인 (텍스트 노드가 분리되어 있으므로 주요 키워드로 확인)
    expect(screen.getByText(/취소/)).toBeInTheDocument();
    expect(screen.getByText(/반품/)).toBeInTheDocument();
  });

  it("source=none 이면 '판매 데이터 없음 (네이버 미연동)'을 표시한다", async () => {
    stubSalesFetch(
      makeSales({
        source: "none",
        asOf: null,
        cumulative: { orders: 0, quantity: 0, revenue: 0 },
        today: { orders: 0, quantity: 0, revenue: 0 },
        statusBreakdown: { newOrderBefore: 0, newOrderAfter: 0, pending: 0, shipping: 0, completed: 0 },
        claims: null,
        daily: [],
      }),
    );
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/판매 데이터가 연동되지 않았습니다/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/오늘 0건/)).not.toBeInTheDocument();
  });

  it("cached(마감) 모드는 오늘·취소반품 줄을 렌더하지 않는다(claims null)", async () => {
    stubSalesFetch(makeSales({ source: "cached", asOf: null, claims: null }));
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );
    await waitFor(() => expect(screen.getByText("₩38,200,000")).toBeInTheDocument());
    // 마감 캠페인: 오늘 줄·취소반품 줄 없음
    expect(screen.queryByText(/^오늘 판매/)).not.toBeInTheDocument();
    expect(screen.queryByText(/취소 \d+ · 반품/)).not.toBeInTheDocument();
    expect(screen.getByText("최종 집계")).toBeInTheDocument();
  });

  // §4 UI 통일: 구 ③일정 + ④정산 상태 두 밴드를 "일정 · 정산" 카드 1장으로 통합.
  // 시작·마감 두 행은 판매 기간 한 행으로 압축되고, 상태 배지는 행 우측으로 흡수된다.
  it("일정·정산 카드 하나에 판매 기간과 입금·지급 상태를 함께 렌더한다", async () => {
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );

    const card = screen.getByRole("region", { name: "일정 · 정산" });
    // 시작·마감이 아니라 한 행으로 이어진 판매 기간 (+ D-day — 아래 테스트의 계약)
    expect(within(card).getByText(/7월 1일 \(수\) → 7월 15일 \(수\)/)).toBeInTheDocument();
    // 상태 배지가 행 안으로 흡수됐으므로 별도 "정산 상태" 섹션은 없다
    expect(screen.queryByRole("region", { name: "정산 상태" })).not.toBeInTheDocument();
  });

  // 오너 확정 2026-07-16(구 2026-07-15 결정을 대체): 헤더가 sticky 를 잃고 흐름이 되면서
  // "헤더가 항상 보이니 카드엔 불필요"라는 전제가 무너졌다 — 스크롤 후에는 판매 기간 행이
  /**
   * ⛔ **판매 마감에는 D-day 를 쓰지 않는다** — 오너 지시 2026-08-26:
   * *"디데이가 필요한 곳에서는 사용을 하는데 판매 마감에 대해서는 디데이를 할 필요 없다"*.
   *
   * 종전 이 테스트는 정확히 반대를 고정했다 — 특히 `toHaveLength(2)` 로 **헤더와 카드 두
   * 곳에 나오는 것**을 계약으로 못박고 있었다. 삭제가 아니라 역단언으로 뒤집어, 다음
   * 세션이 "마감이 언제인지 한눈에 안 보이네" 하고 되살리는 것을 계약으로 막는다.
   *
   * ⚠️ 이 단언은 **판매 마감 한정**이다 — 원천세 신고 절차 카드의 D-day 는 그대로 산다.
   */
  it("판매 기간은 날짜만 렌더하고 마감 D-day 는 어디에도 없다", async () => {
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );

    const card = await screen.findByRole("region", { name: "일정 · 정산" });
    // 「판매 기간」 행은 시작 → 종료 날짜만 말한다.
    expect(within(card).getByText(/7월 1일.*→.*7월 15일/)).toBeInTheDocument();
    // 헤더·카드 어디에도 마감 D-day 표기가 없다(구 계약은 여기서 2건을 요구했다).
    expect(screen.queryAllByText(/마감 D-|마감 지남/)).toHaveLength(0);
  });

  // 세 시트 공통: 시각 32px 원 + 44px 터치 타깃(오너 확정 2026-07-15)
  it("닫기 버튼은 44px 터치 타깃을 갖는다", async () => {
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );

    const close = screen.getByRole("button", { name: "상세 닫기" });
    expect(close).toHaveClass("size-11");
  });

  /**
   * ⛔ **예정일이 지나도 「지연」을 표기하지 않는다** — 오너 지시 2026-08-26
   * (*"예정일이 지난건 색을 다르게 표시하거나 배지나 서브텍스트로 표기하지마"*,
   * 범위 재확인 답 *"전부 다 제거"*). 종전 이 테스트는 반대를 고정하고 있었다.
   * 이 시트에서 「지연」 배지는 부가가 아니라 **예정 배지를 대체**했으므로, 제거 후에는
   * 그 자리가 비는 게 아니라 「예정」으로 돌아간다 — 아래가 그것까지 함께 고정한다.
   */
  it("예정일이 지나도 지연 표기 없이 '예정' 배지를 유지한다", async () => {
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail({
          expectedDepositDate: "2026-07-01T00:00:00.000Z",
          isDepositReceived: false,
        })}
        todayYmd={TODAY}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("예정").length).toBeGreaterThan(0));
    expect(screen.queryByText("지연")).not.toBeInTheDocument();
    // 경과분도 중립 배지 그대로 — 색으로도 가르지 않는다.
    expect(screen.getAllByText("예정")[0]).toHaveAttribute("data-variant", "secondary");
  });

  it("그룹 캠페인은 그룹 매출 API를 읽고 구성 캠페인을 함께 표시한다", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const fetchMock = stubSalesFetch(makeSales({ 
      campaignId: "group:group-1",
      items: [
        { name: "마린콜라겐 A", orders: 10, quantity: 10, revenue: 1000 },
        { name: "마린콜라겐 B", orders: 20, quantity: 20, revenue: 2000 }
      ]
    }));

    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail({
          id: "group:group-1",
          dealName: "마린콜라겐 그룹",
          roundNumber: null,
          status: "ACTIVE",
          startDate: "2026-07-01T00:00:00.000Z",
          endDate: "2026-07-15T00:00:00.000Z",
        })}
        todayYmd={TODAY}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/mobile/campaigns/group:group-1/sales",
      { cache: "no-store" },
    ));
    expect(screen.getByText("마린콜라겐 그룹")).toBeInTheDocument();

    // "품목별 매출 상세" 토글은 그룹 매출 fetch가 resolve된 뒤 리렌더로 나타난다.
    // 위 waitFor는 fetch '호출'만 기다리므로, 여기서 동기 getByText는 리렌더 전 실행돼
    // 부하 시 간헐 실패(플레이키)한다 → findByText로 등장까지 대기.
    const toggle = await screen.findByText(/품목별 매출 상세/);
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);

    // 공통 접두어("마린콜라겐")는 상단 맥락줄로 접히고, 각 행은 구분 꼬리만 노출(#62 복원).
    // 전체 표시명은 행 title 로 보존된다.
    await waitFor(() => {
      expect(screen.getByText("마린콜라겐")).toBeInTheDocument();
      expect(screen.getByTitle("마린콜라겐 A")).toHaveTextContent("A");
      expect(screen.getByTitle("마린콜라겐 B")).toHaveTextContent("B");
    });
  });

  it("품목별 매출은 기본 매출 내림차순, 헤더 탭으로 정렬 기준을 바꾼다(#130 복원)", async () => {
    stubSalesFetch(
      makeSales({
        items: [
          { name: "비타민C 앰플 · 30ml", orders: 220, quantity: 260, revenue: 26_000_000 },
          { name: "비타민C 앰플 · 50ml", orders: 120, quantity: 300, revenue: 12_200_000 },
        ],
      }),
    );
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );

    await waitFor(() => expect(screen.getByText(/품목별 매출 상세/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/품목별 매출 상세/));

    // 기본: 매출 내림차순 → 30ml(2,600만)이 첫 행
    const rowsBefore = screen.getAllByRole("row").slice(1); // [0]=헤더
    expect(rowsBefore[0]).toHaveTextContent("30ml");

    // 수량 기준 정렬로 전환 → 수량 내림차순이라 50ml(300개)이 첫 행
    fireEvent.click(screen.getByRole("button", { name: "수량 기준 정렬" }));
    const rowsAfter = screen.getAllByRole("row").slice(1);
    expect(rowsAfter[0]).toHaveTextContent("50ml");
  });

  it("같은 품목명은 한 행으로 합산한다(그룹 상세 중복 방어)", async () => {
    stubSalesFetch(
      makeSales({
        items: [
          { name: "선식 세트 · 기본", orders: 10, quantity: 10, revenue: 1_000 },
          { name: "선식 세트 · 기본", orders: 5, quantity: 6, revenue: 500 },
          { name: "선식 세트 · 특대", orders: 2, quantity: 2, revenue: 200 },
        ],
      }),
    );
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );

    await waitFor(() => expect(screen.getByText(/품목별 매출 상세/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/품목별 매출 상세/));

    // 중복 2행이 1행으로 합산 → 총 2행(기본·특대), 합산 수량 16
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("₩1,500");
    expect(rows[0]).toHaveTextContent("16");
  });

  /**
   * 완료 줄이 **예정일**을 달고 있으면 「지급 완료 · 7월 25일」처럼 아무 일도 없던 날을
   * 말한다 — 같은 시트를 여는 캘린더·구글 이벤트와 날짜가 어긋난다(판정 SSOT
   * `resolveMoneySlotEffectiveDate`).
   */
  it("완료된 대금 줄은 예정일이 아니라 실제 이체일을 단다", async () => {
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail({
          expectedPayoutDate: "2026-07-25T00:00:00.000Z",
          payoutCompletedAt: "2026-07-18T00:00:00.000Z",
          isPayoutCompleted: true,
        })}
        todayYmd={TODAY}
      />,
    );
    await waitFor(() => expect(screen.getByText("지급완료")).toBeInTheDocument());
    expect(screen.getByText(/7월 18일/)).toBeInTheDocument();
    expect(screen.queryByText(/7월 25일/)).not.toBeInTheDocument();
  });

  it("입금 확정·지급완료 라벨을 렌더하고 토글/스위치는 없다", async () => {
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail({ isDepositReceived: true, isPayoutCompleted: true })}
        todayYmd={TODAY}
      />,
    );
    await waitFor(() => expect(screen.getByText("확정")).toBeInTheDocument());
    expect(screen.getByText("지급완료")).toBeInTheDocument();
    expect(screen.queryByText("지연")).not.toBeInTheDocument();
    // v3.1 조회 전용 — 정산 처리 토글·스위치·체크박스 금지
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  /**
   * 「완료된 대금 줄」은 일정탭 날짜 목록(`MobileScheduleDayList`)과 **같은 개념**이라
   * 같은 규칙 SSOT 를 탄다(오너 승인 2026-08-26, ss-ux-designer 판정). 통합 전에는 이
   * 시트가 같은 판정을 손으로 재구현해 세 항목이 갈려 있었다 — 그 사본이 이 레포의
   * 재발 버그다. 아래 세 단언이 각각 그 하나씩을 고정한다.
   */
  describe("완료된 대금 줄 — 일정탭과 같은 규칙 SSOT", () => {
    const settledDetail = () =>
      makeDetail({ isDepositReceived: true, isPayoutCompleted: true });
    const pendingDetail = () => makeDetail();

    /**
     * 배지 글자로 그 배지가 속한 **대금 행**을 집는다.
     *
     * ⛔ `document.querySelector(".tabular-nums")` 로 집지 말 것 — 이 시트에는 매출
     * 상세의 숫자 칩들도 `tabular-nums` 를 달고 있어 **다른 요소를 집는다**(초안이
     * 실제로 그렇게 실패했다). 행의 신원은 `MobileSheetRow` 의 `min-h-11` 이다.
     */
    const rowOf = (badgeText: string): HTMLElement => {
      let el: HTMLElement | null = screen.getByText(badgeText).parentElement;
      while (el && !el.className.includes("min-h-11")) el = el.parentElement;
      if (!el) throw new Error(`대금 행을 찾지 못했다: ${badgeText}`);
      return el;
    };

    const iconClassesIn = (row: HTMLElement) =>
      Array.from(row.querySelectorAll("svg"), (n) => n.getAttribute("class") ?? "");

    it("① 완료 줄은 방향 아이콘 색을 걷고 무채로 내린다 (화살표 모양은 유지)", async () => {
      const { unmount } = render(
        <MobileCampaignDetailSheet
          open
          onOpenChange={noop}
          campaign={pendingDetail()}
          todayYmd={TODAY}
        />,
      );
      await waitFor(() => expect(screen.getAllByText("예정").length).toBeGreaterThan(0));
      // 예정 줄에서는 방향색이 살아 있다 — 대칭 계약대로 입금·지급 **양쪽 다**.
      const pendingClasses = screen
        .getAllByText("예정")
        .flatMap((badge) => {
          let el: HTMLElement | null = badge.parentElement;
          while (el && !el.className.includes("min-h-11")) el = el.parentElement;
          return el ? iconClassesIn(el) : [];
        });
      expect(pendingClasses.some((c) => c.includes(MONEY_DIRECTION_TEXT.in))).toBe(true);
      expect(pendingClasses.some((c) => c.includes(MONEY_DIRECTION_TEXT.out))).toBe(true);
      unmount();

      render(
        <MobileCampaignDetailSheet
          open
          onOpenChange={noop}
          campaign={settledDetail()}
          todayYmd={TODAY}
        />,
      );
      await waitFor(() => expect(screen.getByText("확정")).toBeInTheDocument());
      const settledClasses = [...iconClassesIn(rowOf("확정")), ...iconClassesIn(rowOf("지급완료"))];
      // 완료되면 방향색이 **양쪽 다** 사라진다(한쪽만 걷으면 "지급 = 나쁜 것" 오독).
      expect(settledClasses.some((c) => c.includes(MONEY_DIRECTION_TEXT.in))).toBe(false);
      expect(settledClasses.some((c) => c.includes(MONEY_DIRECTION_TEXT.out))).toBe(false);
      expect(settledClasses.some((c) => c.includes(MONEY_ROW_SETTLED_MUTED))).toBe(true);
    });

    it("② 완료 배지는 status-success — 네이비(status-active)로 되돌리지 않는다", async () => {
      render(
        <MobileCampaignDetailSheet
          open
          onOpenChange={noop}
          campaign={settledDetail()}
          todayYmd={TODAY}
        />,
      );
      await waitFor(() => expect(screen.getByText("확정")).toBeInTheDocument());
      // 생애주기축 어휘(StatusBadge 의 COMPLETED · 캘린더 도트 · #483 정산 칸과 동일).
      expect(screen.getByText("확정")).toHaveAttribute("data-variant", "status-success");
      expect(screen.getByText("지급완료")).toHaveAttribute("data-variant", "status-success");
      // P8 §4: 브랜드 네이비 틴트를 **판정 의미**로 쓰는 것은 금지다.
      expect(document.querySelector('[data-variant="status-active"]')).toBeNull();
    });

    it("③ 완료 줄 금액은 색만 내리고 굵기는 그대로 둔다", async () => {
      render(
        <MobileCampaignDetailSheet
          open
          onOpenChange={noop}
          campaign={settledDetail()}
          todayYmd={TODAY}
        />,
      );
      await waitFor(() => expect(screen.getByText("확정")).toBeInTheDocument());
      const amount = rowOf("지급완료").querySelector(".tabular-nums") as HTMLElement;
      const cls = amount.getAttribute("class") ?? "";
      expect(cls).toContain(MONEY_ROW_SETTLED_MUTED);
      // ⛔ 웨이트 강등 금지 — tabular-nums 로 맞춘 금액 열의 광학 정렬이 흔들린다.
      expect(cls).toContain("font-semibold");
      expect(cls).not.toContain("font-medium");
    });
  });

  it("일별 매출 추이가 없으면 판매기간 기준 빈 상태를 표시한다", async () => {
    stubSalesFetch(makeSales({ daily: [] }));
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail()}
        todayYmd={TODAY}
      />,
    );
    await waitFor(() => expect(screen.getByText("₩38,200,000")).toBeInTheDocument());
    expect(screen.getByText("최근 판매 추이 없음")).toBeInTheDocument();
  });

  it("일별 매출은 최근 N일 판매 추이로 표시한다", async () => {
    stubSalesFetch(
      makeSales({
        daily: [
          { date: "2026-07-07", orders: 100, revenue: 10_000_000 },
          { date: "2026-07-08", orders: 12, revenue: 1_240_000 },
        ],
      }),
    );
    render(
      <MobileCampaignDetailSheet
        open
        onOpenChange={noop}
        campaign={makeDetail({
          startDate: "2026-07-01T00:00:00.000Z",
          endDate: "2026-07-15T00:00:00.000Z",
        })}
        todayYmd={TODAY}
      />,
    );

    await waitFor(() => expect(screen.getByText(/최근 2일 판매 추이/)).toBeInTheDocument());
    expect(screen.getByText("7/7")).toBeInTheDocument();
    expect(screen.getByText("7/8")).toBeInTheDocument();
    expect(screen.getByText("1000만")).toBeInTheDocument();
  });
});

describe("당겨서 새로고침 — POST /api/mobile/order-sync 연동", () => {
  type RefreshStub = { status?: number; payload: unknown };

  /** 매출 GET과 order-sync POST를 URL로 분기하는 fetch 스텁. */
  function stubDualFetch(sales: MobileCampaignSalesResponse, refresh: RefreshStub) {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/mobile/order-sync") {
        const status = refresh.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => refresh.payload,
        };
      }
      return { ok: true, status: 200, json: async () => sales };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function salesGetCount(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter(([input]) => String(input).includes("/sales")).length;
  }

  function orderSyncPostCount(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/mobile/order-sync",
    ).length;
  }

  function getSheetContainer(): HTMLElement {
    const container = document.querySelector('[data-slot="sheet-content"]');
    expect(container).not.toBeNull();
    return container as HTMLElement;
  }

  /**
   * scrollTop 0에서 임계(70px)를 넘는 당김 제스처 시뮬레이션(감쇠 0.5 → 이동 200px).
   * changedTouches도 채운다 — radix(react-remove-scroll)의 document 리스너가
   * changedTouches[0]을 읽으므로 비워두면 uncaught TypeError가 난다.
   */
  function pullDown(container: HTMLElement) {
    const start = { clientX: 0, clientY: 100 };
    const move = { clientX: 0, clientY: 300 };
    fireEvent.touchStart(container, { touches: [start], changedTouches: [start] });
    fireEvent.touchMove(container, { touches: [move], changedTouches: [move] });
    fireEvent.touchEnd(container, { touches: [], changedTouches: [move] });
  }

  async function renderAndWaitInitialSales(fetchMock: ReturnType<typeof vi.fn>) {
    render(
      <MobileCampaignDetailSheet open onOpenChange={noop} campaign={makeDetail()} todayYmd={TODAY} />,
    );
    await waitFor(() => expect(salesGetCount(fetchMock)).toBe(1));
    await waitFor(() => expect(screen.getByText("누적 매출")).toBeInTheDocument());
  }

  it("fresh 응답이면 매출 GET을 재조회하지 않고 '이미 최신 · HH:MM' 캡션을 띄운다", async () => {
    const fetchMock = stubDualFetch(makeSales(), {
      payload: {
        status: "fresh",
        asOf: "2026-07-08T05:00:00.000Z",
        nextAllowedAt: "2026-07-08T05:01:30.000Z",
      },
    });
    await renderAndWaitInitialSales(fetchMock);

    pullDown(getSheetContainer());

    await waitFor(() => expect(orderSyncPostCount(fetchMock)).toBe(1));
    await waitFor(() =>
      expect(screen.getByText(/^이미 최신 · \d{2}:\d{2}$/)).toBeInTheDocument(),
    );
    // 재조회 생략 — 매출 GET은 최초 1회 그대로
    expect(salesGetCount(fetchMock)).toBe(1);
  });

  it("synced + changed=0 이면 재조회를 생략하고 캡션만 갱신한다", async () => {
    const fetchMock = stubDualFetch(makeSales(), {
      payload: { status: "synced", asOf: "2026-07-08T05:00:00.000Z", changed: 0 },
    });
    await renderAndWaitInitialSales(fetchMock);

    pullDown(getSheetContainer());

    await waitFor(() => expect(orderSyncPostCount(fetchMock)).toBe(1));
    await waitFor(() => expect(screen.getByText(/이미 최신/)).toBeInTheDocument());
    expect(salesGetCount(fetchMock)).toBe(1);
  });

  it("synced + changed>0 이면 매출 GET을 즉시 1회 재조회한다", async () => {
    const fetchMock = stubDualFetch(makeSales(), {
      payload: { status: "synced", asOf: "2026-07-08T05:00:00.000Z", changed: 2 },
    });
    await renderAndWaitInitialSales(fetchMock);

    pullDown(getSheetContainer());

    await waitFor(() => expect(salesGetCount(fetchMock)).toBe(2));
    expect(screen.queryByText(/이미 최신/)).not.toBeInTheDocument();
  });

  it("syncing 응답이면 3초 뒤 1회만 재조회한다", async () => {
    const fetchMock = stubDualFetch(makeSales(), {
      payload: { status: "syncing", asOf: null },
    });
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    try {
      await renderAndWaitInitialSales(fetchMock);

      pullDown(getSheetContainer());
      await waitFor(() => expect(orderSyncPostCount(fetchMock)).toBe(1));

      // 3초 지연 재조회가 정확히 1건 예약된다
      await waitFor(() => {
        expect(
          setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 3000),
        ).toHaveLength(1);
      });
      const [followUp] = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 3000)!;
      act(() => {
        (followUp as () => void)();
      });
      await waitFor(() => expect(salesGetCount(fetchMock)).toBe(2));
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("성공 직후 10초 안의 재당김은 무시한다(네트워크 미발생)", async () => {
    const fetchMock = stubDualFetch(makeSales(), {
      payload: {
        status: "fresh",
        asOf: "2026-07-08T05:00:00.000Z",
        nextAllowedAt: "2026-07-08T05:01:30.000Z",
      },
    });
    await renderAndWaitInitialSales(fetchMock);
    const container = getSheetContainer();

    pullDown(container);
    await waitFor(() => expect(orderSyncPostCount(fetchMock)).toBe(1));
    await waitFor(() => expect(screen.getByText(/이미 최신/)).toBeInTheDocument());

    pullDown(container);
    // 스로틀에 걸려 추가 POST 없음
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(orderSyncPostCount(fetchMock)).toBe(1);
  });
});

describe("campaignRowToDetailData 변환", () => {
  it("CampaignRow의 정산 필드를 보존하고 미정 필드는 null/false로 정규화한다", () => {
    const row = {
      id: "camp-9",
      dealName: "글로우 앰플",
      sellerName: "미나",
      startDate: "2026-07-01",
      endDate: "2026-07-15",
      status: "SETTLEMENT_WAIT",
      salesChannel: "OWN_MALL_NAVER",
      settlementSales: 1000,
      actualPayoutAmount: null,
      expectedDepositDate: "2026-07-20",
    } as unknown as CampaignRow;
    expect(campaignRowToDetailData(row)).toEqual({
      id: "camp-9",
      kind: "campaign",
      groupId: null,
      dealName: "글로우 앰플",
      sellerName: "미나",
      roundNumber: null,
      status: "SETTLEMENT_WAIT",
      // 채널은 **폴백 없이 그대로** 실린다(`?? null` 은 2026-08-25 승격으로 제거됐다 —
      // `CampaignRow.salesChannel` 이 이미 non-null 이라 그 폴백은 방어적 잔재였다).
      salesChannel: "OWN_MALL_NAVER",
      startDate: "2026-07-01",
      endDate: "2026-07-15",
      expectedDepositDate: "2026-07-20",
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      // 완료일 3종도 같은 정규화 규약 — 값이 없으면 undefined 가 아니라 null 이다.
      depositReceivedAt: null,
      payoutCompletedAt: null,
      supplierPayoutCompletedAt: null,
      settlementSales: 1000,
      actualPayoutAmount: null,
      actualSales: null,
      sellerExpense: null,
      // 물품대금도 같은 정규화 규약 — 미입력은 undefined 가 아니라 null 이다(3-상태의 「모름」).
      settlementGoodsCost: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      members: undefined,
    });
  });
});
