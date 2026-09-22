// @vitest-environment jsdom
/**
 * PriceSheetIngestCard — 결재함 가격표 업로드 카드 (Plan 3 Task A2).
 *
 * 카드는 배선만 한다(버튼 → 숨은 file input → `stageFile`). 상태기계·문구·검토 카드는
 * `PriceSheetIngestSlot`/`usePriceSheetIngest` 가 소유하므로 훅을 mock 해 **입구 배선**만
 * 검증한다 — 슬롯 자체의 행위는 `price-sheet-ingest.test.ts` 가 본다.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stageFile = vi.fn();
const hookState = { isRunning: false };

vi.mock("../price-sheet-ingest-slot", () => ({
  usePriceSheetIngest: () => ({
    state: { kind: "idle" as const },
    isRunning: hookState.isRunning,
    stageFile,
    confirmUpload: vi.fn(),
    applyClean: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
  }),
  PriceSheetIngestSlot: () => <div data-testid="price-sheet-slot" />,
}));

import { PriceSheetIngestCard } from "../price-sheet-ingest-card";

function fileInput(): HTMLInputElement {
  return screen.getByTestId("price-sheet-file-input") as HTMLInputElement;
}

beforeEach(() => {
  stageFile.mockReset();
  hookState.isRunning = false;
});

describe("PriceSheetIngestCard", () => {
  it("제목이 영역 이름이 된다 — 보이는 제목과 스크린리더가 읽는 이름이 같다", () => {
    render(<PriceSheetIngestCard />);

    const heading = screen.getByRole("heading", { level: 2, name: "가격표 업로드" });
    // `aria-label` 로 이름을 따로 쓰면 제목을 고칠 때 둘이 갈린다 — id 로 묶는다.
    expect(screen.getByRole("region", { name: "가격표 업로드" })).toHaveAttribute(
      "aria-labelledby",
      heading.id,
    );
  });

  it("업로드 버튼이 숨은 file input 을 연다", () => {
    render(<PriceSheetIngestCard />);
    const click = vi.spyOn(fileInput(), "click");

    fireEvent.click(screen.getByRole("button", { name: "가격표 업로드" }));

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("파일을 고르면 stageFile 로 넘기고 input 값을 비운다", () => {
    render(<PriceSheetIngestCard />);
    const file = new File(["x"], "price.xlsx");

    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(stageFile).toHaveBeenCalledWith(file);
    // 같은 파일을 다시 고를 수 있어야 한다 — 값을 비우지 않으면 change 가 안 뜬다.
    expect(fileInput().value).toBe("");
  });

  it("진행 중에는 업로드 버튼이 잠긴다", () => {
    hookState.isRunning = true;
    render(<PriceSheetIngestCard />);

    expect(screen.getByRole("button", { name: "가격표 업로드" })).toBeDisabled();
  });

  it("슬롯을 함께 렌더한다 — 진행·검토 표시는 슬롯이 소유한다", () => {
    render(<PriceSheetIngestCard />);

    expect(screen.getByTestId("price-sheet-slot")).toBeInTheDocument();
  });
});
