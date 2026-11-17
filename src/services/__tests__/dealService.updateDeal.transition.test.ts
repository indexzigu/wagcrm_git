import { describe, it, expect, vi, beforeEach } from "vitest";

// 상태 전이 거절에 「DB 가 읽은 현재 상태」와 「요청 상태」를 싣는지 고정한다. 딜 패널은 이 두 값으로
// 오너에게 사유를 말한다 — 화면이 가진 상태는 낡았을 수 있어서(봇·다른 탭이 먼저 바꿈) 쓸 수 없다.
// 사람용 기본 문구는 그대로여야 한다(봇 경로가 같은 오류를 받는다).

const findUniqueMock = vi.fn();
const updateMock = vi.fn();

vi.mock("@/repositories/dealRepository", () => ({
  dealRepository: {
    findUnique: (...args: unknown[]) => findUniqueMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock("@/lib/activity-log", () => ({
  recordActivityCreate: vi.fn().mockResolvedValue(undefined),
  recordActivityChange: vi.fn().mockResolvedValue(undefined),
  recordActivityDelete: vi.fn().mockResolvedValue(undefined),
  FIELD_LABELS: {},
  getCompareValue: vi.fn(),
}));

vi.mock("@/lib/asset-storage", () => ({
  googleDriveProvider: { createFolderForEntity: vi.fn().mockResolvedValue(null) },
}));

import { dealService, InvalidStatusTransitionError } from "../dealService";

describe("dealService.updateDeal — 상태 전이 거절", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateMock.mockReset();
  });

  it("거절 오류에 현재 상태·요청 상태를 싣고 기본 문구는 바꾸지 않는다", async () => {
    findUniqueMock.mockResolvedValue({ id: "deal-1", status: "DROPPED", options: [] });

    const error = await dealService
      .updateDeal("deal-1", { status: "NEGOTIATING" }, "tester")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidStatusTransitionError);
    expect(error).toMatchObject({
      message: "허용되지 않는 상태 변경입니다",
      currentStatus: "DROPPED",
      requestedStatus: "NEGOTIATING",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
