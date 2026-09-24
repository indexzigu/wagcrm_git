// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toast } from "@/lib/toast";
import { Toaster } from "../sonner";

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
});
