// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { CrmShell } from "../crm-shell";

const segments = (onValueChange: (v: string) => void) => ({
  options: [
    { value: "a", label: "첫째" },
    { value: "b", label: "둘째" },
  ],
  value: "a",
  onValueChange,
});

describe("CrmShell", () => {
  it("title 은 h1, description 은 그 아래에 렌더된다", () => {
    render(
      <CrmShell title="제목" description="설명">
        <div>본문</div>
      </CrmShell>,
    );
    const h1 = screen.getByRole("heading", { level: 1, name: "제목" });
    const desc = screen.getByText("설명");
    expect(h1.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("segments 를 주면 머리 안에 토글이 있고 선택 시 onValueChange 가 호출된다", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CrmShell title="제목" segments={segments(onChange)}>
        <div>본문</div>
      </CrmShell>,
    );
    const header = container.querySelector("header")!;
    expect(header.querySelector('[role="radiogroup"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "둘째" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("segments 가 없으면 토글을 렌더하지 않는다", () => {
    render(
      <CrmShell title="제목">
        <div>본문</div>
      </CrmShell>,
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("머리는 반투명 블러 + 투명도 줄이기 대응 클래스를 가진다", () => {
    const { container } = render(
      <CrmShell title="제목">
        <div>본문</div>
      </CrmShell>,
    );
    const cls = container.querySelector("header")!.className;
    expect(cls).toContain("backdrop-blur");
    expect(cls).toContain("crm-shell-header");
    expect(cls).toContain("bg-background/80");
    expect(cls).toContain("supports-[backdrop-filter]:bg-background/72");
  });

  it("루트에 하드코딩 색 리터럴이 없고 title/actions 가 없으면 머리가 없다", () => {
    const { container } = render(
      <CrmShell>
        <div>본문</div>
      </CrmShell>,
    );
    expect((container.firstChild as HTMLElement).className).not.toContain("#FAF9F6");
    expect(container.querySelector("header")).toBeNull();
  });

  it("머리가 있으면 스크롤러에 머리 높이 padding-top 이 있고, 없으면 없다", () => {
    const { container, rerender } = render(
      <CrmShell title="제목">
        <div>본문</div>
      </CrmShell>,
    );
    const header = container.querySelector("header")!;
    expect(header.className).toContain("absolute");
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scroller.style.paddingTop).not.toBe("");
    expect(scroller.style.scrollPaddingTop).not.toBe("");
    rerender(
      <CrmShell>
        <div>본문</div>
      </CrmShell>,
    );
    const bare = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(bare.style.paddingTop).toBe("");
  });

  it("segments 가 있으면 3열 격자로 가운데에 놓는다", () => {
    const { container } = render(
      <CrmShell title="제목" actions={<button>동작</button>} segments={segments(() => {})}>
        <div>본문</div>
      </CrmShell>,
    );
    expect(container.querySelector("header")!.className).toContain("grid-cols-[1fr_auto_1fr]");
  });
});
