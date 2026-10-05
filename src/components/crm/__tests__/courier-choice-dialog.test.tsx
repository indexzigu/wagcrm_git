// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CourierChoiceDialog from "../courier-choice-dialog";
import { EMPTY_COURIER_LABEL, NAVER_COURIER_OPTIONS } from "@/lib/order-converter/courier-code";

// 택배사 선택 창(오너 확정 2026-10-05) — 이 창이 지켜야 하는 것은 「고르기 전에는 못 넘어간다」와
// 「취소는 아무것도 하지 않는다」 둘이다. 등록 자체(네이버 호출)는 이 창의 일이 아니라 호출부 몫이다.

const groups = [
  { key: "경동택배", label: "경동택배", count: 2 },
  { key: "", label: EMPTY_COURIER_LABEL, count: 3 },
];

function renderDialog() {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(<CourierChoiceDialog groups={groups} onCancel={onCancel} onConfirm={onConfirm} />);
  return { onCancel, onConfirm, dialog: screen.getByRole("dialog") };
}

async function choose(triggerName: string, optionLabel: string) {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }));
  fireEvent.click(await screen.findByRole("option", { name: optionLabel }));
}

describe("CourierChoiceDialog", () => {
  it("제목·안내·묶음별 건수·목록 밖 택배사 안내를 그대로 보여 준다", () => {
    const { dialog } = renderDialog();
    expect(within(dialog).getByRole("heading", { name: "택배사를 확인해 주세요" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "송장 5건의 택배사를 알아보지 못했습니다. 고른 택배사가 실제 주문에 등록됩니다. 취소하면 아무것도 등록하지 않습니다.",
    );
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("경동택배")).toBeInTheDocument();
    expect(within(rows[0]).getByText("2건")).toBeInTheDocument();
    expect(within(rows[1]).getByText(EMPTY_COURIER_LABEL)).toBeInTheDocument();
    expect(within(rows[1]).getByText("3건")).toBeInTheDocument();

    // 목록 밖 택배사 안내는 고르기 **전에** 읽혀야 하므로 목록보다 앞에 있다.
    const warning = within(dialog).getByText(
      "목록에 없는 택배사(예: 경동택배)는 비슷한 택배사로 고르지 말고, 취소한 뒤 네이버 판매자센터에서 직접 등록해 주세요.",
    );
    expect(
      warning.compareDocumentPosition(within(dialog).getByRole("list")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("남은 묶음 수를 알리고, 등록 버튼이 그 안내를 설명으로 가리킨다", async () => {
    const { dialog } = renderDialog();
    const status = within(dialog).getByRole("status");
    const confirm = within(dialog).getByRole("button", { name: "선택한 택배사로 등록" });
    expect(status).toHaveTextContent("택배사를 고르지 않은 묶음 2개");
    expect(confirm).toHaveAttribute("aria-describedby", status.id);

    await choose("경동택배 택배사 선택", "한진택배");
    expect(status).toHaveTextContent("택배사를 고르지 않은 묶음 1개");

    await choose(`${EMPTY_COURIER_LABEL} 택배사 선택`, "우체국택배");
    expect(status).toHaveTextContent("모두 선택했습니다");
  });

  it("처음에는 아무 택배사도 골라져 있지 않고 등록 버튼이 잠겨 있다", () => {
    const { dialog, onConfirm } = renderDialog();
    const triggers = within(dialog).getAllByRole("combobox");
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) expect(trigger).toHaveTextContent("택배사 선택");
    const confirm = within(dialog).getByRole("button", { name: "선택한 택배사로 등록" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("고를 수 있는 것은 서버가 받는 택배사뿐이다", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("combobox", { name: "경동택배 택배사 선택" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(NAVER_COURIER_OPTIONS.map((o) => o.label));
  });

  it("묶음을 전부 고르기 전에는 잠겨 있고, 전부 고르면 고른 대로 넘긴다", async () => {
    const { dialog, onConfirm, onCancel } = renderDialog();
    const confirm = within(dialog).getByRole("button", { name: "선택한 택배사로 등록" });

    await choose("경동택배 택배사 선택", "한진택배");
    expect(confirm).toBeDisabled();

    await choose(`${EMPTY_COURIER_LABEL} 택배사 선택`, "우체국택배");
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ 경동택배: "HANJIN", "": "EPOST" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("취소·Esc 는 취소만 부르고 등록은 부르지 않는다", async () => {
    const { dialog, onConfirm, onCancel } = renderDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
