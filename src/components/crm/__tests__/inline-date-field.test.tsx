// @vitest-environment jsdom
/**
 * 즉시 저장 날짜 입력의 **커밋 시점** 계약 (2026-08-04 오너 보고 결함).
 *
 * 증상: 「대금 결제 일정」에서 `2026-07-20` 을 입력하면 `2026-07-02` 로 저장되고 두 번째
 * 자릿수를 칠 수 없었다. `<input type="date">` 가 세 세그먼트가 채워지는 **중간 상태마다**
 * `change` 를 쏘는데(일 세그먼트에 `2` 를 넣는 순간 이미 `2026-07-02`), 그 이벤트마다
 * 서버 저장 → `disabled` 토글 → 응답 재렌더가 돌아 입력 중인 세그먼트 상태가 날아갔다.
 * 달력 팝업에서 월만 옮겨도 저장이 튀던 것도 같은 뿌리다.
 *
 * 그래서 이 컴포넌트가 고정하는 불변식은 하나다 — **타이핑 중에는 커밋하지 않는다.**
 * 커밋은 blur·Enter 두 경로뿐이고, 값이 안 바뀌었으면 아예 부르지 않는다.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InlineDateField } from "../inline-date-field";

describe("InlineDateField", () => {
  it("⛔ 타이핑(change)만으로는 커밋하지 않는다 — 중간값 2026-07-02 가 저장되던 결함", () => {
    const onCommit = vi.fn();
    render(<InlineDateField value="" onCommit={onCommit} aria-label="지급 예정일" />);
    const input = screen.getByLabelText("지급 예정일") as HTMLInputElement;

    // 브라우저가 일 세그먼트의 두 번째 자릿수를 기다리는 동안 내보내는 중간 상태.
    fireEvent.change(input, { target: { value: "2026-07-02" } });
    expect(onCommit).not.toHaveBeenCalled();

    // 사용자가 `0` 을 마저 눌러 완성한 값.
    fireEvent.change(input, { target: { value: "2026-07-20" } });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("2026-07-20");
  });

  it("Enter 로도 확정된다 — 커밋 경로는 blur 하나뿐이라 중복 저장이 없다", () => {
    const onCommit = vi.fn();
    render(<InlineDateField value="2026-07-01" onCommit={onCommit} aria-label="입금 예정일" />);
    const input = screen.getByLabelText("입금 예정일") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "2026-07-20" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input); // jsdom 은 blur() 를 이벤트로 되돌리지 않으므로 명시 발화

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("2026-07-20");
  });

  it("값이 그대로면 커밋하지 않는다 — 달력만 열었다 닫는 것이 저장이 되면 안 된다", () => {
    const onCommit = vi.fn();
    render(<InlineDateField value="2026-07-20" onCommit={onCommit} aria-label="발행일" />);
    const input = screen.getByLabelText("발행일");

    fireEvent.change(input, { target: { value: "2026-07-20" } });
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Escape 는 원래 값으로 되돌리고 커밋하지 않는다", () => {
    const onCommit = vi.fn();
    render(<InlineDateField value="2026-07-01" onCommit={onCommit} aria-label="발행일" />);
    const input = screen.getByLabelText("발행일") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "2026-07-20" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    expect(input.value).toBe("2026-07-01");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("빈 값으로 지우는 것은 커밋된다 (삭제 경로)", () => {
    const onCommit = vi.fn();
    render(<InlineDateField value="2026-07-20" onCommit={onCommit} aria-label="발행일" />);
    const input = screen.getByLabelText("발행일");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("외부(서버) 값이 바뀌면 표시가 따라간다 — key 재마운트", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <InlineDateField value="2026-07-01" onCommit={onCommit} aria-label="발행일" />,
    );
    expect((screen.getByLabelText("발행일") as HTMLInputElement).value).toBe("2026-07-01");

    rerender(<InlineDateField value="2026-08-19" onCommit={onCommit} aria-label="발행일" />);
    expect((screen.getByLabelText("발행일") as HTMLInputElement).value).toBe("2026-08-19");
  });
});

describe("소비처 계약 — 즉시 저장 날짜 입력은 이 컴포넌트를 쓴다", () => {
  it("settlement-section 의 DateField 가 제어 input 으로 되돌아가지 않는다", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "..", "settlement-section.tsx"),
      "utf8",
    );

    expect(src).toContain("InlineDateField");
    // `value=` + `onChange` 로 저장하는 형태가 되살아나면 결함이 그대로 재발한다.
    expect(src).not.toMatch(/type="date"/);
  });
});
