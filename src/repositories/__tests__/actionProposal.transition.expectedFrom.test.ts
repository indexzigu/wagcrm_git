/**
 * ActionProposalRepository.transition — expectedFrom 조건부 전이 회귀 테스트 (청사진 §0-5).
 *
 * transition()에 optional expectedFrom을 추가해 내부 update를 조건부 updateMany로
 * 강화한다: updateMany({where:{id, status: expectedFrom}, ...})의 count===0이면
 * "이미 처리됨"으로 간주해 throw한다(동시 승인/더블클릭 방어). expectedFrom을
 * 넘기지 않는 기존 호출부는 현행 동작(무조건 update)을 그대로 유지해야 한다
 * (순수 추가 — 회귀 없음).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();
const updateMock = vi.fn();
const updateManyMock = vi.fn();
const eventCreateMock = vi.fn();
const transactionMock = vi.fn();
const isSqliteDatabaseUrlMock = vi.fn(() => false);

const fakeTx = {
  actionProposal: {
    findUnique: findUniqueMock,
    findUniqueOrThrow: findUniqueOrThrowMock,
    update: updateMock,
    updateMany: updateManyMock,
  },
  actionProposalEvent: { create: eventCreateMock },
};

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: transactionMock,
    actionProposal: { create: vi.fn(), findUnique: findUniqueMock, findMany: vi.fn() },
    actionProposalEvent: { create: eventCreateMock },
  }),
}));

vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => isSqliteDatabaseUrlMock(),
}));

const { ActionProposalRepository } = await import("../actionProposalRepository");

describe("ActionProposalRepository.transition — expectedFrom 조건부 전이", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    findUniqueOrThrowMock.mockReset();
    updateMock.mockReset();
    updateManyMock.mockReset();
    eventCreateMock.mockReset();
    transactionMock.mockReset();

    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx));
    updateMock.mockResolvedValue({ id: "proposal-1", status: "APPROVED" });
    findUniqueOrThrowMock.mockResolvedValue({ id: "proposal-1", status: "APPROVED" });
    eventCreateMock.mockResolvedValue({});
  });

  it("expectedFrom 미전달 시 기존과 동일하게 무조건 update를 사용한다 (회귀 없음)", async () => {
    findUniqueMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL", kind: "WRITE" });

    await ActionProposalRepository.transition("proposal-1", "APPROVED", {
      actor: "admin@example.com",
      tx: fakeTx as any,
    });

    expect(updateMock).toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("expectedFrom 전달 시 조건부 updateMany를 사용하고, count>=1이면 정상 진행한다", async () => {
    findUniqueMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL", kind: "WRITE" });
    updateManyMock.mockResolvedValue({ count: 1 });

    const result = await ActionProposalRepository.transition("proposal-1", "APPROVED", {
      actor: "admin@example.com",
      expectedFrom: "PENDING_APPROVAL",
      tx: fakeTx as any,
    });

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "proposal-1", status: "PENDING_APPROVAL" }),
      })
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  it("expectedFrom 전달 + count===0이면 '이미 처리됨'으로 throw하고 이벤트를 남기지 않는다", async () => {
    findUniqueMock.mockResolvedValue({ id: "proposal-1", status: "PENDING_APPROVAL", kind: "WRITE" });
    updateManyMock.mockResolvedValue({ count: 0 });

    await expect(
      ActionProposalRepository.transition("proposal-1", "APPROVED", {
        actor: "admin@example.com",
        expectedFrom: "PENDING_APPROVAL",
        tx: fakeTx as any,
      })
    ).rejects.toThrow(/이미 처리|동시|count/);

    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it("canTransition 화이트리스트를 여전히 통과해야 한다 (expectedFrom과 무관하게 불법 전이는 차단)", async () => {
    findUniqueMock.mockResolvedValue({ id: "proposal-1", status: "EXECUTED", kind: "WRITE" });

    await expect(
      ActionProposalRepository.transition("proposal-1", "APPROVED", {
        actor: "admin@example.com",
        expectedFrom: "EXECUTED",
        tx: fakeTx as any,
      })
    ).rejects.toThrow(/Illegal ActionProposal transition/);

    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
