// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { previewText } from "@/components/crm/confirm-action-dialog";
import { DeleteConfirmDialog } from "@/components/crm/delete-confirm-dialog";

describe("확인 창", () => {
  it("확인 버튼이 결과(「캠페인 삭제」)를 말하고, 누르면 실행한다", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteConfirmDialog open onOpenChange={() => {}} entityType="캠페인" entityName="딜 - 셀러" onConfirm={onConfirm} />,
    );
    expect(screen.getByText(/'딜 - 셀러'을\(를\) 삭제하시겠습니까\? 이 작업은 되돌릴 수 없습니다\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "캠페인 삭제" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("취소는 실행하지 않고 창만 닫는다", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <DeleteConfirmDialog open onOpenChange={onOpenChange} entityType="노트" entityName="메모" onConfirm={onConfirm} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("진행 중에는 버튼이 막히고 진행 문구를 보인다", () => {
    render(
      <DeleteConfirmDialog open onOpenChange={() => {}} entityType="캠페인" entityName="x" onConfirm={vi.fn()} loading />,
    );
    expect(screen.getByRole("button", { name: "삭제 중..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
  });

  it("미리보기는 잘랐을 때만 말줄임표를 붙인다", () => {
    expect(previewText("짧은 메모")).toBe("짧은 메모");
    expect(previewText("가".repeat(31))).toBe(`${"가".repeat(30)}...`);
    expect(previewText("  공백  ")).toBe("공백");
  });
});
