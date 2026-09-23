// @vitest-environment jsdom
/**
 * PriceSheetIngestSlot — 스크린리더 공지 영역의 수명.
 *
 * 공지 영역(role=status)이 내용과 함께 새로 생기면 스크린리더는 그 첫 내용을 변화로
 * 보지 않아 읽지 않는다. 그래서 idle 에서도 빈 영역이 먼저 있어야 하고, 파일을 고른 뒤
 * 같은 영역 안에 내용이 채워져야 한다.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PriceSheetIngestSlot } from "../price-sheet-ingest-slot";

const handlers = {
  onConfirm: vi.fn(),
  onApply: vi.fn(),
  onCancel: vi.fn(),
  onDismiss: vi.fn(),
};

beforeEach(() => {
  // pending 상태는 거래처 목록을 지연 로드한다 — 네트워크 없이 빈 목록으로 답한다.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ partners: [] }) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PriceSheetIngestSlot — 공지 영역", () => {
  it("idle 에서도 빈 공지 영역이 있고, 파일을 고르면 같은 영역에 내용이 채워진다", () => {
    const { rerender } = render(<PriceSheetIngestSlot state={{ kind: "idle" }} {...handlers} />);

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();

    const file = new File(["x"], "가격표.xlsx");
    rerender(<PriceSheetIngestSlot state={{ kind: "pending", file }} {...handlers} />);

    // 새 노드가 아니라 원래 영역이어야 공지가 읽힌다.
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("가격표.xlsx");
  });
});
