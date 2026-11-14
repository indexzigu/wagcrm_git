// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/lib/toast";
import { Toaster } from "../sonner";
import { Sheet, SheetContent, SheetTitle } from "../sheet";
import { Drawer, DrawerContent, DrawerTitle } from "../drawer";

/**
 * 오류 토스트는 닫을 때까지 남는다(`@/lib/toast`) — 그러니 닫는 수단이 반드시 보여야 하고,
 * 알림 영역·닫기 버튼의 접근 이름은 한국어여야 한다(sonner 기본값은 영어).
 */
afterEach(() => {
  act(() => {
    toast.dismiss();
  });
});

describe("Toaster", () => {
  it("오류 토스트에 한국어 이름의 닫기 버튼을 단다", async () => {
    render(<Toaster />);
    act(() => {
      toast.error("저장하지 못했습니다.");
    });

    expect(await screen.findByText("저장하지 못했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "알림 닫기" })).toBeInTheDocument();
  });

  it("알림 영역의 접근 이름이 한국어다", () => {
    const { container } = render(<Toaster />);
    const region = container.querySelector("section[aria-live]");
    expect(region?.getAttribute("aria-label")).toMatch(/^알림 /);
  });

  it("오류 아이콘은 X 모양이 아니다 — 닫기 버튼(×)과 겹쳐 「x 두 개」로 읽히지 않게", async () => {
    const { container } = render(<Toaster />);
    act(() => {
      toast.error("저장하지 못했습니다.");
    });
    await screen.findByText("저장하지 못했습니다.");
    const icon = container.querySelector("[data-icon] svg");
    expect(icon?.getAttribute("class")).toContain("lucide-octagon-alert");
    expect(icon?.getAttribute("class")).not.toMatch(/-x\b/);
  });

  it("시트가 열려 있어도 닫기 버튼이 눌리고, 알림을 닫아도 시트는 닫히지 않는다", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <>
        <Toaster />
        <Sheet open onOpenChange={onOpenChange}>
          <SheetContent aria-describedby={undefined}>
            <SheetTitle>옵션 등록</SheetTitle>
          </SheetContent>
        </Sheet>
      </>,
    );
    // Radix 모달이 body 에 pointer-events:none 을 건 상태 — 이 결함의 전제 조건.
    await waitFor(() => expect(document.body.style.pointerEvents).toBe("none"));
    act(() => {
      toast.error("옵션 상품 추가에 실패했습니다.");
    });
    await screen.findByText("옵션 상품 추가에 실패했습니다.");

    // user-event 는 pointer-events:none 인 요소를 누르면 예외를 던진다 — 수정 전엔 여기서 실패했다.
    await user.click(screen.getByRole("button", { name: "알림 닫기" }));

    await waitFor(() => expect(screen.queryByText("옵션 상품 추가에 실패했습니다.")).not.toBeInTheDocument());
    // 알림 클릭을 「바깥 클릭」으로 읽으면 시트가 닫히며 입력 중인 폼이 사라진다.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("드로어(모바일 변형)가 열려 있어도 알림을 닫을 수 있고, 드로어는 닫히지 않는다", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <>
        <Toaster />
        <Drawer open onOpenChange={onOpenChange}>
          <DrawerContent aria-describedby={undefined}>
            <DrawerTitle>옵션 등록</DrawerTitle>
          </DrawerContent>
        </Drawer>
      </>,
    );
    await waitFor(() => expect(document.body.style.pointerEvents).toBe("none"));
    act(() => {
      toast.error("옵션 상품 추가에 실패했습니다.");
    });
    await screen.findByText("옵션 상품 추가에 실패했습니다.");

    await user.click(screen.getByRole("button", { name: "알림 닫기" }));

    await waitFor(() => expect(screen.queryByText("옵션 상품 추가에 실패했습니다.")).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
