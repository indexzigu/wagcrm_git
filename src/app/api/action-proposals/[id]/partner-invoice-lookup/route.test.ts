/**
 * GET /api/action-proposals/[id]/partner-invoice-lookup — 거래처 등록 기안의 계산서 찾기.
 * 메일함·DB 는 가짜로 둔다. 값은 전부 가짜다(P0).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ETAX_PARTY_DETAIL, type ParsedEtaxInvoice } from "@/lib/tax-invoice-mail/etax-xml";

const requireRoleMock = vi.fn();
const findByIdMock = vi.fn();
const scanMock = vi.fn();
const partnerFindManyMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));
vi.mock("@/repositories/actionProposalRepository", () => ({
  ActionProposalRepository: { findById: (...args: unknown[]) => findByIdMock(...args) },
}));
vi.mock("@/lib/tax-invoice-mail/mail-scan", () => ({
  scanTaxInvoiceMails: (...args: unknown[]) => scanMock(...args),
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ partner: { findMany: (...args: unknown[]) => partnerFindManyMock(...args) } }),
}));
vi.mock("@/lib/tax-invoice-builder", () => ({ SUPPLIER: { businessNumber: "9998887777" } }));

const { GET } = await import("./route");

const VENDOR = "1112233333";

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    status: "PENDING_APPROVAL",
    payload: { action: "create_partner", args: { partner: { name: "테스트공급", type: "VENDOR" } } },
    ...overrides,
  };
}

function invoice(): ParsedEtaxInvoice {
  return {
    issueId: "A1",
    typeCode: "0101",
    purposeCode: null,
    writtenDate: "2026-09-30",
    invoicerBusinessNumber: VENDOR,
    invoicerName: "(주)테스트공급",
    invoiceeBusinessNumber: "9998887777",
    invoiceeName: "우리",
    invoicerDetail: { ...EMPTY_ETAX_PARTY_DETAIL, ceoName: "공급대표", address: "서울 가상로 1" },
    invoiceeDetail: EMPTY_ETAX_PARTY_DETAIL,
    amounts: { supplyAmount: 1, taxAmount: 0, totalAmount: 1 },
    lineItems: [],
    declaredEncoding: "UTF-8",
  };
}

function call(id = "p1") {
  return GET(new Request(`http://localhost/api/action-proposals/${id}/partner-invoice-lookup`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET partner-invoice-lookup", () => {
  beforeEach(() => {
    requireRoleMock.mockReset().mockResolvedValue({ authenticated: true, context: { userId: "owner" } });
    findByIdMock.mockReset().mockResolvedValue(proposal());
    scanMock.mockReset().mockResolvedValue({
      mails: [{ receivedAt: "2026-10-01T00:00:00.000Z", parsed: invoice() }],
      truncated: 0,
    });
    partnerFindManyMock.mockReset().mockResolvedValue([]);
  });

  it("admin 이 아니면 거부한다", async () => {
    const denied = new Response(null, { status: 403 });
    requireRoleMock.mockResolvedValue({ authenticated: false, response: denied });
    expect((await call()).status).toBe(403);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it("상호로 찾은 계산서의 값과 채울 칸을 돌려준다", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lookup).toMatchObject({ status: "FOUND", matchedBy: "NAME" });
    expect(body.plan.fills).toEqual({ businessNumber: VENDOR, ceoName: "공급대표", address: "서울 가상로 1" });
    expect(body.existingPartner).toBeNull();
    expect(body.scan).toEqual({ sinceDays: 180, mailsRead: 1, truncated: 0 });
    expect(scanMock).toHaveBeenCalledWith(
      expect.objectContaining({ sinceDays: 180, invoicePassword: "9998887777" }),
    );
  });

  it("같은 사업자번호의 거래처가 이미 있으면 알려 준다(하이픈 표기도 같은 번호로 본다)", async () => {
    partnerFindManyMock.mockResolvedValue([{ id: "partner-9", name: "기존공급", businessNumber: "111-22-33333" }]);
    const body = await (await call()).json();
    expect(body.existingPartner).toEqual({ id: "partner-9", name: "기존공급" });
  });

  it("거래처 등록 기안이 아니면 400, 메일함을 열지 않는다", async () => {
    findByIdMock.mockResolvedValue(proposal({ payload: { action: "add_entity_memo", args: {} } }));
    expect((await call()).status).toBe(400);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it("이미 실행된 기안이면 409", async () => {
    findByIdMock.mockResolvedValue(proposal({ status: "EXECUTED" }));
    expect((await call()).status).toBe(409);
  });

  it("메일함 조회가 실패하면 「없음」이 아니라 502 로 알린다", async () => {
    scanMock.mockRejectedValue(new Error("IMAP 인증 실패"));
    const response = await call();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "IMAP 인증 실패" });
  });

  it("SQLite 레인처럼 payload 가 문자열로 저장돼 있어도 읽는다", async () => {
    findByIdMock.mockResolvedValue(proposal({ payload: JSON.stringify(proposal().payload) }));
    expect((await call()).status).toBe(200);
  });
});

describe("GET partner-invoice-lookup — 계약을 넘는 값", () => {
  it("거래처 칸 길이를 넘는 계산서 값은 채우지 않고 INVALID 로 알린다(승인 전체가 막히지 않게)", async () => {
    requireRoleMock.mockResolvedValue({ authenticated: true, context: { userId: "owner" } });
    findByIdMock.mockResolvedValue(proposal());
    partnerFindManyMock.mockResolvedValue([]);
    const long = invoice();
    long.invoicerDetail = { ...long.invoicerDetail, address: "가".repeat(301) };
    scanMock.mockResolvedValue({ mails: [{ receivedAt: "2026-10-01T00:00:00.000Z", parsed: long }], truncated: 0 });

    const body = await (await call()).json();
    expect(body.plan.fills).not.toHaveProperty("address");
    expect(body.plan.rows).toContainEqual(expect.objectContaining({ field: "address", outcome: "INVALID" }));
  });
});
