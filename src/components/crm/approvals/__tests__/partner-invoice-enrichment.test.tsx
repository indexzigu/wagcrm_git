// @vitest-environment jsdom
/**
 * 계산서에서 채우기 — 결재함 「거래처 등록」 카드(오너 지시 2026-10-15).
 * 값은 전부 가짜다(P0). API 는 fetch 스텁으로 대신한다.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { PartnerInvoiceEnrichment, type PartnerInvoiceLookupResponse } from "../partner-invoice-enrichment";
import { PendingCard, type ApprovalInboxItem } from "../approval-cards";

const FOUND: PartnerInvoiceLookupResponse = {
  lookup: {
    status: "FOUND",
    matchedBy: "BUSINESS_NUMBER",
    counterpart: { businessNumber: "1112233333", name: "(주)테스트공급" },
    values: { businessNumber: "1112233333", ceoName: "계산서대표", address: "서울 가상로 1" },
    invoiceCount: 2,
    latestWrittenDate: "2026-09-30",
  },
  plan: {
    rows: [
      { field: "businessNumber", invoiceValue: "1112233333", proposedValue: null, outcome: "FILL" },
      { field: "ceoName", invoiceValue: "계산서대표", proposedValue: "대화대표", outcome: "KEEP" },
      { field: "address", invoiceValue: "서울 가상로 1", proposedValue: null, outcome: "FILL" },
    ],
    fills: { businessNumber: "1112233333", address: "서울 가상로 1" },
  },
  existingPartner: null,
  scan: { sinceDays: 180, mailsRead: 12, truncated: 0 },
};

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PartnerInvoiceEnrichment", () => {
  it("누르기 전에는 메일함을 읽지 않는다", () => {
    render(<PartnerInvoiceEnrichment proposalId="p1" onSelectedChange={() => {}} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "계산서에서 찾기" })).toBeTruthy();
  });

  it("사업자번호로 맞추면 찾은 값을 보여 주고 빈 칸 채울 값을 기본으로 카드에 알린다", async () => {
    fetchMock.mockReturnValue(respond(FOUND));
    const onSelectedChange = vi.fn();
    render(<PartnerInvoiceEnrichment proposalId="p1" onSelectedChange={onSelectedChange} />);

    fireEvent.click(screen.getByRole("button", { name: "계산서에서 찾기" }));

    expect(await screen.findByText("서울 가상로 1", {}, { timeout: 3000 })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals/p1/partner-invoice-lookup");
    // 기안 값을 유지하는 칸은 저장될 값(기안 값)이 본문, 계산서 값이 보조다.
    expect(screen.getByText("기안 값 유지")).toBeTruthy();
    expect(screen.getByText("대화대표")).toBeTruthy();
    expect(screen.getByText("계산서: 계산서대표")).toBeTruthy();
    expect(onSelectedChange).toHaveBeenLastCalledWith(FOUND.plan?.fills);

    // 저장하지 않기로 하면 카드에 undefined 를 알린다.
    fireEvent.click(screen.getByRole("checkbox", { name: /「채움」 2칸도 함께 저장/ }));
    await waitFor(() => expect(onSelectedChange).toHaveBeenLastCalledWith(undefined));
  });

  it("상호로만 맞췄으면 경고하고 「함께 저장」을 꺼 둔다", async () => {
    fetchMock.mockReturnValue(respond({ ...FOUND, lookup: { ...FOUND.lookup, matchedBy: "NAME" } }));
    const onSelectedChange = vi.fn();
    render(<PartnerInvoiceEnrichment proposalId="p1" onSelectedChange={onSelectedChange} />);
    fireEvent.click(screen.getByRole("button", { name: "계산서에서 찾기" }));

    expect(await screen.findByText(/상호만 같은 계산서 2장입니다/, {}, { timeout: 3000 })).toBeTruthy();
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(onSelectedChange).not.toHaveBeenCalledWith(FOUND.plan?.fills);
  });

  it("같은 사업자번호의 거래처가 있으면 중복 경고를 맨 위에 띄우고 「함께 저장」을 꺼 둔다", async () => {
    fetchMock.mockReturnValue(respond({ ...FOUND, existingPartner: { id: "x", name: "기존공급" } }));
    render(<PartnerInvoiceEnrichment proposalId="p1" onSelectedChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "계산서에서 찾기" }));
    const alert = await screen.findByText(/같은 사업자번호의 거래처가 이미 있습니다: 기존공급/, {}, { timeout: 3000 });
    expect(alert.getAttribute("role")).toBe("alert");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("못 찾으면 그렇게 말하고, 실패하면 오류와 함께 그대로 승인할 수 있다고 알린다", async () => {
    fetchMock.mockReturnValueOnce(
      respond({ lookup: { status: "NOT_FOUND" }, plan: null, existingPartner: null, scan: { sinceDays: 180, mailsRead: 3, truncated: 5 } }),
    );
    render(<PartnerInvoiceEnrichment proposalId="p1" onSelectedChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "계산서에서 찾기" }));
    expect(
      await screen.findByText(/최근 180일 메일함에 이 거래처와 주고받은 계산서가 없습니다/, {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.getByText(/5통은 읽지 못했습니다/)).toBeTruthy();

    fetchMock.mockReturnValueOnce(respond({ error: "IMAP 인증 실패" }, 502));
    fireEvent.click(screen.getByRole("button", { name: "다시 찾기" }));
    expect(
      (await screen.findByText(/IMAP 인증 실패 이 기안은 그대로 승인할 수 있습니다/, {}, { timeout: 3000 })).getAttribute("role"),
    ).toBe("alert");
  });

  it("상호가 같은 사업자가 여럿이면 후보를 줄마다 보여 주고 채우지 않는다", async () => {
    fetchMock.mockReturnValue(
      respond({
        lookup: {
          status: "AMBIGUOUS",
          candidates: [
            { businessNumber: "1112233333", name: "테스트공급" },
            { businessNumber: "4445566666", name: "테스트공급" },
          ],
        },
        plan: null,
        existingPartner: null,
        scan: { sinceDays: 180, mailsRead: 3, truncated: 0 },
      }),
    );
    render(<PartnerInvoiceEnrichment proposalId="p1" onSelectedChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "계산서에서 찾기" }));
    expect(await screen.findByText(/여러 곳이라 채우지 않았습니다/, {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("PendingCard — 거래처 등록 기안", () => {
  const item: ApprovalInboxItem = {
    id: "p1",
    title: "거래처 등록",
    status: "PENDING_APPROVAL",
    kind: "WRITE",
    targetEntityType: null,
    targetEntityId: null,
    targetEntityName: null,
    payload: { action: "create_partner", args: { partner: { name: "테스트공급", type: "VENDOR", ceoName: "대화대표" } } },
    createdBy: "AGENT",
    createdAt: "2026-10-15T00:00:00.000Z",
  };

  it("계산서에서 찾은 빈 칸 값을 승인 요청에 싣는다", async () => {
    fetchMock.mockReturnValue(respond(FOUND));
    const onApprove = vi.fn().mockResolvedValue({});
    render(<PendingCard item={item} onApprove={onApprove} onReject={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "계산서에서 찾기" }));
    await screen.findByText("서울 가상로 1", {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    await waitFor(
      () => expect(onApprove).toHaveBeenCalledWith("p1", { partnerEnrichment: FOUND.plan?.fills }),
      { timeout: 3000 },
    );
  });

  it("찾지 않고 승인하면 종전처럼 id 만 넘긴다", async () => {
    const onApprove = vi.fn().mockResolvedValue({});
    render(<PendingCard item={item} onApprove={onApprove} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "승인" }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith("p1"));
  });

  it("계산서 값을 저장하기로 한 카드는 일괄 선택에서 빠진다(일괄 승인은 그 값을 싣지 않는다)", async () => {
    fetchMock.mockReturnValue(respond(FOUND));
    const onCheckedChange = vi.fn();
    render(
      <PendingCard
        item={item}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        selection={{ checked: true, onCheckedChange }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "계산서에서 찾기" }));
    await screen.findByText("서울 가상로 1", {}, { timeout: 3000 });

    await waitFor(() => expect(onCheckedChange).toHaveBeenCalledWith(false));
    expect((screen.getByRole("checkbox", { name: "거래처 등록 선택" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/일괄 승인에는 실리지 않습니다/)).toBeTruthy();
  });

  it("거래처 등록이 아닌 기안에는 이 칸이 없다", () => {
    render(
      <PendingCard
        item={{ ...item, payload: { action: "add_entity_memo", args: { content: "메모" } } }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "계산서에서 채우기" })).toBeNull();
  });
});
