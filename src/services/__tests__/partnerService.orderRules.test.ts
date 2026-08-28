import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// F4 Phase 2 §4단계 — 발주서 열 매핑 규칙의 서비스 계층 검증:
// D9 가드(규칙 있으면 To 비워도 slug 해제 안 함), previous 슬롯(D10), 규칙 삭제.

const findByIdOrThrowMock = vi.fn();
const updateMock = vi.fn();

vi.mock("@/repositories/partnerRepository", () => ({
  PartnerRepository: {
    findByIdOrThrow: (...args: unknown[]) => findByIdOrThrowMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock("@/lib/activity-log", () => ({
  recordActivityCreate: vi.fn().mockResolvedValue(undefined),
  recordActivityChange: vi.fn().mockResolvedValue(undefined),
  recordActivityDelete: vi.fn().mockResolvedValue(undefined),
  FIELD_LABELS: {},
  getCompareValue: (v: unknown) => JSON.stringify(v ?? null),
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateMasterDataCaches: vi.fn(),
}));

vi.mock("@/lib/asset-storage", () => ({
  googleDriveProvider: {
    createFolderForEntity: vi.fn().mockResolvedValue(null),
  },
}));

import { PartnerService } from "../partnerService";
import { withPreviousSlot } from "@/lib/order-converter/excel-rules";
import {
  TRIPP_GOLDEN_RULES as TRIPP_LEGACY_RULES,
  NUTRIONE_GOLDEN_RULES as NUTRIONE_LEGACY_RULES,
} from "@/lib/order-converter/__tests__/golden-rules.fixture";

describe("PartnerService — 발주서 열 매핑 규칙", () => {
  beforeEach(() => {
    findByIdOrThrowMock.mockReset();
    updateMock.mockReset();
    updateMock.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ id: "p1", ...data }));
  });

  describe("updatePartner D9 가드", () => {
    it("규칙이 없으면 To 비움 → slug 해제(기존 동작 유지)", async () => {
      findByIdOrThrowMock.mockResolvedValue({ id: "p1", orderTemplateSlug: "p1", orderExcelRules: null });
      await PartnerService.updatePartner("p1", { orderToEmail: "" }, "tester");
      expect(updateMock).toHaveBeenCalledWith("p1", expect.objectContaining({ orderTemplateSlug: null }));
    });

    it("확정 규칙이 있으면 To 비워도 slug를 해제하지 않는다", async () => {
      findByIdOrThrowMock.mockResolvedValue({
        id: "p1",
        orderTemplateSlug: "p1",
        orderExcelRules: TRIPP_LEGACY_RULES,
      });
      await PartnerService.updatePartner("p1", { orderToEmail: "" }, "tester");
      const data = updateMock.mock.calls[0][1] as Record<string, unknown>;
      expect("orderTemplateSlug" in data).toBe(false);
    });
  });

  describe("savePartnerOrderRules", () => {
    it("기존 활성 규칙을 previous 슬롯에 담고, slug 없으면 자동 부여한다", async () => {
      findByIdOrThrowMock.mockResolvedValue({
        id: "p1",
        orderTemplateSlug: null,
        orderExcelRules: TRIPP_LEGACY_RULES,
      });
      await PartnerService.savePartnerOrderRules("p1", NUTRIONE_LEGACY_RULES, "tester");
      const data = updateMock.mock.calls[0][1] as {
        orderExcelRules: { write: { mode: string }; previous?: { write: { mode: string }; previous?: unknown } };
        orderTemplateSlug?: string;
      };
      expect(data.orderTemplateSlug).toBe("p1");
      expect(data.orderExcelRules.write.mode).toBe("fill-template");
      expect(data.orderExcelRules.previous?.write.mode).toBe("new-workbook");
      expect(data.orderExcelRules.previous?.previous).toBeUndefined(); // 중첩 방지
    });

    it("클라이언트가 previous를 보내도 서버가 소유한 값으로 대체한다", async () => {
      findByIdOrThrowMock.mockResolvedValue({ id: "p1", orderTemplateSlug: "p1", orderExcelRules: null });
      const clientSent = { ...NUTRIONE_LEGACY_RULES, previous: TRIPP_LEGACY_RULES };
      await PartnerService.savePartnerOrderRules("p1", clientSent, "tester");
      const data = updateMock.mock.calls[0][1] as { orderExcelRules: { previous?: unknown } };
      expect(data.orderExcelRules.previous).toBeUndefined(); // 현 활성 규칙이 없으므로 previous 없음
    });
  });

  describe("restorePartnerOrderRules", () => {
    it("활성↔직전을 스왑한다", async () => {
      const active = withPreviousSlot(NUTRIONE_LEGACY_RULES, TRIPP_LEGACY_RULES);
      findByIdOrThrowMock.mockResolvedValue({ id: "p1", orderExcelRules: active });
      await PartnerService.restorePartnerOrderRules("p1", "tester");
      const data = updateMock.mock.calls[0][1] as {
        orderExcelRules: { write: { mode: string }; previous?: { write: { mode: string } } };
      };
      expect(data.orderExcelRules.write.mode).toBe("new-workbook");
      expect(data.orderExcelRules.previous?.write.mode).toBe("fill-template");
    });

    it("직전 규칙이 없으면 에러", async () => {
      findByIdOrThrowMock.mockResolvedValue({ id: "p1", orderExcelRules: TRIPP_LEGACY_RULES });
      await expect(PartnerService.restorePartnerOrderRules("p1", "tester")).rejects.toThrow("이전 매핑 규칙이 없습니다");
    });
  });

  describe("deletePartnerOrderRules", () => {
    it("규칙을 DbNull로 지우되 발주 등록(slug/To)은 건드리지 않는다", async () => {
      findByIdOrThrowMock.mockResolvedValue({ id: "p1", orderTemplateSlug: "p1", orderExcelRules: TRIPP_LEGACY_RULES });
      await PartnerService.deletePartnerOrderRules("p1", "tester");
      const data = updateMock.mock.calls[0][1] as Record<string, unknown>;
      expect(data.orderExcelRules).toBe(Prisma.DbNull);
      expect("orderTemplateSlug" in data).toBe(false);
    });

    it("규칙이 없으면 조용히 no-op", async () => {
      findByIdOrThrowMock.mockResolvedValue({ id: "p1", orderExcelRules: null });
      await PartnerService.deletePartnerOrderRules("p1", "tester");
      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});
