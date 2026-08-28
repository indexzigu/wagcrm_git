/**
 * M2 회귀 테스트: /apply 서버측 멱등 가드.
 * ① priceSheet.status === "APPLIED"면 즉시 409.
 * ② CAS(updateMany where status notIn [APPLIED, APPLYING])로 동시 요청을 방어한다.
 * ③ 반영된 행의 mappingStatus를 "APPLIED"로 전이해 재조회(MAPPED/NEW_DEAL) 대상에서 제외한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const findByIdMock = vi.fn();
const updateStatusMock = vi.fn();
const priceSheetUpdateManyMock = vi.fn();
const priceSheetUpdateMock = vi.fn();
const priceSheetRowFindManyMock = vi.fn();
const priceSheetRowUpdateManyMock = vi.fn();
const dealFindUniqueMock = vi.fn();
const applyPriceSheetMock = vi.fn();
const revalidateMasterDataCachesMock = vi.fn();
const requireAuthMock = vi.fn();
const getAuthContextMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: () => getAuthContextMock(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    priceSheet: {
      updateMany: priceSheetUpdateManyMock,
      update: priceSheetUpdateMock,
    },
    priceSheetRow: {
      findMany: priceSheetRowFindManyMock,
      updateMany: priceSheetRowUpdateManyMock,
    },
    deal: {
      findUnique: dealFindUniqueMock,
    },
  }),
}));

vi.mock("@/repositories/priceSheetRepository", () => ({
  PriceSheetRepository: {
    findById: findByIdMock,
    updateStatus: updateStatusMock,
  },
}));

vi.mock("@/lib/price-sheet/apply-executor", () => ({
  applyPriceSheet: (...args: unknown[]) => applyPriceSheetMock(...args),
  ApplyExecutorError: class ApplyExecutorError extends Error {},
}));

vi.mock("@/lib/price-sheet/serialize-response", () => ({
  normalizePriceSheetForResponse: (sheet: unknown) => sheet,
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateMasterDataCaches: () => revalidateMasterDataCachesMock(),
}));

const { POST } = await import("./route");

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest() {
  return new NextRequest("http://localhost/api/price-sheets/sheet-1/apply", { method: "POST" });
}

function makeRequestWithBody(body: unknown) {
  return new NextRequest("http://localhost/api/price-sheets/sheet-1/apply", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/price-sheets/[id]/apply — M2 멱등 가드", () => {
  beforeEach(() => {
    findByIdMock.mockReset();
    updateStatusMock.mockReset();
    priceSheetUpdateManyMock.mockReset();
    priceSheetUpdateMock.mockReset();
    priceSheetRowFindManyMock.mockReset();
    priceSheetRowUpdateManyMock.mockReset();
    dealFindUniqueMock.mockReset();
    applyPriceSheetMock.mockReset();
    revalidateMasterDataCachesMock.mockReset();
    requireAuthMock.mockReset();
    getAuthContextMock.mockReset();

    requireAuthMock.mockResolvedValue({ authenticated: true });
    getAuthContextMock.mockResolvedValue({ email: "tester@example.com" });
  });

  it("① priceSheet.status가 이미 APPLIED면 즉시 409를 반환하고 다른 어떤 쓰기도 하지 않는다", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "APPLIED", partnerId: null });

    const res = await POST(makeRequest(), makeParams("sheet-1"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("이미 반영된 가격표입니다");
    expect(priceSheetUpdateManyMock).not.toHaveBeenCalled();
    expect(applyPriceSheetMock).not.toHaveBeenCalled();
  });

  it("② CAS 선점 실패(count=0, 동시 요청 등)면 409를 반환한다", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    priceSheetUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest(), makeParams("sheet-1"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/이미 반영 중이거나 반영이 완료된/);
    expect(applyPriceSheetMock).not.toHaveBeenCalled();
    // CAS where 조건이 APPLIED/APPLYING을 모두 제외하는지 확인.
    const casArgs = priceSheetUpdateManyMock.mock.calls[0][0];
    expect(casArgs.where.status.notIn).toEqual(expect.arrayContaining(["APPLIED", "APPLYING"]));
    expect(casArgs.data.status).toBe("APPLYING");
  });

  it("③ 성공 시 반영된 행의 mappingStatus가 APPLIED로 전이되어 재조회 대상에서 제외된다", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    priceSheetUpdateManyMock.mockResolvedValue({ count: 1 });
    priceSheetRowFindManyMock.mockResolvedValue([
      { id: "row-1", mappingStatus: "MAPPED", mappedDealId: "deal-1" },
      { id: "row-2", mappingStatus: "NEW_DEAL", mappedDealId: null },
    ]);
    applyPriceSheetMock.mockResolvedValue({
      proposal: { id: "proposal-1", status: "EXECUTED" },
      results: [
        { dealId: "deal-1", action: "UPDATE" },
        { dealId: "deal-2", action: "CREATE" },
      ],
    });
    updateStatusMock.mockResolvedValue({ id: "sheet-1", status: "APPLIED" });

    const res = await POST(makeRequest(), makeParams("sheet-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(priceSheetRowUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["row-1", "row-2"] } },
      data: { mappingStatus: "APPLIED" },
    });
    expect(updateStatusMock).toHaveBeenCalledWith(
      "sheet-1",
      "APPLIED",
      expect.objectContaining({ reviewedBy: "tester@example.com" })
    );
    expect(body.priceSheet.status).toBe("APPLIED");
    // 딜 목록 캐시(crm:deals) 무효화 — 누락 시 "반영 완료"는 뜨는데 목록에 새 딜이 안 보인다.
    expect(revalidateMasterDataCachesMock).toHaveBeenCalledTimes(1);
  });

  it("실행 실패 시 CAS로 선점했던 APPLYING 상태를 원래 상태로 복원한다", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    priceSheetUpdateManyMock.mockResolvedValue({ count: 1 });
    priceSheetRowFindManyMock.mockResolvedValue([
      { id: "row-1", mappingStatus: "MAPPED", mappedDealId: "deal-1" },
    ]);
    applyPriceSheetMock.mockRejectedValue(new Error("실행 실패"));

    const res = await POST(makeRequest(), makeParams("sheet-1"));
    expect(res.status).toBe(502);
    expect(priceSheetUpdateMock).toHaveBeenCalledWith({
      where: { id: "sheet-1" },
      data: { status: "REVIEWED" },
    });
    // 실패 시엔 딜이 생성되지 않았으므로 캐시 무효화도 하지 않는다.
    expect(revalidateMasterDataCachesMock).not.toHaveBeenCalled();
  });

  it("반영할 확정 행이 없으면 409를 반환하고 APPLYING 선점을 원래 상태로 되돌린다", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    priceSheetUpdateManyMock.mockResolvedValue({ count: 1 });
    priceSheetRowFindManyMock.mockResolvedValue([]);

    const res = await POST(makeRequest(), makeParams("sheet-1"));
    expect(res.status).toBe(409);
    expect(priceSheetUpdateMock).toHaveBeenCalledWith({
      where: { id: "sheet-1" },
      data: { status: "REVIEWED" },
    });
  });
});

describe("POST apply — 묶음 정책", () => {
  beforeEach(() => {
    findByIdMock.mockReset();
    updateStatusMock.mockReset();
    priceSheetUpdateManyMock.mockReset();
    priceSheetUpdateMock.mockReset();
    priceSheetRowFindManyMock.mockReset();
    priceSheetRowUpdateManyMock.mockReset();
    dealFindUniqueMock.mockReset();
    applyPriceSheetMock.mockReset();
    revalidateMasterDataCachesMock.mockReset();
    requireAuthMock.mockReset();
    getAuthContextMock.mockReset();

    requireAuthMock.mockResolvedValue({ authenticated: true });
    getAuthContextMock.mockResolvedValue({ email: "tester@example.com" });
  });

  it("존재하지 않는 상위딜을 지정하면 400", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    dealFindUniqueMock.mockResolvedValue(null);

    const res = await POST(
      makeRequestWithBody({
        bundle: {
          mode: "BUNDLE",
          target: { kind: "EXISTING", dealId: "없는딜", parentDealName: "x", parentBrandName: null, parentPartnerId: null },
          excludedRowIds: [],
        },
      }),
      makeParams("sheet-1")
    );

    expect(res.status).toBe(400);
    expect(priceSheetUpdateManyMock).not.toHaveBeenCalled();
    expect(applyPriceSheetMock).not.toHaveBeenCalled();
  });

  it("하위품목딜을 상위딜로 지정하면 400 (2단 중첩 거부)", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    dealFindUniqueMock.mockResolvedValue({
      id: "자식딜",
      dealName: "자식딜명",
      brandName: null,
      partnerId: null,
      parentDealId: "someone",
    });

    const res = await POST(
      makeRequestWithBody({
        bundle: {
          mode: "BUNDLE",
          target: { kind: "EXISTING", dealId: "자식딜", parentDealName: "x", parentBrandName: null, parentPartnerId: null },
          excludedRowIds: [],
        },
      }),
      makeParams("sheet-1")
    );

    expect(res.status).toBe(400);
    expect(priceSheetUpdateManyMock).not.toHaveBeenCalled();
    expect(applyPriceSheetMock).not.toHaveBeenCalled();
  });

  it("유효한 상위딜을 지정하면 서버가 DB 값으로 재해석해 반영한다(클라이언트 값은 버려진다)", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    // DB의 실제 값 — 아래 요청 본문의 클라이언트 값과 일부러 전부 다르게 둔다(dealId 제외),
    // 그래야 "DB 값이 실제로 쓰였다"는 단언이 변별력을 가진다.
    dealFindUniqueMock.mockResolvedValue({
      id: "parent-db-id",
      dealName: "DB 상위딜명",
      brandName: "DB 브랜드",
      partnerId: "partner-db-id",
      parentDealId: null,
      dealType: "MAIN",
    });
    priceSheetUpdateManyMock.mockResolvedValue({ count: 1 });
    priceSheetRowFindManyMock.mockResolvedValue([
      { id: "row-1", mappingStatus: "NEW_DEAL", mappedDealId: null },
    ]);
    applyPriceSheetMock.mockResolvedValue({
      proposal: { id: "proposal-1", status: "EXECUTED" },
      results: [{ dealId: "deal-1", action: "CREATE" }],
    });
    updateStatusMock.mockResolvedValue({ id: "sheet-1", status: "APPLIED" });

    const res = await POST(
      makeRequestWithBody({
        bundle: {
          mode: "BUNDLE",
          target: {
            kind: "EXISTING",
            dealId: "parent-db-id",
            // 클라이언트가 보낸 표시용 값 — DB 값과 의도적으로 다르게 설정해 재해석 여부를 검증한다.
            parentDealName: "클라이언트가 보낸 이름",
            parentBrandName: "클라이언트가 보낸 브랜드",
            parentPartnerId: "client-sent-partner-id",
          },
          excludedRowIds: [],
        },
      }),
      makeParams("sheet-1")
    );

    expect(res.status).not.toBe(400);
    expect(dealFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "parent-db-id" },
      select: {
        id: true,
        dealName: true,
        brandName: true,
        partnerId: true,
        parentDealId: true,
        dealType: true,
      },
    });
    expect(applyPriceSheetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bundle: {
          mode: "BUNDLE",
          target: {
            kind: "EXISTING",
            dealId: "parent-db-id",
            parentDealName: "DB 상위딜명",
            parentBrandName: "DB 브랜드",
            parentPartnerId: "partner-db-id",
          },
          excludedRowIds: [],
        },
      })
    );
  });

  it("parentDealId는 null이지만 dealType이 OPTION인 딜을 상위딜로 지정하면 400", async () => {
    // 현재 코드로는 만들어지지 않는 조합(OPTION은 항상 parentDealId를 갖는다)이지만,
    // 가드가 parentDealId만 보면 조작된 요청으로 통과할 수 있다 — dealType까지 확인한다.
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    dealFindUniqueMock.mockResolvedValue({
      id: "위장옵션딜",
      dealName: "위장옵션딜명",
      brandName: null,
      partnerId: null,
      parentDealId: null,
      dealType: "OPTION",
    });

    const res = await POST(
      makeRequestWithBody({
        bundle: {
          mode: "BUNDLE",
          target: { kind: "EXISTING", dealId: "위장옵션딜", parentDealName: "x", parentBrandName: null, parentPartnerId: null },
          excludedRowIds: [],
        },
      }),
      makeParams("sheet-1")
    );

    expect(res.status).toBe(400);
    expect(priceSheetUpdateManyMock).not.toHaveBeenCalled();
    expect(applyPriceSheetMock).not.toHaveBeenCalled();
  });

  it("신규 상위딜명이 공백뿐이면 400", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });

    const res = await POST(
      makeRequestWithBody({
        bundle: {
          mode: "BUNDLE",
          target: { kind: "NEW", parentDealName: "   " },
          excludedRowIds: [],
        },
      }),
      makeParams("sheet-1")
    );

    expect(res.status).toBe(400);
    expect(dealFindUniqueMock).not.toHaveBeenCalled();
    expect(priceSheetUpdateManyMock).not.toHaveBeenCalled();
    expect(applyPriceSheetMock).not.toHaveBeenCalled();
  });

  it("본문에 bundle이 없으면 기존 동작(AUTO)으로 동작한다", async () => {
    findByIdMock.mockResolvedValue({ id: "sheet-1", status: "REVIEWED", partnerId: null });
    priceSheetUpdateManyMock.mockResolvedValue({ count: 1 });
    priceSheetRowFindManyMock.mockResolvedValue([
      { id: "row-1", mappingStatus: "NEW_DEAL", mappedDealId: null },
    ]);
    applyPriceSheetMock.mockResolvedValue({
      proposal: { id: "proposal-1", status: "EXECUTED" },
      results: [{ dealId: "deal-1", action: "CREATE" }],
    });
    updateStatusMock.mockResolvedValue({ id: "sheet-1", status: "APPLIED" });

    const res = await POST(makeRequestWithBody({}), makeParams("sheet-1"));

    expect(res.status).not.toBe(400);
    expect(dealFindUniqueMock).not.toHaveBeenCalled();
    expect(applyPriceSheetMock).toHaveBeenCalledWith(
      expect.objectContaining({ bundle: undefined })
    );
  });
});
