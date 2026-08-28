import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  orderCampaign: {
    findUnique: vi.fn(),
  },
  salesCampaign: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  productMapping: {
    update: vi.fn(),
  },
};

async function loadMappingService(appendFileSync: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("@/lib/order-converter/prisma", () => ({
    prisma: prismaMock,
  }));
  vi.doMock("fs", () => ({
    default: { appendFileSync },
    appendFileSync,
  }));

  return await import("../mapping-service");
}

describe("autoMapOrderCampaign debug log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/order-converter/prisma");
    vi.doUnmock("fs");
  });

  it("does not fail auto-mapping when the debug log file is not writable", async () => {
    const erofs = Object.assign(new Error("EROFS: read-only file system"), {
      code: "EROFS",
    });
    const appendFileSync = vi.fn(() => {
      throw erofs;
    });
    prismaMock.orderCampaign.findUnique.mockResolvedValue(null);

    const { autoMapOrderCampaign } = await loadMappingService(appendFileSync);

    await expect(autoMapOrderCampaign("order-1")).resolves.toBeUndefined();
    expect(appendFileSync).toHaveBeenCalledOnce();
  });
});
