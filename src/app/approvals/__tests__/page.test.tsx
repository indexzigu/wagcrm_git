// @vitest-environment jsdom
/**
 * 결재함 페이지의 **배선** 계약.
 *
 * 가격표 업로드 입구는 `/assets/price-sheets` 하나다(애플 UI 개편 묶음 1, Task A4) —
 * 결재함에는 더 이상 업로드 카드가 없고, 허브만 ambient 컨테이너 안에 선다.
 * 허브는 mock 으로 세우고 내용은 각자의 테스트가 본다.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/crm/approvals/approval-hub", () => ({
  ApprovalHub: () => <div data-testid="approval-hub" />,
}));
vi.mock("@/components/crm/approvals/hub-states", () => ({
  HubSkeleton: () => <div data-testid="hub-skeleton" />,
}));

import ApprovalsPage from "../page";

describe("결재함 페이지", () => {
  it("허브는 ambient 컨테이너 안에 있다", () => {
    const { container } = render(<ApprovalsPage />);

    const ambient = container.querySelector(".shadow-ambient");
    expect(ambient, "ambient 컨테이너를 못 찾았다 — 클래스가 바뀌었다면 이 계약도 함께 고칠 것").not.toBeNull();
    expect(ambient!.contains(screen.getByTestId("approval-hub"))).toBe(true);
  });

  it("가격표 업로드 카드는 없다 — 입구는 /assets/price-sheets 하나", () => {
    render(<ApprovalsPage />);
    expect(screen.queryByTestId("price-sheet-ingest-card")).toBeNull();
  });
});
