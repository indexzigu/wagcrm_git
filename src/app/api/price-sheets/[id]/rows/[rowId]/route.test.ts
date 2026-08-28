/**
 * M3 회귀 테스트: PATCH 행 편집 zod 검증 — 비율 필드(commissionRate/discountRate)는
 * 0~1 소수만 허용한다. 검수자가 "30%"를 뜻하고 30을 입력하면 즉시 400과 명확한 안내
 * 메시지를 반환해야 한다(서버가 30을 그대로 저장하면 Deal.totalCommissionRate=30이라는
 * 금전 사고로 이어진다).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const updateMappingMock = vi.fn();
const requireAuthMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    priceSheetRow: {
      findUnique: findUniqueMock,
      update: updateMock,
      delete: deleteMock,
    },
  }),
}));

vi.mock("@/repositories/priceSheetRepository", () => ({
  PriceSheetRowRepository: {
    updateMapping: updateMappingMock,
  },
}));

vi.mock("@/lib/price-sheet/serialize-response", () => ({
  normalizePriceSheetRowForResponse: (row: unknown) => row,
}));

const { PATCH, DELETE } = await import("./route");

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/price-sheets/sheet-1/rows/row-1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function makeParams() {
  return { params: Promise.resolve({ id: "sheet-1", rowId: "row-1" }) };
}

describe("PATCH /api/price-sheets/[id]/rows/[rowId] — M3 비율 필드 검증", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateMock.mockReset();
    updateMappingMock.mockReset();
    requireAuthMock.mockReset();
    requireAuthMock.mockResolvedValue({ authenticated: true });
    findUniqueMock.mockResolvedValue({
      id: "row-1",
      priceSheetId: "sheet-1",
      mappedDealId: null,
    });
  });

  it("commissionRate=30(퍼센트 표기 실수)은 400과 명확한 안내 메시지를 반환한다", async () => {
    const res = await PATCH(makeRequest({ commissionRate: 30 }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(400);
    const fieldErrors = body.error.fieldErrors?.commissionRate ?? [];
    expect(fieldErrors.join(" ")).toMatch(/0~1 소수로 입력하거나/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("discountRate=30도 동일하게 400을 반환한다", async () => {
    const res = await PATCH(makeRequest({ discountRate: 30 }), makeParams());
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("commissionRate=0.3(정상 소수)은 통과해 저장된다", async () => {
    updateMock.mockResolvedValue({});
    findUniqueMock
      .mockResolvedValueOnce({ id: "row-1", priceSheetId: "sheet-1", mappedDealId: null })
      .mockResolvedValueOnce({ id: "row-1", priceSheetId: "sheet-1", commissionRate: 0.3 });

    const res = await PATCH(makeRequest({ commissionRate: 0.3 }), makeParams());
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { commissionRate: 0.3 },
    });
  });

  it("commissionRate=-0.1(음수)도 범위 밖이므로 400을 반환한다", async () => {
    const res = await PATCH(makeRequest({ commissionRate: -0.1 }), makeParams());
    expect(res.status).toBe(400);
  });

  it("commissionRate=1(경계값)은 통과한다", async () => {
    updateMock.mockResolvedValue({});
    findUniqueMock
      .mockResolvedValueOnce({ id: "row-1", priceSheetId: "sheet-1", mappedDealId: null })
      .mockResolvedValueOnce({ id: "row-1", priceSheetId: "sheet-1", commissionRate: 1 });

    const res = await PATCH(makeRequest({ commissionRate: 1 }), makeParams());
    expect(res.status).toBe(200);
  });
});

describe("PATCH — 매핑 변경(명시적 null vs 미전달)", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateMock.mockReset();
    updateMappingMock.mockReset();
    requireAuthMock.mockReset();
    requireAuthMock.mockResolvedValue({ authenticated: true });
  });

  it("SUGGESTED 행을 '신규 딜로 생성'(mappedDealId:null)으로 바꾸면 제안 딜 id가 지워진다", async () => {
    // 회귀: `mappedDealId ?? existing.mappedDealId`가 명시적 null을 삼켜 제안 딜로
    // 되살아나던 버그 — Select가 제안 딜에 고정되어 변경이 안 먹히는 증상의 근본 원인.
    findUniqueMock.mockResolvedValue({
      id: "row-1",
      priceSheetId: "sheet-1",
      mappedDealId: "suggested-deal-1",
      mappingStatus: "SUGGESTED",
    });
    updateMappingMock.mockResolvedValue({});

    const res = await PATCH(
      makeRequest({ mappingStatus: "NEW_DEAL", mappedDealId: null }),
      makeParams()
    );

    expect(res.status).toBe(200);
    expect(updateMappingMock).toHaveBeenCalledWith("row-1", {
      mappingStatus: "NEW_DEAL",
      mappedDealId: null, // 제안 딜 id로 대체되면 안 된다
    });
  });

  it("mappedDealId 미전달(undefined)이면 기존 매핑을 유지한다", async () => {
    findUniqueMock.mockResolvedValue({
      id: "row-1",
      priceSheetId: "sheet-1",
      mappedDealId: "deal-1",
      mappingStatus: "SUGGESTED",
    });
    updateMappingMock.mockResolvedValue({});

    const res = await PATCH(makeRequest({ mappingStatus: "MAPPED" }), makeParams());

    expect(res.status).toBe(200);
    expect(updateMappingMock).toHaveBeenCalledWith("row-1", {
      mappingStatus: "MAPPED",
      mappedDealId: "deal-1", // 미전달 = 기존 유지
    });
  });

  it("다른 딜로 변경하면 새 딜 id가 그대로 저장된다", async () => {
    findUniqueMock.mockResolvedValue({
      id: "row-1",
      priceSheetId: "sheet-1",
      mappedDealId: "suggested-deal-1",
      mappingStatus: "SUGGESTED",
    });
    updateMappingMock.mockResolvedValue({});

    const res = await PATCH(
      makeRequest({ mappingStatus: "MAPPED", mappedDealId: "other-deal-9" }),
      makeParams()
    );

    expect(res.status).toBe(200);
    expect(updateMappingMock).toHaveBeenCalledWith("row-1", {
      mappingStatus: "MAPPED",
      mappedDealId: "other-deal-9",
    });
  });
});

describe("DELETE /api/price-sheets/[id]/rows/[rowId] — 추출 행 삭제", () => {
  function makeDeleteRequest() {
    return new NextRequest("http://localhost/api/price-sheets/sheet-1/rows/row-1", {
      method: "DELETE",
    });
  }

  beforeEach(() => {
    findUniqueMock.mockReset();
    deleteMock.mockReset();
    requireAuthMock.mockReset();
    requireAuthMock.mockResolvedValue({ authenticated: true });
  });

  it("소속 시트가 일치하는 미반영 행은 삭제된다", async () => {
    findUniqueMock.mockResolvedValue({
      id: "row-1",
      priceSheetId: "sheet-1",
      mappingStatus: "NEW_DEAL",
    });
    deleteMock.mockResolvedValue({});

    const res = await DELETE(makeDeleteRequest(), makeParams());

    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: "row-1" } });
  });

  it("다른 시트 소속 행이면 404, 삭제하지 않는다", async () => {
    findUniqueMock.mockResolvedValue({
      id: "row-1",
      priceSheetId: "other-sheet",
      mappingStatus: "NEW_DEAL",
    });

    const res = await DELETE(makeDeleteRequest(), makeParams());

    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("이미 딜에 반영된 행(APPLIED)은 409로 보호된다", async () => {
    findUniqueMock.mockResolvedValue({
      id: "row-1",
      priceSheetId: "sheet-1",
      mappingStatus: "APPLIED",
    });

    const res = await DELETE(makeDeleteRequest(), makeParams());

    expect(res.status).toBe(409);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
