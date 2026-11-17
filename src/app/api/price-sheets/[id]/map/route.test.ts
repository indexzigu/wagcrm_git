/**
 * T-310: re-running mapping must not regress an APPLYING/APPLIED sheet back to MAPPED
 * (that re-enables the apply button on a sheet whose Deals already exist).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const sheet = { id: "sheet-1", status: "MAPPED", partnerId: null as string | null };
const suggestMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireAuth: async () => ({ authenticated: true }) }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    priceSheet: {
      updateMany: async ({ where, data }: { where: { status?: { notIn?: string[] } }; data: { status: string } }) => {
        if (where.status?.notIn?.includes(sheet.status)) return { count: 0 };
        Object.assign(sheet, data);
        return { count: 1 };
      },
    },
  }),
}));
vi.mock("@/repositories/priceSheetRepository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/repositories/priceSheetRepository")>();
  return {
    ...actual,
    PriceSheetRepository: {
      findById: async () => ({ ...sheet }),
      // Real conditional write, running against the fake getPrisma().priceSheet.updateMany.
      updateStatusUnlessApplyLocked: actual.PriceSheetRepository.updateStatusUnlessApplyLocked,
      updateStatus: async (_id: string, status: string) => {
        sheet.status = status;
        return { ...sheet };
      },
    },
  };
});
vi.mock("@/lib/price-sheet/mapping", () => ({ suggestMappingsForSheet: (...a: unknown[]) => suggestMock(...a) }));
vi.mock("@/lib/price-sheet/serialize-response", () => ({ normalizePriceSheetForResponse: (s: unknown) => s }));

const { POST } = await import("./route");
const post = () =>
  POST(new NextRequest("http://localhost/api/price-sheets/sheet-1/map", { method: "POST" }), {
    params: Promise.resolve({ id: "sheet-1" }),
  });

beforeEach(() => {
  suggestMock.mockReset();
  suggestMock.mockResolvedValue([{ rowId: "row-1" }]);
});

describe("POST /api/price-sheets/[id]/map — from-state guard", () => {
  it("maps an EXTRACTED sheet to MAPPED", async () => {
    sheet.status = "EXTRACTED";
    const res = await post();
    expect(res.status).toBe(200);
    expect(sheet.status).toBe("MAPPED");
  });

  it.each(["APPLIED", "APPLYING"])("refuses a %s sheet and leaves its status alone", async (status) => {
    sheet.status = status;
    const res = await post();
    expect(res.status).toBe(409);
    expect(sheet.status).toBe(status);
    expect(suggestMock).not.toHaveBeenCalled();
  });
});
