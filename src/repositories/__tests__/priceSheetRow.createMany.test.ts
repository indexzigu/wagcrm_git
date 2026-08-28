import { beforeEach, describe, expect, it, vi } from "vitest";

// getPrisma / isSqliteDatabaseUrl을 모킹해 실제 DB 없이 분기 동작을 검증한다.
// serializeJsonField 내부에서도 isSqliteDatabaseUrl을 사용하므로 mock 반환값이
// row.flags / row.rawCells 직렬화 여부에도 함께 영향을 준다는 점에 유의.

const createMock = vi.fn();
const createManyMock = vi.fn();
const isSqliteDatabaseUrlMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    priceSheetRow: {
      create: createMock,
      createMany: createManyMock,
    },
  }),
}));

vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => isSqliteDatabaseUrlMock(),
}));

// mock 등록 후 로드해야 모킹이 반영된다.
const { PriceSheetRowRepository } = await import("../priceSheetRepository");

function makeRow(overrides: Partial<Parameters<typeof PriceSheetRowRepository.createMany>[1][number]> = {}) {
  return {
    rowIndex: 0,
    rawCells: { A: "상품A", B: "10000" },
    ...overrides,
  };
}

function p2002Error() {
  const err = new Error("Unique constraint failed") as Error & { code: string };
  err.code = "P2002";
  return err;
}

function p2003Error() {
  const err = new Error("Foreign key constraint failed") as Error & { code: string };
  err.code = "P2003";
  return err;
}

describe("PriceSheetRowRepository.createMany", () => {
  beforeEach(() => {
    createMock.mockReset();
    createManyMock.mockReset();
    isSqliteDatabaseUrlMock.mockReset();
  });

  it("[SQLite] createMany 대신 개별 create를 사용한다 (회귀 방지)", async () => {
    isSqliteDatabaseUrlMock.mockReturnValue(true);
    createMock.mockResolvedValue({});

    await PriceSheetRowRepository.createMany("sheet-1", [makeRow()]);

    // SQLite 경로에서는 createMany 자체가 호출되지 않아야 한다 (개별 create로 대체).
    expect(createManyMock).not.toHaveBeenCalled();
  });

  it("[SQLite] P2002(중복) 행은 스킵하고 나머지는 생성하며, count는 실제 생성 수와 일치한다", async () => {
    isSqliteDatabaseUrlMock.mockReturnValue(true);
    createMock
      .mockResolvedValueOnce({ id: "row-1" })
      .mockRejectedValueOnce(p2002Error())
      .mockResolvedValueOnce({ id: "row-3" });

    const rows = [
      makeRow({ rowIndex: 0, rawCells: { A: "1" } }),
      makeRow({ rowIndex: 1, rawCells: { A: "2" } }),
      makeRow({ rowIndex: 2, rawCells: { A: "3" } }),
    ];

    const result = await PriceSheetRowRepository.createMany("sheet-1", rows);

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ count: 2 });
  });

  it("[SQLite] P2002가 아닌 에러는 그대로 전파된다", async () => {
    isSqliteDatabaseUrlMock.mockReturnValue(true);
    createMock.mockRejectedValueOnce(p2003Error());

    await expect(
      PriceSheetRowRepository.createMany("sheet-1", [makeRow()])
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("[Postgres] createMany가 skipDuplicates: true와 함께 정확히 1회 호출되고 결과가 그대로 반환된다", async () => {
    isSqliteDatabaseUrlMock.mockReturnValue(false);
    const expected = { count: 5 };
    createManyMock.mockResolvedValue(expected);

    const rows = [makeRow({ rowIndex: 0 }), makeRow({ rowIndex: 1 })];
    const result = await PriceSheetRowRepository.createMany("sheet-1", rows);

    expect(createManyMock).toHaveBeenCalledTimes(1);
    const args = createManyMock.mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
    expect(Array.isArray(args.data)).toBe(true);
    expect(args.data).toHaveLength(2);
    expect(createMock).not.toHaveBeenCalled();
    expect(result).toBe(expected);
  });
});
