/**
 * T-310: re-extracting an APPLYING/APPLIED sheet must be refused before any rows are written.
 * Re-extraction (path B is an LLM) can yield new rawCells → new rowHash → fresh rows for the same
 * products; mapping + apply would then create the same Deals a second time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const sheet = {
  id: "sheet-1",
  status: "UPLOADED",
  assetId: "price-sheets/a.xlsx",
  extractPath: "A",
  sourceFormat: "XLSX",
  partnerId: null as string | null,
};
const readAssetBytesMock = vi.fn();
const createManyMock = vi.fn();
const extractPathAMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireAuth: async () => ({ authenticated: true }) }));
vi.mock("@/lib/asset-storage", () => ({
  SUPABASE_PROVIDER: "SUPABASE",
  readAssetBytes: (...a: unknown[]) => readAssetBytesMock(...a),
}));
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
    PriceSheetRowRepository: { createMany: (...a: unknown[]) => createManyMock(...a) },
  };
});
vi.mock("@/lib/price-sheet/extract-path-a", () => ({ extractPathA: (...a: unknown[]) => extractPathAMock(...a) }));
vi.mock("@/lib/price-sheet/extract-path-b", () => ({ extractPathBPptx: vi.fn(), extractPathBInline: vi.fn() }));
vi.mock("@/lib/price-sheet/serialize-response", () => ({ normalizePriceSheetForResponse: (s: unknown) => s }));

const { POST } = await import("./route");
const post = () =>
  POST(new NextRequest("http://localhost/api/price-sheets/sheet-1/extract", { method: "POST" }), {
    params: Promise.resolve({ id: "sheet-1" }),
  });

beforeEach(() => {
  readAssetBytesMock.mockReset();
  readAssetBytesMock.mockResolvedValue(Buffer.from("x"));
  createManyMock.mockReset();
  createManyMock.mockResolvedValue({ count: 1 });
  extractPathAMock.mockReset();
  extractPathAMock.mockResolvedValue({ rows: [{ rowIndex: 0, rawCells: ["a"] }], policyText: null, detectedTables: 1 });
});

describe("POST /api/price-sheets/[id]/extract — from-state guard", () => {
  it("extracts an UPLOADED sheet to EXTRACTED", async () => {
    sheet.status = "UPLOADED";
    const res = await post();
    expect(res.status).toBe(200);
    expect(sheet.status).toBe("EXTRACTED");
    expect(createManyMock).toHaveBeenCalledTimes(1);
  });

  it.each(["APPLIED", "APPLYING"])("refuses a %s sheet before writing any rows", async (status) => {
    sheet.status = status;
    const res = await post();
    expect(res.status).toBe(409);
    expect(sheet.status).toBe(status);
    expect(readAssetBytesMock).not.toHaveBeenCalled();
    expect(createManyMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a sheet that became APPLIED while the extraction was running", async () => {
    sheet.status = "MAPPED";
    extractPathAMock.mockImplementation(async () => {
      sheet.status = "APPLIED"; // an apply finished during the (long) extraction call
      return { rows: [], policyText: null, detectedTables: 1 };
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(sheet.status).toBe("APPLIED");
  });

  it("does not mark an APPLIED sheet EXTRACT_FAILED when extraction fails mid-flight", async () => {
    sheet.status = "MAPPED";
    extractPathAMock.mockImplementation(async () => {
      sheet.status = "APPLIED";
      throw new Error("llm down");
    });
    await post();
    expect(sheet.status).toBe("APPLIED");
  });
});
