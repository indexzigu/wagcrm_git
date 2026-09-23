// @vitest-environment jsdom
/**
 * 결재함 페이지의 **배선** 계약 (Plan 3 Task A2 후속).
 *
 * 채팅 은퇴로 가격표 인제스트의 입구가 이 카드 하나뿐이 됐는데, 그 마운트를 지키는 것이
 * 아무것도 없었다 — 페이지에서 한 줄을 지우면 기능이 통째로 사라지지만 타입도 테스트도
 * 조용하다(카드 자체의 테스트는 카드를 직접 렌더하므로 페이지에서 빠져도 초록이다).
 *
 * 그래서 여기서는 **무엇이 렌더되는가와 그 순서**만 본다 — 카드와 허브는 mock 으로 세우고
 * 각자의 내용은 각자의 테스트가 본다.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/crm/approvals/price-sheet-ingest-card", () => ({
  PriceSheetIngestCard: () => <div data-testid="price-sheet-ingest-card" />,
}));
vi.mock("@/components/crm/approvals/approval-hub", () => ({
  ApprovalHub: () => <div data-testid="approval-hub" />,
}));
vi.mock("@/components/crm/approvals/hub-states", () => ({
  HubSkeleton: () => <div data-testid="hub-skeleton" />,
}));

import ApprovalsPage from "../page";

describe("결재함 페이지", () => {
  it("가격표 업로드 카드를 허브 **위에** 단다", () => {
    render(<ApprovalsPage />);

    const card = screen.getByTestId("price-sheet-ingest-card");
    const hub = screen.getByTestId("approval-hub");

    expect(card).toBeInTheDocument();
    expect(hub).toBeInTheDocument();
    // Node.compareDocumentPosition: 카드가 허브보다 문서상 앞서면 FOLLOWING 비트가 선다.
    expect(card.compareDocumentPosition(hub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("카드는 ambient 컨테이너 밖에 있다 — 탭 내용이 아니라 나란한 입구다", () => {
    const { container } = render(<ApprovalsPage />);

    const ambient = container.querySelector(".shadow-ambient");
    expect(ambient, "ambient 컨테이너를 못 찾았다 — 클래스가 바뀌었다면 이 계약도 함께 고칠 것").not.toBeNull();
    expect(ambient!.contains(screen.getByTestId("price-sheet-ingest-card"))).toBe(false);
    expect(ambient!.contains(screen.getByTestId("approval-hub"))).toBe(true);
  });
});
