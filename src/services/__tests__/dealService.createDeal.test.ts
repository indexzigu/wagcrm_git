import { describe, it, expect, vi, beforeEach } from "vitest";

// dealService.createDeal(C2-1)의 근본 원인 수정을 검증한다:
// zod(createDealSchema)는 unit/unitQuantity/supplementaryInfo를 받지만 기존 구현은
// create data에 넣지 않고 버렸다(청사진 §C2-1). 또한 dealType=OPTION && parentDealId가
// 있으면 brandName/unit을 부모에서 상속해야 한다.

const createMock = vi.fn();
const findFirstMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock("@/repositories/dealRepository", () => ({
  dealRepository: {
    create: (...args: unknown[]) => createMock(...args),
    findFirst: (...args: unknown[]) => findFirstMock(...args),
    findUnique: (...args: unknown[]) => findUniqueMock(...args),
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
  googleDriveProvider: {
    createFolderForEntity: vi.fn().mockResolvedValue(null),
  },
}));

import { dealService } from "../dealService";

describe("dealService.createDeal (C2-1 — 데이터 위생)", () => {
  beforeEach(() => {
    createMock.mockReset();
    findFirstMock.mockReset();
    findUniqueMock.mockReset();
    createMock.mockResolvedValue({
      id: "deal-new",
      dealName: "테스트 딜",
      brandName: null,
      partnerId: "partner-1",
      partner: null,
      costPrice: 1000,
      sellingPrice: 2000,
      baseMarginPolicy: "{}",
      status: "SOURCING",
      _count: { campaigns: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("unit/unitQuantity/supplementaryInfo를 create data에 저장한다 (기존엔 버려짐)", async () => {
    await dealService.createDeal(
      {
        dealName: "락토핏 골드 4박스",
        partnerId: "partner-1",
        costPrice: 1000,
        sellingPrice: 2000,
        unit: "박스",
        unitQuantity: 4,
        supplementaryInfo: JSON.stringify({ searchKeyword: "종근당 락토핏 골드" }),
      },
      "actor@test.com"
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    const createArgs = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.unit).toBe("박스");
    expect(createArgs.data.unitQuantity).toBe(4);
    expect(createArgs.data.supplementaryInfo).toBe(
      JSON.stringify({ searchKeyword: "종근당 락토핏 골드" })
    );
  });

  it("unit/unitQuantity/supplementaryInfo가 없으면 null로 저장한다", async () => {
    await dealService.createDeal(
      {
        dealName: "메인 딜",
        partnerId: "partner-1",
        costPrice: 1000,
        sellingPrice: 2000,
      },
      "actor@test.com"
    );

    const createArgs = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.unit).toBeNull();
    expect(createArgs.data.unitQuantity).toBeNull();
    expect(createArgs.data.supplementaryInfo).toBeNull();
  });

  it("dealType=OPTION이고 parentDealId가 있으면 brandName/unit을 부모에서 상속한다 (입력에 없을 때)", async () => {
    findFirstMock.mockResolvedValue({
      brandName: "종근당",
      unit: "박스",
      optionSortOrder: 2,
    });

    await dealService.createDeal(
      {
        dealName: "부모딜 - 화이트",
        partnerId: "partner-1",
        costPrice: 1000,
        sellingPrice: 2000,
        dealType: "OPTION",
        parentDealId: "parent-1",
      },
      "actor@test.com"
    );

    const createArgs = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.brandName).toBe("종근당");
    expect(createArgs.data.unit).toBe("박스");
  });

  it("dealType=OPTION이라도 입력에 brandName/unit이 있으면 부모 상속보다 우선한다", async () => {
    findFirstMock.mockResolvedValue({
      brandName: "부모브랜드",
      unit: "부모단위",
      optionSortOrder: 0,
    });

    await dealService.createDeal(
      {
        dealName: "부모딜 - 화이트",
        partnerId: "partner-1",
        costPrice: 1000,
        sellingPrice: 2000,
        dealType: "OPTION",
        parentDealId: "parent-1",
        brandName: "자식전용브랜드",
        unit: "개",
      },
      "actor@test.com"
    );

    const createArgs = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.brandName).toBe("자식전용브랜드");
    expect(createArgs.data.unit).toBe("개");
  });

  it("dealType=MAIN(기본값)이면 부모 상속 로직을 타지 않는다 (findFirst 미호출 또는 브랜드 null 유지)", async () => {
    await dealService.createDeal(
      {
        dealName: "메인 딜",
        partnerId: "partner-1",
        costPrice: 1000,
        sellingPrice: 2000,
      },
      "actor@test.com"
    );

    const createArgs = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.brandName).toBeNull();
  });

  it("[Major 3 회귀] optionSortOrder 조회와 부모 상속 조회가 순차가 아닌 병렬로 실행된다", async () => {
    // 두 findFirst 호출(형제 optionSortOrder 조회 / 부모 상속 조회)이 순차 await라면, 첫 번째
    // 호출의 프라미스가 resolve되기 전까지 두 번째 호출은 아예 시작(호출)되지 않는다.
    // Promise.all 병렬화라면 두 호출 모두 "동시에" 시작되어야 한다 — 이를 지연 프라미스로
    // 검증한다: 첫 번째 호출을 절대 resolve하지 않는 pending 상태로 묶어 두고, 그 사이에
    // 두 번째 호출이 이미 시작되었는지(findFirstMock 호출 횟수가 2가 되었는지) 확인한다.
    let resolveFirstCall: ((value: unknown) => void) | undefined;
    const callArgs: unknown[] = [];

    findFirstMock.mockImplementation((args: unknown) => {
      callArgs.push(args);
      if (callArgs.length === 1) {
        // 첫 번째 호출(형제 optionSortOrder 조회로 가정)은 의도적으로 오래 pending 상태로 둔다.
        return new Promise((resolve) => {
          resolveFirstCall = resolve;
        });
      }
      // 두 번째 호출(부모 상속 조회로 가정)은 즉시 resolve.
      return Promise.resolve({ brandName: "종근당", unit: "박스" });
    });

    const createPromise = dealService.createDeal(
      {
        dealName: "부모딜 - 화이트",
        partnerId: "partner-1",
        costPrice: 1000,
        sellingPrice: 2000,
        dealType: "OPTION",
        parentDealId: "parent-1",
      },
      "actor@test.com"
    );

    // 마이크로태스크 큐를 한 바퀴 돌려 동기적으로 시작 가능한 호출들이 모두 시작되게 한다.
    await Promise.resolve();
    await Promise.resolve();

    // 순차 구현이면 이 시점에 findFirstMock은 1회만 호출되어 있어야 한다(첫 호출이
    // pending이라 두 번째 await까지 도달하지 못함). 병렬 구현이면 2회 모두 호출되어 있다.
    expect(findFirstMock.mock.calls.length).toBe(2);

    // 정리: pending으로 묶어둔 첫 호출을 resolve해 테스트가 끝날 수 있게 한다.
    resolveFirstCall?.({ optionSortOrder: 2 });
    await createPromise;
  });
});
