// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShippingDialogFrame } from "../shipping/modals/ShippingDialogFrame";
import CampaignEditModal from "../shipping/modals/CampaignEditModal";
import CampaignInsightsModal from "../shipping/modals/CampaignInsightsModal";
import SalesReportModal from "../shipping/modals/SalesReportModal";
import EmailSendModal from "../shipping/modals/EmailSendModal";
import DelayDispatchModal from "../shipping/modals/DelayDispatchModal";

// interfaces 점검 묶음 G1(2026-09-24): 주문 관리 모달 5개는 createPortal 로 직접 그린 div 라
// 대화상자 역할·Esc 닫기·포커스 가두기·닫은 뒤 복귀가 없었다. 이 파일은 5개 모두가 이제
// 이름 있는 모달 대화상자로 열리고 Esc 로 닫히는지, 진행 중에는 닫히지 않는지를 고정한다.
// ⚠️ 발주 메일 발송·발송지연 등록은 외부 부수효과가 있는 흐름이다 — 여기서는 열기·닫기만 본다.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/undispatched-orders")
      ? { rows: [] }
      : url.includes("/brands")
        ? { brands: [] }
        : url.includes("/recommended-deals")
          ? { recommendations: {} }
          : {};
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const campaign = {
  id: "order-1",
  name: "테스트 주문 캠페인",
  template: "brand",
  sellerName: "테스트 셀러",
  toEmail: "ops@example.com",
  ccEmail: "",
  tasks: [],
  mappings: [],
  salesCampaigns: [],
  dailyStats: [],
  insights: null,
} as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- 모달별 필드가 달라 최소 픽스처

const cases: Array<{ title: string; render: (onClose: () => void) => React.ReactElement }> = [
  {
    title: "캠페인 설정",
    render: (onClose) => (
      <CampaignEditModal campaign={campaign} onClose={onClose} onSubmit={vi.fn()} onDelete={vi.fn()} />
    ),
  },
  { title: "캠페인 인사이트", render: (onClose) => <CampaignInsightsModal campaign={campaign} onClose={onClose} /> },
  {
    title: "매출 보고",
    render: (onClose) => <SalesReportModal campaign={campaign} onClose={onClose} onToast={vi.fn()} />,
  },
  {
    title: "발주서 첨부 발송",
    render: (onClose) => (
      <EmailSendModal campaignId="order-1" onClose={onClose} onSuccess={vi.fn()} addToast={vi.fn()} />
    ),
  },
  {
    title: "발송지연 안내",
    render: (onClose) => (
      <DelayDispatchModal
        campaign={{ id: "order-1", name: "테스트 주문 캠페인" }}
        onClose={onClose}
        addToast={vi.fn()}
        onLog={vi.fn()}
        refreshNow={vi.fn()}
        isBusy={false}
        setBusy={vi.fn()}
      />
    ),
  },
];

describe("주문 관리 모달 — 대화상자 계약", () => {
  it.each(cases)("$title: 이름 있는 모달 대화상자로 열리고 Esc 로 닫힌다", async ({ title, render: renderModal }) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(renderModal(onClose));

    const dialog = await screen.findByRole("dialog", { name: new RegExp(title) });
    // Radix 는 모달 밖을 aria-hidden 으로 가리는 방식이라 aria-modal 대신 역할·이름·포커스로 본다.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(screen.getAllByRole("button", { name: "닫기" }).length).toBeGreaterThan(0);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ShippingDialogFrame — 진행 중 가드와 포커스 복귀", () => {
  function Harness({ canClose = true }: { canClose?: boolean }) {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          열기
        </button>
        {open ? (
          <ShippingDialogFrame onClose={() => setOpen(false)} canClose={canClose}>
            <DialogTitle>틀 제목</DialogTitle>
            <button type="button" onClick={() => setOpen(false)}>
              안쪽 닫기
            </button>
          </ShippingDialogFrame>
        ) : null}
      </>
    );
  }

  it("닫으면 포커스가 연 버튼으로 돌아간다", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "열기" });
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("메뉴 항목에서 열었으면 메뉴를 연 버튼으로 돌아간다(항목은 메뉴와 함께 사라진다)", async () => {
    const user = userEvent.setup();
    function MenuHarness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger>캠페인 메뉴</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setOpen(true)}>인사이트</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {open ? (
            <ShippingDialogFrame onClose={() => setOpen(false)}>
              <DialogTitle>틀 제목</DialogTitle>
              <button type="button">안쪽</button>
            </ShippingDialogFrame>
          ) : null}
        </>
      );
    }
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "캠페인 메뉴" });
    trigger.focus();
    await user.keyboard("{Enter}");
    (await screen.findByRole("menuitem", { name: "인사이트" })).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("진행 중(canClose=false)이면 Esc 로 닫히지 않는다 — 발송·등록 결과를 못 보고 창이 사라지는 것을 막는다", async () => {
    const user = userEvent.setup();
    render(<Harness canClose={false} />);
    await user.click(screen.getByRole("button", { name: "열기" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
