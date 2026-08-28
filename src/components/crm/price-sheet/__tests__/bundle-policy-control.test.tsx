// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BundlePolicyControl } from "../bundle-policy-control";
import type { DealOption } from "../review-table";

const deals: DealOption[] = [
  { id: "d1", dealName: "상위딜1", parentDealId: null, brandName: "브랜드B", partnerId: "p1" },
  { id: "d2", dealName: "하위딜", parentDealId: "d1", brandName: "브랜드B", partnerId: "p1" },
  { id: "d3", dealName: "상위딜2", parentDealId: null, brandName: null, partnerId: "p2" },
  { id: "d4", dealName: "상위딜3", parentDealId: null, brandName: null, partnerId: "p2" },
];

describe("BundlePolicyControl", () => {
  it("기본값은 자동이며 대상 선택이 보이지 않는다", () => {
    render(
      <BundlePolicyControl value={{ mode: "AUTO" }} onChange={vi.fn()} deals={deals} sheetPartnerId={null} />
    );
    expect(screen.queryByLabelText("상위딜")).not.toBeInTheDocument();
  });

  it("묶기를 고르면 기존 딜 선택이 기본으로 열린다", async () => {
    const onChange = vi.fn();
    render(
      <BundlePolicyControl value={{ mode: "AUTO" }} onChange={onChange} deals={deals} sheetPartnerId={null} />
    );
    await userEvent.click(screen.getByRole("radio", { name: /하위품목으로 묶기/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "BUNDLE",
        target: expect.objectContaining({ kind: "EXISTING" }),
      })
    );
  });

  it("하위품목딜은 상위딜 후보에서 제외된다", async () => {
    render(
      <BundlePolicyControl
        value={{
          mode: "BUNDLE",
          target: { kind: "EXISTING", dealId: "", parentDealName: "", parentBrandName: null, parentPartnerId: null },
          excludedRowIds: [],
        }}
        onChange={vi.fn()}
        deals={deals}
        sheetPartnerId={null}
      />
    );
    await userEvent.click(screen.getByLabelText("상위딜"));
    expect(screen.getByText("상위딜1")).toBeInTheDocument();
    expect(screen.getByText("상위딜2")).toBeInTheDocument();
    expect(screen.queryByText("하위딜")).not.toBeInTheDocument();
  });

  it("시트 거래처의 딜이 목록 앞에 온다", async () => {
    render(
      <BundlePolicyControl
        value={{
          mode: "BUNDLE",
          target: { kind: "EXISTING", dealId: "", parentDealName: "", parentBrandName: null, parentPartnerId: null },
          excludedRowIds: [],
        }}
        onChange={vi.fn()}
        deals={deals}
        sheetPartnerId="p2"
      />
    );
    await userEvent.click(screen.getByLabelText("상위딜"));
    const options = screen.getAllByRole("option").map((el) => el.textContent);
    expect(options[0]).toContain("상위딜2");
  });

  it("거래처 매칭 딜이 여러 건이면 원래 상대 순서를 유지한 채로 앞으로 온다", async () => {
    // p2 매칭 딜(상위딜2, 상위딜3)이 둘 다 앞으로 와야 하고, 그 둘 사이의 순서는
    // deals 배열의 원래 순서(상위딜2 → 상위딜3)를 그대로 지켜야 한다 — 단일 매치만
    // 검증하면 "매칭 딜이 앞으로 온다"만 증명될 뿐 파티션 내부 순서 보존은 증명되지 않는다.
    render(
      <BundlePolicyControl
        value={{
          mode: "BUNDLE",
          target: { kind: "EXISTING", dealId: "", parentDealName: "", parentBrandName: null, parentPartnerId: null },
          excludedRowIds: [],
        }}
        onChange={vi.fn()}
        deals={deals}
        sheetPartnerId="p2"
      />
    );
    await userEvent.click(screen.getByLabelText("상위딜"));
    const options = screen.getAllByRole("option").map((el) => el.textContent ?? "");
    const names = options.map((text) =>
      text.includes("상위딜3") ? "상위딜3" : text.includes("상위딜2") ? "상위딜2" : "상위딜1"
    );
    expect(names).toEqual(["상위딜2", "상위딜3", "상위딜1"]);
  });
});
