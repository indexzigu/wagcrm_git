// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { keepModalOpenOnToast } from "../toast-region";

function outsideEvent(target: EventTarget | null) {
  return { target, preventDefault: vi.fn() };
}

describe("keepModalOpenOnToast", () => {
  it("알림 영역 안을 누르면 모달 닫힘을 막는다", () => {
    const toaster = document.createElement("ol");
    toaster.setAttribute("data-sonner-toaster", "");
    const button = document.createElement("button");
    toaster.appendChild(button);

    const event = outsideEvent(button);
    keepModalOpenOnToast()(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("알림이 아닌 진짜 바깥 클릭은 그대로 둔다(모달이 닫힌다)", () => {
    const event = outsideEvent(document.createElement("div"));
    keepModalOpenOnToast()(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("호출부가 넘긴 핸들러를 먼저 부른다", () => {
    const handler = vi.fn();
    const event = outsideEvent(document.createElement("div"));
    keepModalOpenOnToast(handler)(event);
    expect(handler).toHaveBeenCalledWith(event);
  });
});
