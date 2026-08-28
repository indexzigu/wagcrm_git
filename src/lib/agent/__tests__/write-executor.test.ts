/**
 * write-executor 단위 테스트 (청사진 §2, G1).
 *
 * executeWriteAction은 화이트리스트(WRITE_ACTIONS)에 등록된 action만 디스패치하고,
 * 실행 전 대상 엔티티 존재를 검증한다(§0-6). 임의 {service,method} eval은 절대 금지 —
 * 화이트리스트 밖 action은 등록되지 않았다는 이유로 그대로 거부되어야 한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordActivityMemoMock = vi.fn();
const recordActivityChangeMock = vi.fn();
const dealFindUniqueMock = vi.fn();
const dealUpdateMock = vi.fn();
const campaignFindUniqueMock = vi.fn();
const campaignUpdateManyMock = vi.fn();
const campaignFindManyMock = vi.fn();
const groupUpdateManyMock = vi.fn();
const groupFindUniqueMock = vi.fn();
const partnerFindUniqueMock = vi.fn();
const sellerFindUniqueMock = vi.fn();

vi.mock("@/lib/activity-log", () => ({
  recordActivityMemo: (...args: unknown[]) => recordActivityMemoMock(...args),
  recordActivityChange: (...args: unknown[]) => recordActivityChangeMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    deal: { findUnique: dealFindUniqueMock, update: dealUpdateMock },
    salesCampaign: {
      findUnique: campaignFindUniqueMock,
      updateMany: campaignUpdateManyMock,
      findMany: campaignFindManyMock,
    },
    campaignGroup: { updateMany: groupUpdateManyMock, findUnique: groupFindUniqueMock },
    partner: { findUnique: partnerFindUniqueMock },
    seller: { findUnique: sellerFindUniqueMock },
  }),
}));

const { executeWriteAction, WRITE_ACTIONS } = await import("../write-executor");

const fakeTx = {
  deal: { findUnique: dealFindUniqueMock, update: dealUpdateMock },
  salesCampaign: {
    findUnique: campaignFindUniqueMock,
    updateMany: campaignUpdateManyMock,
    findMany: campaignFindManyMock,
  },
  campaignGroup: { updateMany: groupUpdateManyMock, findUnique: groupFindUniqueMock },
  partner: { findUnique: partnerFindUniqueMock },
  seller: { findUnique: sellerFindUniqueMock },
} as any;

describe("write-executor — 화이트리스트 디스패치", () => {
  beforeEach(() => {
    recordActivityMemoMock.mockReset();
    recordActivityChangeMock.mockReset();
    dealFindUniqueMock.mockReset();
    dealUpdateMock.mockReset();
    campaignFindUniqueMock.mockReset();
    campaignUpdateManyMock.mockReset();
    partnerFindUniqueMock.mockReset();
    sellerFindUniqueMock.mockReset();
  });

  it("WRITE_ACTIONS에 add_entity_memo, change_deal_status, confirm_settlement 3종이 등록되어 있다 (Phase 5 확장)", () => {
    expect(Object.keys(WRITE_ACTIONS).sort()).toEqual(
      ["add_entity_memo", "change_deal_status", "confirm_settlement"].sort()
    );
  });

  it("화이트리스트에 없는 action은 등록되지 않았다는 이유로 거부한다", async () => {
    await expect(
      executeWriteAction(
        "delete_everything" as never,
        { entityType: "DEAL", entityId: "deal-1", content: "메모" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow(/등록되지 않은|알 수 없는|화이트리스트/);

    expect(recordActivityMemoMock).not.toHaveBeenCalled();
  });

  it("args 스키마 검증 실패 시(content 누락) throw하고 아무것도 쓰지 않는다", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "deal-1" });

    await expect(
      executeWriteAction(
        "add_entity_memo",
        { entityType: "DEAL", entityId: "deal-1" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow();

    expect(recordActivityMemoMock).not.toHaveBeenCalled();
  });

  it("entityType이 지원 범위 밖이면 거부한다", async () => {
    await expect(
      executeWriteAction(
        "add_entity_memo",
        { entityType: "UNKNOWN_TYPE", entityId: "x-1", content: "메모" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow();
  });

  it("대상 엔티티(DEAL)가 존재하지 않으면 throw하고 메모를 남기지 않는다 (§0-6)", async () => {
    dealFindUniqueMock.mockResolvedValue(null);

    await expect(
      executeWriteAction(
        "add_entity_memo",
        { entityType: "DEAL", entityId: "deal-ghost", content: "메모" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow(/찾을 수 없|존재하지 않/);

    expect(dealFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "deal-ghost" } })
    );
    expect(recordActivityMemoMock).not.toHaveBeenCalled();
  });

  it("대상 엔티티(CAMPAIGN)가 존재하면 recordActivityMemo를 tx와 함께 호출하고 결과를 반환한다", async () => {
    campaignFindUniqueMock.mockResolvedValue({ id: "camp-1" });
    recordActivityMemoMock.mockResolvedValue({ id: "log-1" });

    const result = await executeWriteAction(
      "add_entity_memo",
      { entityType: "CAMPAIGN", entityId: "camp-1", content: "재고 확인 요망" } as never,
      "approver@example.com",
      fakeTx
    );

    expect(campaignFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "camp-1" } })
    );
    expect(recordActivityMemoMock).toHaveBeenCalledWith(
      "CAMPAIGN",
      "camp-1",
      "재고 확인 요망",
      "approver@example.com",
      fakeTx
    );
    expect(result).toMatchObject({ refType: "CAMPAIGN", refId: "camp-1" });
  });

  it("PARTNER/SELLER 엔티티도 각각 findUnique로 존재를 검증한다", async () => {
    partnerFindUniqueMock.mockResolvedValue({ id: "partner-1" });
    recordActivityMemoMock.mockResolvedValue({ id: "log-2" });
    await executeWriteAction(
      "add_entity_memo",
      { entityType: "PARTNER", entityId: "partner-1", content: "메모" } as never,
      "actor@example.com",
      fakeTx
    );
    expect(partnerFindUniqueMock).toHaveBeenCalled();

    sellerFindUniqueMock.mockResolvedValue({ id: "seller-1" });
    recordActivityMemoMock.mockResolvedValue({ id: "log-3" });
    await executeWriteAction(
      "add_entity_memo",
      { entityType: "SELLER", entityId: "seller-1", content: "메모" } as never,
      "actor@example.com",
      fakeTx
    );
    expect(sellerFindUniqueMock).toHaveBeenCalled();
  });
});

describe("write-executor — change_deal_status", () => {
  beforeEach(() => {
    recordActivityMemoMock.mockReset();
    recordActivityChangeMock.mockReset();
    dealFindUniqueMock.mockReset();
    dealUpdateMock.mockReset();
    campaignFindUniqueMock.mockReset();
    partnerFindUniqueMock.mockReset();
    sellerFindUniqueMock.mockReset();
  });

  it("유효한 전이(SOURCING→NEGOTIATING)는 deal.update와 recordActivityChange를 호출하고 결과를 반환한다", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "deal-1", status: "SOURCING" });
    dealUpdateMock.mockResolvedValue({ id: "deal-1", status: "NEGOTIATING" });
    recordActivityChangeMock.mockResolvedValue({ id: "log-10" });

    const result = await executeWriteAction(
      "change_deal_status",
      { dealId: "deal-1", newStatus: "NEGOTIATING" } as never,
      "actor@example.com",
      fakeTx
    );

    expect(dealFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "deal-1" } }));
    expect(dealUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "deal-1" }, data: { status: "NEGOTIATING" } })
    );
    expect(recordActivityChangeMock).toHaveBeenCalledWith(
      "DEAL",
      "deal-1",
      "상태",
      "SOURCING",
      "NEGOTIATING",
      "actor@example.com",
      fakeTx
    );
    expect(result).toMatchObject({ refType: "DEAL", refId: "deal-1" });
    expect(result.summary).toEqual(expect.stringContaining("SOURCING"));
    expect(result.summary).toEqual(expect.stringContaining("NEGOTIATING"));
  });

  it("무효 전이(역행 CONFIRMED→SOURCING)는 throw하고 아무것도 쓰지 않는다", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "deal-2", status: "CONFIRMED" });

    await expect(
      executeWriteAction(
        "change_deal_status",
        { dealId: "deal-2", newStatus: "SOURCING" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow();

    expect(dealUpdateMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("DROPPED(terminal)에서 다른 상태로의 전이는 throw한다", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "deal-3", status: "DROPPED" });

    await expect(
      executeWriteAction(
        "change_deal_status",
        { dealId: "deal-3", newStatus: "NEGOTIATING" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow();

    expect(dealUpdateMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("자기 자신으로의 전이(SOURCING→SOURCING)는 무의미한 전이로 throw한다", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "deal-4", status: "SOURCING" });

    await expect(
      executeWriteAction(
        "change_deal_status",
        { dealId: "deal-4", newStatus: "SOURCING" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow(/이미/);

    expect(dealUpdateMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("대상 딜이 존재하지 않으면 throw하고 아무것도 쓰지 않는다 (§0-6)", async () => {
    dealFindUniqueMock.mockResolvedValue(null);

    await expect(
      executeWriteAction(
        "change_deal_status",
        { dealId: "deal-ghost", newStatus: "NEGOTIATING" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow(/찾을 수 없|존재하지 않/);

    expect(dealUpdateMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("newStatus가 유효 enum 밖이면 args 검증에서 거부된다", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "deal-5", status: "SOURCING" });

    await expect(
      executeWriteAction(
        "change_deal_status",
        { dealId: "deal-5", newStatus: "NOT_A_STATUS" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow();

    expect(dealUpdateMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("dealId 누락 시 args 검증에서 거부된다", async () => {
    await expect(
      executeWriteAction(
        "change_deal_status",
        { dealId: "", newStatus: "NEGOTIATING" } as never,
        "actor@example.com",
        fakeTx
      )
    ).rejects.toThrow();

    expect(dealFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("write-executor — confirm_settlement (🔴 금전, 청사진 §3-b)", () => {
  beforeEach(() => {
    recordActivityChangeMock.mockReset();
    campaignFindUniqueMock.mockReset();
    campaignUpdateManyMock.mockReset();
    campaignFindManyMock.mockReset();
    groupUpdateManyMock.mockReset();
    groupFindUniqueMock.mockReset();
  });

  it("입금확정(pending→confirmed): 조건부 updateMany + 감사기록, status는 무변경이라 status 활동행 없음", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-1",
      status: "SETTLEMENT_WAIT",
      salesChannel: "BRAND_MALL",
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      settlementSales: 100000,
      actualPayoutAmount: 90000,
    });
    campaignUpdateManyMock.mockResolvedValue({ count: 1 });
    recordActivityChangeMock.mockResolvedValue({ id: "log-1" });

    const result = await executeWriteAction(
      "confirm_settlement",
      { campaignId: "camp-1", target: "deposit" } as never,
      "admin@example.com",
      fakeTx
    );

    // 레이스-세이프 조건부 쓰기: where에 사전 플래그(false), status는 미포함(미완이라 autoStatus undefined)
    expect(campaignUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = campaignUpdateManyMock.mock.calls[0][0];
    expect(call.where).toEqual({ id: "camp-1", isDepositReceived: false });
    expect(call.data).toMatchObject({ isDepositReceived: true });
    expect(call.data.depositReceivedAt).toBeInstanceOf(Date);
    expect(call.data.status).toBeUndefined();

    // 감사: 플래그 변경 1건만, status 활동행 없음(정본 route parity, plan-critic Minor 2)
    expect(recordActivityChangeMock).toHaveBeenCalledTimes(1);
    expect(recordActivityChangeMock).toHaveBeenCalledWith(
      "CAMPAIGN",
      "camp-1",
      "isDepositReceived",
      false,
      true,
      "admin@example.com",
      fakeTx
    );
    expect(result).toMatchObject({ refType: "CAMPAIGN", refId: "camp-1" });
  });

  it("지급완료(confirmed→paid): 둘 다 true가 되어 status가 COMPLETED로 자동전이되고 status 활동행도 기록", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-2",
      status: "SETTLEMENT_WAIT",
      salesChannel: "BRAND_MALL",
      isDepositReceived: true,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      settlementSales: 100000,
      actualPayoutAmount: 90000,
    });
    campaignUpdateManyMock.mockResolvedValue({ count: 1 });
    recordActivityChangeMock.mockResolvedValue({ id: "log-2" });

    const result = await executeWriteAction(
      "confirm_settlement",
      { campaignId: "camp-2", target: "payout" } as never,
      "admin@example.com",
      fakeTx
    );

    const call = campaignUpdateManyMock.mock.calls[0][0];
    expect(call.where).toEqual({ id: "camp-2", isPayoutCompleted: false });
    expect(call.data).toMatchObject({ isPayoutCompleted: true, status: "COMPLETED" });
    expect(call.data.payoutCompletedAt).toBeInstanceOf(Date);

    // 플래그 변경 + status 변경 2건
    expect(recordActivityChangeMock).toHaveBeenCalledTimes(2);
    expect(recordActivityChangeMock).toHaveBeenCalledWith(
      "CAMPAIGN",
      "camp-2",
      "isPayoutCompleted",
      false,
      true,
      "admin@example.com",
      fakeTx
    );
    expect(recordActivityChangeMock).toHaveBeenCalledWith(
      "CAMPAIGN",
      "camp-2",
      "status",
      "SETTLEMENT_WAIT",
      "COMPLETED",
      "admin@example.com",
      fakeTx
    );
    expect(result.summary).toEqual(expect.stringContaining("COMPLETED"));
  });

  it("역행/건너뛰기(pending에서 payout)는 상태기계 가드로 throw하고 아무것도 쓰지 않는다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-3",
      status: "SETTLEMENT_WAIT",
      salesChannel: "BRAND_MALL",
      isDepositReceived: false,
      isPayoutCompleted: false,
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-3", target: "payout" } as never,
        "admin@example.com",
        fakeTx
      )
    // 사유 문구는 슬롯에서 파생한다 — 브랜드몰의 입금 상대는 공급사다.
    ).rejects.toThrow(/공급사 입금 완료가 선행/);

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("중복 확정(이미 confirmed에서 deposit)은 throw한다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-4",
      status: "SETTLEMENT_WAIT",
      salesChannel: "BRAND_MALL",
      isDepositReceived: true,
      isPayoutCompleted: false,
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-4", target: "deposit" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/이미 입금 확정/);

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  it("이미 지급완료(paid)에서는 어떤 target도 throw한다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-5",
      status: "COMPLETED",
      salesChannel: "BRAND_MALL",
      isDepositReceived: true,
      isPayoutCompleted: true,
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-5", target: "payout" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/이미 지급 완료/);
    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  it("레이스: 상태기계는 통과했으나 updateMany count=0이면(동시 확정) throw하고 감사 미기록", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-6",
      status: "SETTLEMENT_WAIT",
      salesChannel: "BRAND_MALL",
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      settlementSales: 100000,
    });
    // 조회 후 다른 트랜잭션이 먼저 확정 → 조건부 where가 0행 매치
    campaignUpdateManyMock.mockResolvedValue({ count: 0 });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-6", target: "deposit" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/동시 처리로 이미 확정/);

    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("존재하지 않는 캠페인은 throw한다 (§0-6)", async () => {
    campaignFindUniqueMock.mockResolvedValue(null);

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "ghost", target: "deposit" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/찾을 수 없습니다/);

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  it("target이 유효 enum 밖이면 args 검증에서 거부된다", async () => {
    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-1", target: "refund" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow();
    expect(campaignFindUniqueMock).not.toHaveBeenCalled();
  });

  it("payout 확정 시 지급액(actualPayoutAmount) 미입력이면 하드 게이트로 throw하고 아무것도 쓰지 않는다 (H1)", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-7",
      status: "SETTLEMENT_WAIT",
      salesChannel: "BRAND_MALL",
      isDepositReceived: true,
      isPayoutCompleted: false,
      settlementSales: 100000,
      actualPayoutAmount: null,
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-7", target: "payout" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/필요한 값: 실지급액\(actualPayoutAmount\) 또는 판매대행비\(sellerExpense\)/);

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("입금확정 시 입금액(settlementSales)이 0이면 하드 게이트로 throw한다 (H1/M1 — 0은 미확정 취급)", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-8",
      status: "SETTLEMENT_WAIT",
      salesChannel: "BRAND_MALL",
      isDepositReceived: false,
      isPayoutCompleted: false,
      settlementSales: 0,
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-8", target: "deposit" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/필요한 값: 영업수익\(settlementSales\)/);

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  // 2026-08-25~26 회귀 2건이 이 한 케이스에 겹쳐 있다.
  //  ① 게이트가 표시 경로와 **다른 컬럼**을 보다가 프로덕션에서 100% 닫혀 있었다(#477).
  //     그 옛 컬럼 두 개는 2026-08-26 에 스키마에서 제거됐으므로 같은 방식으로는 재발할 수
  //     없지만, 「이 슬롯의 근거가 아닌 컬럼이 채워져 있어도 통과하지 않는다」는 성질은 남는다.
  //  ② 안내 문구가 채널과 무관하게 한 컬럼으로 박혀 있어, 그걸 아무리 채워도 열리지 않는
  //     컬럼을 운영자에게 안내했다(#479). 그래서 **문구가 실제 근거 컬럼을 가리키는지**까지
  //     함께 단언한다 — 거부 사실만 보면 그 오안내를 못 잡는다.
  it("근거가 아닌 컬럼이 채워져 있어도 지급완료를 거부하고, 채워야 할 실제 컬럼을 안내한다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-9",
      status: "SETTLEMENT_WAIT",
      salesChannel: "BRAND_MALL",
      isDepositReceived: true,
      isPayoutCompleted: false,
      // 브랜드몰 셀러 지급의 근거는 실지급액 ?? 판매대행비다 — settlementSales 는 입금 축이라
      // 여기 아무리 값이 있어도 이 칸을 열어서는 안 된다.
      settlementSales: 100000,
      actualPayoutAmount: null,
      sellerExpense: null,
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-9", target: "payout" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/필요한 값: 실지급액\(actualPayoutAmount\)/);

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  // ── 🔴 사각: 셀러몰 입금 경로 (#479 회귀) ────────────────────────────────
  // 위 픽스처 9건이 **전부 BRAND_MALL** 이고 SELLER_MALL 은 0건이다. 그래서 셀러몰
  // 입금 슬롯의 근거식(`SALES_MINUS_COMMISSION` = actualSales − sellerExpense)을
  // 밟는 테스트가 하나도 없었고, 호출부가 그 두 컬럼을 아예 안 넘기던 동안에도
  // 이 파일은 내내 초록이었다(#477 → #479). 타입 체커가 잡아준 것이지 테스트가
  // 잡은 게 아니다 — 그 사각을 여기서 닫는다.
  //
  // 계약을 **양방향**으로 고정한다 — 근거가 있으면 열리고, 한쪽이라도 없으면 닫힌다.
  // 한 방향만 두면 `?? 0` 폴백이 들어와도 해피패스가 초록이라 통과한다(뺄셈 기준에서
  // `?? 0` 은 결과를 매출 전액으로 만들어 **버젓한 숫자로 보인다** — tax-filing-board
  // 가 같은 함정을 두 번 밟았다).

  it("셀러몰 입금확정: actualSales − sellerExpense 를 근거로 게이트가 열린다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-11",
      status: "SETTLEMENT_WAIT",
      salesChannel: "SELLER_MALL",
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      // 이 채널의 입금 근거는 아래 두 컬럼이다. settlementSales 는 근거가 아니므로
      // **일부러 null** 로 둔다 — 브랜드몰 컬럼에 기대면 이 테스트가 무의미해진다.
      settlementSales: null,
      actualSales: 100000,
      sellerExpense: 30000,
      actualPayoutAmount: null,
    });
    campaignUpdateManyMock.mockResolvedValue({ count: 1 });
    recordActivityChangeMock.mockResolvedValue({ id: "log-11" });

    await executeWriteAction(
      "confirm_settlement",
      { campaignId: "camp-11", target: "deposit" } as never,
      "admin@example.com",
      fakeTx
    );

    expect(campaignUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = campaignUpdateManyMock.mock.calls[0][0];
    expect(call.where).toEqual({ id: "camp-11", isDepositReceived: false });
    expect(call.data).toMatchObject({ isDepositReceived: true });
  });

  it("셀러몰 입금확정: 빼는 값(sellerExpense)이 미입력이면 거부한다 (모르는 것은 모르는 채로 — ?? 0 금지)", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-12",
      status: "SETTLEMENT_WAIT",
      salesChannel: "SELLER_MALL",
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      settlementSales: null,
      actualSales: 100000,
      // 빼는 값이 없다 → 0 으로 대체하면 100000 이 「입금액」으로 둔갑한다.
      sellerExpense: null,
      actualPayoutAmount: null,
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-12", target: "deposit" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/필요한 값: 총거래액\(actualSales\)과 판매대행비\(sellerExpense\)/);

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  // ── 셀러몰 공급사 지급 = 수기 물품대금 (T-057, 오너 승인 2026-08-27) ──────────
  // 종전 계약은 「어떤 값을 넣어도 열리지 않는다」였다(#479 가 문구만 정직하게 고친
  // 임시 봉합). 대안 조사 결론은 **캠페인 단위 물품대금을 데이터에서 끌어낼 경로가 없다**
  // 였고, 그래서 새 추정을 만들지 않고 **수기 3-상태**를 그대로 근거로 쓴다.
  // ⛔ 세 갈래를 하나로 접지 말 것 — 열림 / 채우면 열림 / 채울 것 없음은 다른 사실이다.

  function sellerMallPayoutCampaign(over: Record<string, unknown>) {
    return {
      id: "camp-13",
      status: "SETTLEMENT_WAIT",
      salesChannel: "SELLER_MALL",
      isDepositReceived: true,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      settlementSales: 50000,
      actualSales: 100000,
      sellerExpense: 30000,
      actualPayoutAmount: 90000,
      ...over,
    };
  }

  async function payoutMessage(): Promise<string | null> {
    try {
      await executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-13", target: "payout" } as never,
        "admin@example.com",
        fakeTx
      );
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  it("셀러몰 지급완료: 수기 물품대금이 있으면 게이트가 열린다", async () => {
    campaignFindUniqueMock.mockResolvedValue(
      sellerMallPayoutCampaign({ settlementGoodsCost: 620_000 })
    );
    campaignUpdateManyMock.mockResolvedValue({ count: 1 });
    recordActivityChangeMock.mockResolvedValue({ id: "log-13" });

    expect(await payoutMessage()).toBeNull();
    expect(campaignUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = campaignUpdateManyMock.mock.calls[0][0];
    expect(call.where).toEqual({ id: "camp-13", isPayoutCompleted: false });
    expect(call.data).toMatchObject({ isPayoutCompleted: true });
  });

  it("셀러몰 지급완료: 미입력이면 **물품대금** 컬럼을 채우라고 안내한다", async () => {
    // 🪤 이 픽스처는 actualSales·settlementSales 를 **둘 다** 갖고 있다. 공식 폴백이
    //    되살아나면 100000-50000=50000 으로 게이트가 열려 버리므로, 이 단언이 그
    //    회귀(2026-08-06 실물 대조에서 기각된 추정)를 함께 잡는다.
    campaignFindUniqueMock.mockResolvedValue(
      sellerMallPayoutCampaign({ settlementGoodsCost: null })
    );

    const message = await payoutMessage();
    expect(message).toMatch(/필요한 값: 수기 물품대금\(settlementGoodsCost\)/);
    // ⛔ 근거가 아닌 컬럼을 안내하면 아무리 채워도 열리지 않는다(#479 가 고친 실패 형태).
    expect(message).not.toMatch(/settlementSales|actualPayoutAmount/);
    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  it("셀러몰 지급완료: `0`(합산 이관)은 「입력하세요」가 아니라 사유를 말한다", async () => {
    // 이 캠페인 몫은 **다른 캠페인의 계산서**에 실려 있어 여기서 확정할 실체가 없다.
    // 채우라고 안내하면 오너가 이미 올바르게 넣은 0 을 지우고 남의 금액을 옮겨 적는다.
    campaignFindUniqueMock.mockResolvedValue(
      sellerMallPayoutCampaign({ settlementGoodsCost: 0 })
    );

    const message = await payoutMessage();
    expect(message).toMatch(/합산/);
    expect(message).not.toMatch(/입력 후 다시 시도/);
    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });


  it("자사몰처럼 그 채널에 없는 대금 칸이면 금액이 있어도 거부한다 (슬롯 미존재 = 확정 불가)", async () => {
    // 자사몰에는 입금 슬롯이 없다(슬롯 SSOT). 상태기계가 먼저 걸러내지만, 그 판정이
    // 느슨해져도 금액 없이 확정되지 않도록 이 게이트도 함께 닫는다.
    campaignFindUniqueMock.mockResolvedValue({
      id: "camp-10",
      status: "SETTLEMENT_WAIT",
      salesChannel: "OWN_MALL_NAVER",
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: true,
      settlementSales: 100000,
      actualPayoutAmount: 90000,
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-10", target: "deposit" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/이 판매채널에는 입금 확정 절차가 없습니다/);
    // ⚠️ 이 케이스는 **상태기계**(isValidSettlementAction)가 먼저 잡는다 — 금액 게이트의
    //    슬롯 미존재 분기는 그 판정이 느슨해질 때를 대비한 방어층이라 여기서 도달하지
    //    않는다. 막연한 toThrow() 로 두면 「엉뚱한 이유로 실패해도 초록」이 된다.

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });
});

/**
 * CG-1 회귀 — 조합 캠페인의 정산 확정.
 *
 * 완료 플래그의 정본은 **그룹 스칼라**이고 멤버 행 값은 낡을 수 있다. 종전 이 핸들러는
 * 그룹을 조회조차 하지 않고 `salesCampaign.updateMany` 하나만 돌려서, 그룹 소속 캠페인을
 * 확정하면 멤버 행만 true 가 되고 **그룹 스칼라는 false 로 남았다** — 화면·지연 판정·정산
 * 목록이 전부 그룹 스칼라를 읽으므로 「확정했는데 화면은 그대로」가 됐다.
 * 아래 5건은 그 결함의 세 얼굴(읽기·쓰기·금액 게이트의 범위)을 각각 고정한다.
 */
describe("write-executor — confirm_settlement × 조합 캠페인 (CG-1)", () => {
  const GROUP_CAMPAIGN = {
    id: "camp-g1",
    status: "SETTLEMENT_WAIT",
    salesChannel: "BRAND_MALL",
    groupId: "g1",
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    settlementSales: 100000,
    actualPayoutAmount: 90000,
  };

  function groupFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: "g1",
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    recordActivityChangeMock.mockReset();
    campaignFindUniqueMock.mockReset();
    campaignUpdateManyMock.mockReset();
    campaignFindManyMock.mockReset();
    groupUpdateManyMock.mockReset();
    groupFindUniqueMock.mockReset();

    recordActivityChangeMock.mockResolvedValue({ id: "log" });
    campaignUpdateManyMock.mockResolvedValue({ count: 1 });
    groupUpdateManyMock.mockResolvedValue({ count: 1 });
    groupFindUniqueMock.mockResolvedValue(groupFixture());
    campaignFindManyMock.mockResolvedValue([GROUP_CAMPAIGN]);
  });

  it("플래그를 그룹 스칼라에 쓰고 멤버 행에는 쓰지 않는다", async () => {
    campaignFindUniqueMock.mockResolvedValue({ ...GROUP_CAMPAIGN, group: groupFixture() });

    await executeWriteAction(
      "confirm_settlement",
      { campaignId: "camp-g1", target: "deposit" } as never,
      "admin@example.com",
      fakeTx
    );

    expect(groupUpdateManyMock).toHaveBeenCalledTimes(1);
    const call = groupUpdateManyMock.mock.calls[0][0];
    // 멤버십 조건 + 레이스-세이프 선행조건이 **정본 행에** 실린다.
    expect(call.where).toEqual({
      id: "g1",
      members: { some: { id: "camp-g1" } },
      isDepositReceived: false,
    });
    expect(call.data).toMatchObject({ isDepositReceived: true });
    expect(call.data.depositReceivedAt).toBeInstanceOf(Date);

    // ⛔ 핵심 회귀: 멤버 행에는 플래그가 가지 않는다(status 변화도 없으니 아예 호출 없음).
    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  it("status 자동전이는 그룹이어도 멤버 행에 쓴다(그룹 스칼라에 status 가 없다)", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      ...GROUP_CAMPAIGN,
      group: groupFixture({ isDepositReceived: true }),
    });

    await executeWriteAction(
      "confirm_settlement",
      { campaignId: "camp-g1", target: "payout" } as never,
      "admin@example.com",
      fakeTx
    );

    expect(groupUpdateManyMock.mock.calls[0][0].data).toMatchObject({ isPayoutCompleted: true });
    expect(campaignUpdateManyMock).toHaveBeenCalledTimes(1);
    const campaignCall = campaignUpdateManyMock.mock.calls[0][0];
    expect(campaignCall.data).toEqual({ status: "COMPLETED" });
    // 선행조건은 플래그가 사는 행에만 — 멤버 행 플래그는 낡았을 수 있어 걸면 안 된다.
    expect(campaignCall.where).toEqual({ id: "camp-g1" });
  });

  it("전진 검증이 멤버 행이 아니라 그룹 스칼라를 본다(이미 확정된 그룹은 거부)", async () => {
    // 멤버 행은 false 인데 그룹은 이미 입금 확정 — 종전 코드는 이 상태를 미확정으로 읽고
    // 두 번째 확정을 통과시켜 타임스탬프를 덮어썼다.
    campaignFindUniqueMock.mockResolvedValue({
      ...GROUP_CAMPAIGN,
      group: groupFixture({ isDepositReceived: true }),
    });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-g1", target: "deposit" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/이미 입금 확정된 정산입니다/);

    expect(groupUpdateManyMock).not.toHaveBeenCalled();
    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  it("금액 게이트는 대표 멤버가 아니라 조합 전체를 센다(쓰기가 미치는 범위와 일치)", async () => {
    // 대표 멤버는 금액 미입력이고 형제에게만 값이 있다. 이 쓰기는 조합 전체를 확정하므로
    // 「확정할 실체 금액」도 조합 전체로 봐야 한다(`sumMoneySlotAmounts` 규약).
    campaignFindUniqueMock.mockResolvedValue({
      ...GROUP_CAMPAIGN,
      settlementSales: null,
      group: groupFixture(),
    });
    campaignFindManyMock.mockResolvedValue([
      { ...GROUP_CAMPAIGN, settlementSales: null },
      { ...GROUP_CAMPAIGN, id: "camp-g2", settlementSales: 250000 },
    ]);

    await executeWriteAction(
      "confirm_settlement",
      { campaignId: "camp-g1", target: "deposit" } as never,
      "admin@example.com",
      fakeTx
    );

    expect(groupUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it("조합 전체가 금액 미입력이면 거부한다(합산이 0 이 아니라 null 이다)", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      ...GROUP_CAMPAIGN,
      settlementSales: null,
      group: groupFixture(),
    });
    campaignFindManyMock.mockResolvedValue([
      { ...GROUP_CAMPAIGN, settlementSales: null },
      { ...GROUP_CAMPAIGN, id: "camp-g2", settlementSales: null },
    ]);

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-g1", target: "deposit" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/금액 근거가 비어 있거나 0 이하입니다/);

    expect(groupUpdateManyMock).not.toHaveBeenCalled();
  });

  it("그룹 멤버십이 바뀌어 그룹 쓰기가 거절되면 멤버 행도 건드리지 않고 실패한다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      ...GROUP_CAMPAIGN,
      group: groupFixture({ isDepositReceived: true }),
    });
    groupUpdateManyMock.mockResolvedValue({ count: 0 });

    await expect(
      executeWriteAction(
        "confirm_settlement",
        { campaignId: "camp-g1", target: "payout" } as never,
        "admin@example.com",
        fakeTx
      )
    ).rejects.toThrow(/동시 처리로 이미 확정되었습니다/);

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });
});
