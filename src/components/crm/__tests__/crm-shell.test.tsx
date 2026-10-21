// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { CrmShell } from "../crm-shell";

describe("CrmShell", () => {
  it("머리(header·h1)를 그리지 않고 본문만 스크롤러 안에 둔다", () => {
    const { container } = render(
      <CrmShell variant="focus">
        <div>본문</div>
      </CrmShell>,
    );
    expect(container.querySelector("header")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scroller).not.toBeNull();
    expect(scroller).toHaveTextContent("본문");
  });

  it("스크롤러는 스크롤바 자리를 예약하고 머리 높이 padding 이 없다", () => {
    const { container } = render(
      <CrmShell>
        <div>본문</div>
      </CrmShell>,
    );
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scroller.className).toContain("[scrollbar-gutter:stable]");
    expect(scroller.style.paddingTop).toBe("");
  });

  it("루트 바탕은 토큰이다(하드코딩 색 리터럴 없음)", () => {
    const { container } = render(
      <CrmShell>
        <div>본문</div>
      </CrmShell>,
    );
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain("bg-background");
    expect(cls).not.toContain("#");
  });
});
