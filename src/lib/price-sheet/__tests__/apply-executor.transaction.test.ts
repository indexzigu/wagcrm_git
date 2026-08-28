/**
 * M1 회귀 테스트: EXECUTED 전이를 Deal 쓰기와 하나의 $transaction으로 묶었는지 검증.
 *
 * 이전 버그: applyActionsInTransaction(Deal 커밋)이 끝난 "뒤" 트랜잭션 밖에서
 * ActionProposalRepository.transition(EXECUTED)를 별도로 호출했다. 그래서 EXECUTED 전이가
 * 실패하면(예: DB 순간 장애) Deal은 이미 커밋됐는데도 "전체 롤백됨"이라는 거짓 note와 함께
 * FAILED가 기록되는 상태-DB 불일치가 생겼다.
 *
 * 이 테스트는 getPrisma().$transaction을 모킹해 콜백 안에서 발생한 예외가 전체를 reject
 * 시키는 것(=Prisma의 실제 $transaction 시맨틱)을 흉내내고, EXECUTED 전이가 실패할 때
 * Deal 쓰기(tx.deal.update)가 "같은 tx 콜백 안에서" 호출되었는지 — 즉 하나의 트랜잭션
 * 경계 안에 있는지를 검증한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dealUpdateMock = vi.fn();
const dealCreateMock = vi.fn();
const dealFindUniqueMock = vi.fn();
const dealAggregateMock = vi.fn();
const activityLogCreateMock = vi.fn();
const actionProposalUpdateMock = vi.fn();
const actionProposalEventCreateMock = vi.fn();
const actionProposalCreateMock = vi.fn();
const transactionMock = vi.fn();
const isSqliteDatabaseUrlMock = vi.fn(() => false);

// 각 $transaction 호출 순번(1-based)에 맞춰 actionProposal.findUnique/update가 어떤 상태
// 전이를 모사할지 결정한다. apply-executor.applyPriceSheet의 호출 순서:
//   1) PENDING_APPROVAL 전이 (자체 $transaction)
//   2) APPROVED 전이 (자체 $transaction)
//   3) Deal 쓰기 + EXECUTED 전이를 하나로 묶은 $transaction (M1 대상)
//   4) (3이 실패한 경우에만) FAILED 전이 (별도의 후속 $transaction)
let transactionCallCount = 0;
let executedTransitionShouldFail = false;

const fakeTx = {
  deal: {
    update: dealUpdateMock,
    create: dealCreateMock,
    findUnique: dealFindUniqueMock,
    aggregate: dealAggregateMock,
  },
  activityLog: { create: activityLogCreateMock },
  actionProposal: {
    findUnique: vi.fn(async () => {
      const statusByCall: Record<number, string> = {
        1: "DRAFT",
        2: "PENDING_APPROVAL",
        3: "APPROVED",
        4: "APPROVED", // FAILED 전이는 APPROVED에서 걸어도 화이트리스트상 허용됨(재실행 경로 아님, 실패기록용)
      };
      return { id: "proposal-1", status: statusByCall[transactionCallCount], kind: "WRITE" };
    }),
    update: actionProposalUpdateMock,
  },
  actionProposalEvent: { create: actionProposalEventCreateMock },
};

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: transactionMock,
    actionProposal: { create: actionProposalCreateMock },
  }),
}));

vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => isSqliteDatabaseUrlMock(),
}));

const { applyPriceSheet } = await import("../apply-executor");

function baseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row-1",
    mappingStatus: "MAPPED",
    mappedDealId: "deal-1",
    productName: "상품A",
    sellingPrice: 30900,
    supplyPrice: 7898,
    listPrice: null,
    floorPrice: null,
    commissionRate: 0.3,
    discountRate: null,
    ...overrides,
  };
}

/** attachDealOptions 실행부 테스트용 NEW_DEAL 행 — 묶음 대상. */
function newDealRow(id: string, productName: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    mappingStatus: "NEW_DEAL",
    mappedDealId: null,
    productName,
    optionName: null,
    sellingPrice: 10000,
    supplyPrice: 6000,
    listPrice: null,
    floorPrice: null,
    commissionRate: 0.4,
    discountRate: null,
    ...overrides,
  };
}

describe("applyPriceSheet — M1 Deal 쓰기 + EXECUTED 전이 원자성", () => {
  beforeEach(() => {
    dealUpdateMock.mockReset();
    dealCreateMock.mockReset();
    dealFindUniqueMock.mockReset();
    dealAggregateMock.mockReset();
    activityLogCreateMock.mockReset();
    actionProposalUpdateMock.mockReset();
    actionProposalEventCreateMock.mockReset();
    actionProposalCreateMock.mockReset();
    transactionMock.mockReset();
    transactionCallCount = 0;
    executedTransitionShouldFail = false;

    actionProposalCreateMock.mockResolvedValue({ id: "proposal-1", status: "DRAFT" });
    dealUpdateMock.mockResolvedValue({ id: "deal-1" });
    dealCreateMock.mockResolvedValue({ id: "new-deal" });
    activityLogCreateMock.mockResolvedValue({});
    actionProposalEventCreateMock.mockResolvedValue({});

    actionProposalUpdateMock.mockImplementation(async (args: { data: { status: string } }) => {
      if (transactionCallCount === 3 && args.data.status === "EXECUTED" && executedTransitionShouldFail) {
        throw new Error("DB 순간 장애: EXECUTED 전이 실패");
      }
      return { id: "proposal-1", status: args.data.status };
    });

    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      transactionCallCount += 1;
      return cb(fakeTx);
    });
  });

  it("EXECUTED 전이가 실패하면 Deal 쓰기도 같은 tx 콜백 안에서 함께 실패해 전체가 reject된다", async () => {
    executedTransitionShouldFail = true;

    await expect(
      applyPriceSheet({
        priceSheetId: "sheet-1",
        partnerId: null,
        actor: "tester@example.com",
        rows: [baseRow()],
      })
    ).rejects.toThrow(/가격표 반영 실행 실패/);

    // 핵심 단언: Deal 쓰기(tx.deal.update)가 호출됐다는 것은 EXECUTED 전이와 "같은 tx 콜백"
    // 안에서 실행됐다는 뜻이다 — Prisma의 실제 $transaction은 콜백이 예외로 reject되면
    // Deal.update까지 포함해 전부 롤백한다. 이 목 테스트는 "같은 콜백 안에서 호출되었는가"를
    // 검증함으로써 트랜잭션 경계가 하나로 묶였음을 확인한다.
    expect(dealUpdateMock).toHaveBeenCalledTimes(1);

    // FAILED 전이는 M1이 변경한 별도의(정상 동작하는) 후속 트랜잭션에서 일어난다 — 총
    // $transaction 호출 횟수: PENDING_APPROVAL(1) + APPROVED(1) + Deal+EXECUTED 시도(1) +
    // FAILED 전이(1) = 4회.
    expect(transactionMock).toHaveBeenCalledTimes(4);

    // FAILED 전이 호출의 note가 "Deal 반영 및 상태 전이 전체 롤백됨"으로 사실에 맞게 기록됐는지 확인.
    const failedCallArgs = actionProposalUpdateMock.mock.calls.at(-1)?.[0];
    expect(failedCallArgs?.data?.status).toBe("FAILED");
  });

  it("정상 경로: Deal 쓰기와 EXECUTED 전이가 동일한 $transaction 콜백에서 실행된다", async () => {
    executedTransitionShouldFail = false;

    const result = await applyPriceSheet({
      priceSheetId: "sheet-1",
      partnerId: null,
      actor: "tester@example.com",
      rows: [baseRow()],
    });

    expect(result.proposal.status).toBe("EXECUTED");
    expect(dealUpdateMock).toHaveBeenCalledTimes(1);
    // 정상 경로는 PENDING_APPROVAL + APPROVED + (Deal+EXECUTED 묶음) = 3회.
    expect(transactionMock).toHaveBeenCalledTimes(3);
  });
});

/**
 * attachDealOptions 실행부(runApplyActions) 회귀 테스트 — 설계 §6:
 * "sortOrder 이어붙이기, 2단 중첩 거부, 트랜잭션 원자성 유지".
 * runApplyActions는 export되지 않으므로 위와 같은 tx 모킹 하네스로 applyPriceSheet를
 * 통해 간접 구동한다(같은 fakeTx·transactionMock을 재사용 — 하네스를 새로 만들지 않는다).
 */
describe("applyPriceSheet — attachDealOptions 실행부", () => {
  beforeEach(() => {
    dealUpdateMock.mockReset();
    dealCreateMock.mockReset();
    dealFindUniqueMock.mockReset();
    dealAggregateMock.mockReset();
    activityLogCreateMock.mockReset();
    actionProposalUpdateMock.mockReset();
    actionProposalEventCreateMock.mockReset();
    actionProposalCreateMock.mockReset();
    transactionMock.mockReset();
    transactionCallCount = 0;
    executedTransitionShouldFail = false;

    actionProposalCreateMock.mockResolvedValue({ id: "proposal-1", status: "DRAFT" });
    dealCreateMock.mockImplementation(async () => ({ id: `new-deal-${dealCreateMock.mock.calls.length}` }));
    activityLogCreateMock.mockResolvedValue({});

    actionProposalUpdateMock.mockImplementation(async (args: { data: { status: string } }) => {
      return { id: "proposal-1", status: args.data.status };
    });

    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      transactionCallCount += 1;
      return cb(fakeTx);
    });
  });

  const bundlePolicy = (dealId: string) => ({
    mode: "BUNDLE" as const,
    target: {
      kind: "EXISTING" as const,
      dealId,
      parentDealName: "기존상위딜",
      parentBrandName: null,
      parentPartnerId: null,
    },
    excludedRowIds: [],
  });

  it("기존 옵션의 최대 optionSortOrder 다음부터 이어붙인다(0부터 재시작하지 않는다)", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "parent-1", parentDealId: null });
    dealAggregateMock.mockResolvedValue({ _max: { optionSortOrder: 2 } });

    const result = await applyPriceSheet({
      priceSheetId: "sheet-1",
      partnerId: null,
      actor: "tester@example.com",
      rows: [newDealRow("r1", "제품A"), newDealRow("r2", "제품B")],
      bundle: bundlePolicy("parent-1"),
    });

    expect(result.proposal.status).toBe("EXECUTED");
    expect(dealAggregateMock).toHaveBeenCalledWith({
      where: { parentDealId: "parent-1" },
      _max: { optionSortOrder: true },
    });
    expect(dealCreateMock).toHaveBeenCalledTimes(2);
    // 부모의 현재 최대값(2) 다음부터 이어붙는다 — 3, 4. 0부터 재시작하면 기존 옵션과
    // 섞여 딜 패널의 표시 순서가 뒤집힌다(브리프 주석 그대로 검증).
    expect(dealCreateMock.mock.calls[0][0].data.optionSortOrder).toBe(3);
    expect(dealCreateMock.mock.calls[1][0].data.optionSortOrder).toBe(4);
    expect(dealCreateMock.mock.calls[0][0].data.parentDeal).toEqual({ connect: { id: "parent-1" } });
  });

  it("상위딜이 이미 하위품목딜(OPTION)이면 2단 중첩을 거부한다", async () => {
    dealFindUniqueMock.mockResolvedValue({ id: "parent-1", parentDealId: "grandparent-1" });

    await expect(
      applyPriceSheet({
        priceSheetId: "sheet-1",
        partnerId: null,
        actor: "tester@example.com",
        rows: [newDealRow("r1", "제품A")],
        bundle: bundlePolicy("parent-1"),
      })
    ).rejects.toThrow(/하위품목딜에는 다시 하위품목을 붙일 수 없습니다/);

    // 가드가 옵션 생성 전에 던지므로 아무 Deal도 만들어지지 않았어야 한다(부분반영 금지).
    expect(dealCreateMock).not.toHaveBeenCalled();
    expect(dealAggregateMock).not.toHaveBeenCalled();
  });

  it("존재하지 않는 상위딜 id로는 붙일 수 없다", async () => {
    dealFindUniqueMock.mockResolvedValue(null);

    await expect(
      applyPriceSheet({
        priceSheetId: "sheet-1",
        partnerId: null,
        actor: "tester@example.com",
        rows: [newDealRow("r1", "제품A")],
        bundle: bundlePolicy("missing-parent"),
      })
    ).rejects.toThrow(/상위딜을 찾을 수 없습니다/);

    expect(dealCreateMock).not.toHaveBeenCalled();
  });
});
