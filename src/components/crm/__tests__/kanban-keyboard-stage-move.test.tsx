// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CampaignCard } from "../campaign-card";
import { ExecutionKanbanBoard } from "../execution-kanban-board";
import type { CampaignRow } from "@/lib/crm-types";

// interfaces 점검 묶음 G1(2026-09-24): 판매 관리 칸반은 드래그(포인터)로만 단계를 옮길 수 있었다.
// 카드 메뉴 「단계 이동」이 키보드 경로다 — 이 파일은 그 경로가 키보드만으로 끝까지 가는지,
// 그리고 카드·메뉴의 키 이벤트가 서로를 덮지 않는지를 고정한다.

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    dealName: "글로우 앰플",
    partnerName: "거래처",
    sellerName: "셀러",
    snsType: "INSTAGRAM",
    snsHandle: "@seller",
    startDate: "2026-01-01",
    endDate: "2099-12-31",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: null,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "ACTIVE",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-01-01T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    ...overrides,
  } as CampaignRow;
}

const TARGETS = [
  { status: "PREPARATION", label: "판매 대기" },
  { status: "ACTIVE", label: "판매 진행" },
  { status: "CLOSED", label: "판매 마감" },
] as const;

async function openStageSubmenu(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  trigger.focus();
  await user.keyboard("{Enter}");
  const stageItem = await screen.findByRole("menuitem", { name: "단계 이동" });
  stageItem.focus();
  await user.keyboard("{ArrowRight}");
  return screen.findByRole("menu", { name: "단계 이동" });
}

describe("CampaignCard — 단계 이동 메뉴(키보드 경로)", () => {
  it("현재 단계를 뺀 목적지만 보이고, 고르면 onMove 만 부른다(상세 열기는 안 부른다)", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    const onOpen = vi.fn();
    render(
      <CampaignCard
        campaign={makeCampaign({ status: "ACTIVE" })}
        onOpen={onOpen}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        moveTargets={TARGETS}
        onMove={onMove}
      />,
    );

    const sub = await openStageSubmenu(user, screen.getByRole("button", { name: "캠페인 메뉴" }));
    const labels = within(sub).getAllByRole("menuitem").map((el) => el.textContent);
    expect(labels).toEqual(["판매 대기", "판매 마감"]);

    await user.keyboard("{ArrowDown}");
    const closedItem = within(sub).getByRole("menuitem", { name: "판매 마감" });
    closedItem.focus();
    await user.keyboard("{Enter}");

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][1]).toBe("CLOSED");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("onMove 가 없으면(다른 보드) 단계 이동 항목을 그리지 않는다", async () => {
    const user = userEvent.setup();
    render(
      <CampaignCard campaign={makeCampaign()} onOpen={vi.fn()} onDelete={vi.fn()} onDuplicate={vi.fn()} />,
    );
    screen.getByRole("button", { name: "캠페인 메뉴" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menuitem", { name: "복제" });
    expect(screen.queryByRole("menuitem", { name: "단계 이동" })).toBeNull();
  });

  it("메뉴 버튼에서 누른 Enter 는 카드 상세를 열지 않는다 — 카드 자신에서만 연다", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { container } = render(
      <CampaignCard campaign={makeCampaign()} onOpen={onOpen} onDelete={vi.fn()} onDuplicate={vi.fn()} />,
    );

    screen.getByRole("button", { name: "캠페인 메뉴" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menuitem", { name: "복제" });
    expect(onOpen).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");

    const card = container.querySelector<HTMLElement>("[data-campaign-card-id='camp-1']")!;
    card.focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("메뉴 항목을 마우스로 눌러도 카드 클릭(상세 열기)으로 새지 않는다", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDuplicate = vi.fn();
    render(
      <CampaignCard campaign={makeCampaign()} onOpen={onOpen} onDelete={vi.fn()} onDuplicate={onDuplicate} />,
    );
    await user.click(screen.getByRole("button", { name: "캠페인 메뉴" }));
    await user.click(await screen.findByRole("menuitem", { name: "복제" }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("hover 전용 메뉴 버튼이 키보드 포커스·열림 중에도 보인다", () => {
    render(
      <CampaignCard campaign={makeCampaign()} onOpen={vi.fn()} onDelete={vi.fn()} onDuplicate={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: "캠페인 메뉴" });
    expect(trigger.className).toContain("focus-visible:opacity-100");
    expect(trigger.className).toContain("data-[state=open]:opacity-100");
  });

  it("드래그 배선이 붙어도 영어 역할 설명(draggable)을 읽히지 않는다", () => {
    const { container } = render(
      <CampaignCard
        campaign={makeCampaign()}
        onOpen={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
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
    const card = container.querySelector("[data-campaign-card-id='camp-1']")!;
    expect(card.getAttribute("aria-roledescription")).toBeNull();
    expect(card.getAttribute("role")).toBe("button");
  });
});

describe("ExecutionKanbanBoard — 메뉴로 단계 이동", () => {
  function renderBoard(onStatusChange = vi.fn().mockResolvedValue(undefined)) {
    render(
      <ExecutionKanbanBoard
        campaigns={[
          makeCampaign({ id: "camp-prep", dealName: "대기 딜", status: "PREPARATION", startDate: "2026-01-01" }),
          makeCampaign({ id: "camp-live", dealName: "진행 딜", status: "ACTIVE" }),
        ]}
        onRowOpen={vi.fn()}
        onRowDelete={vi.fn()}
        onRowDuplicate={vi.fn()}
        onStatusChange={onStatusChange}
      />,
    );
    return onStatusChange;
  }

  function menuTriggerOf(dealName: string): HTMLElement {
    const card = screen.getByText(dealName).closest<HTMLElement>("[data-campaign-card-id]")!;
    return within(card).getByRole("button", { name: "캠페인 메뉴" });
  }

  it("목적지는 지금 드래그로 닿는 컬럼(보이는 · 드롭 허용)과 같다", async () => {
    const user = userEvent.setup();
    renderBoard();
    const sub = await openStageSubmenu(user, menuTriggerOf("진행 딜"));
    expect(within(sub).getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "판매 대기",
      "판매 마감",
      "정산 대기",
    ]);
  });

  it("고르면 드래그와 같은 onStatusChange 를 부르고, 카드가 새 컬럼으로 옮겨가며 포커스가 따라간다", async () => {
    const user = userEvent.setup();
    const onStatusChange = renderBoard();
    const sub = await openStageSubmenu(user, menuTriggerOf("진행 딜"));
    const target = within(sub).getByRole("menuitem", { name: "판매 마감" });
    target.focus();
    await user.keyboard("{Enter}");

    expect(onStatusChange).toHaveBeenCalledWith("camp-live", "CLOSED");
    await waitFor(() => {
      expect((document.activeElement as HTMLElement | null)?.dataset.campaignCardId).toBe("camp-live");
    });
    const closedColumn = screen.getByRole("heading", { name: "판매 마감" }).closest("div.crm-horizontal-accent")!;
    expect(within(closedColumn as HTMLElement).getByText("진행 딜")).toBeTruthy();
  });

  it("실패하면 자리로 되돌리고 서버 문구를 알린다(드래그와 같은 경로)", async () => {
    const user = userEvent.setup();
    const onStatusChange = renderBoard(vi.fn().mockRejectedValue(new Error("그룹 충돌")));
    const sub = await openStageSubmenu(user, menuTriggerOf("진행 딜"));
    const target = within(sub).getByRole("menuitem", { name: "판매 마감" });
    target.focus();
    await user.keyboard("{Enter}");

    expect(onStatusChange).toHaveBeenCalledWith("camp-live", "CLOSED");
    await waitFor(() => {
      const liveColumn = screen.getByRole("heading", { name: "판매 진행" }).closest("div.crm-horizontal-accent")!;
      expect(within(liveColumn as HTMLElement).getByText("진행 딜")).toBeTruthy();
    });
  });
});
