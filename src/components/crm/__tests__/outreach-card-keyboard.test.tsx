// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutreachCardContent, type OutreachRow } from "../outreach-list";

// interfaces 점검 묶음 G1(2026-09-24): 영업 칸반 카드는 클릭으로만 상세가 열렸고, 드래그 컬럼의
// 카드는 Enter 를 dnd 키보드 센서가 가져가(놓을 칸은 못 찾는다) 키보드로는 아무것도 못 했다.
// 키보드 경로 = 카드 Enter → 상세 시트의 영업 단계 버튼. 이 파일은 그 첫 걸음을 고정한다.

const outreach = {
  id: "task-1",
  dealId: "deal-1",
  dealName: "테스트 딜",
  brandName: null,
  partnerName: null,
  sellerId: "seller-1",
  sellerName: "테스트 셀러",
  sellerFollowers: null,
  sellerCategory: null,
  snsType: null,
  snsHandle: null,
  status: "NEGOTIATION",
  proposedAt: "2026-09-01T00:00:00Z",
  acceptedAt: null,
  totalMarginRate: 30,
  sellerMarginRate: 10,
  linkedCampaignId: null,
  linkedCampaignName: null,
  updatedAt: "2026-09-01T00:00:00Z",
} as OutreachRow;

const NOW = Date.parse("2026-09-10T00:00:00Z");

describe("OutreachCardContent — 키보드로 상세 열기", () => {
  it("드래그 컬럼 카드: Enter·Space 로 상세를 연다", async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    render(
      <OutreachCardContent
        outreach={outreach}
        now={NOW}
        onSelectTask={onSelectTask}
        dragListeners={{ onPointerDown: vi.fn() }}
        dragAttributes={{
          role: "button",
          tabIndex: 0,
          "aria-disabled": false,
          "aria-pressed": undefined,
          "aria-roledescription": "draggable",
          "aria-describedby": "dnd-desc",
        }}
      />,
    );
    const card = screen.getByRole("button");
    expect(card.getAttribute("aria-roledescription")).toBeNull();
    card.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelectTask).toHaveBeenCalledTimes(2);
  });

  it("드래그 없는 컬럼(전환완료·드랍) 카드도 탭으로 닿고 Enter 로 열린다", async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    render(<OutreachCardContent outreach={outreach} now={NOW} onSelectTask={onSelectTask} />);
    await user.tab();
    const card = screen.getByRole("button");
    expect(document.activeElement).toBe(card);
    await user.keyboard("{Enter}");
    expect(onSelectTask).toHaveBeenCalledWith(outreach);
  });

  it("열 곳이 없으면(onSelectTask 없음) 버튼인 척하지 않는다", () => {
    render(<OutreachCardContent outreach={outreach} now={NOW} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
