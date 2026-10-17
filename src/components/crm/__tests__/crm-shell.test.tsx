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
});
