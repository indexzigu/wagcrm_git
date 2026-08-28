// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DealGroupPreview } from "../deal-group-preview";
import type { PriceSheetRowData } from "../review-table";

function row(overrides: Partial<PriceSheetRowData> = {}): PriceSheetRowData {
  return {
    id: "row",
    priceSheetId: "sheet-1",
    rowIndex: 0,
    tableSegment: 0,
    productName: "제품A",
    optionName: "젤리 2팩",
    sellingPrice: 18000,
    commissionRate: 0.4,
    supplyPrice: 10800,
    listPrice: null,
    floorPrice: null,
    discountRate: null,
    note: null,
    flags: null,
    rawCells: {},
    mappingStatus: "NEW_DEAL",
    mappedDealId: null,
    ...overrides,
  };
}

describe("DealGroupPreview — 딜 반영 미리보기", () => {
  it("같은 제품의 옵션들이 상위딜 1 + 하위 옵션 N으로 표시된다", () => {
    render(
      <DealGroupPreview
        rows={[
          row({ id: "r1", optionName: "젤리 2팩" }),
          row({ id: "r2", optionName: "젤리 6팩", sellingPrice: 49300 }),
          row({ id: "r3", optionName: "젤리 12팩", sellingPrice: 78800 }),
        ]}
        partnerId={null}
        partners={[]}
        overrides={{}}
        onOverrideChange={() => {}}
        deals={[]}
      />
    );

    expect(screen.getByText("딜 반영 미리보기")).toBeInTheDocument();
    expect(screen.getByText("상위딜")).toBeInTheDocument();
    expect(screen.getByText("제품A")).toBeInTheDocument();
    expect(screen.getByText("하위 옵션 3개")).toBeInTheDocument();
    expect(screen.getByText("제품A - 2팩")).toBeInTheDocument();
    // 단위 1 옵션이 없으므로 빈 컨테이너 경고가 뜬다
    expect(screen.getByText(/상위딜 가격 없음\(0원\)/)).toBeInTheDocument();
  });

  it("MAPPED 행은 '기존 딜 업데이트'로 딜명과 함께 표시된다", () => {
    render(
      <DealGroupPreview
        rows={[row({ id: "m1", mappingStatus: "MAPPED", mappedDealId: "deal-9" })]}
        partnerId={null}
        partners={[]}
        overrides={{}}
        onOverrideChange={() => {}}
        deals={[
          { id: "deal-9", dealName: "기존딜Z", parentDealId: null, brandName: null, partnerId: null },
        ]}
      />
    );

    expect(screen.getByText(/기존 딜 업데이트 \(1건\)/)).toBeInTheDocument();
    expect(screen.getByText("기존딜Z")).toBeInTheDocument();
  });

  it("SUGGESTED/UNMAPPED는 미확정 카운트로 반영 제외를 알린다", () => {
    render(
      <DealGroupPreview
        rows={[
          row({ id: "s1", mappingStatus: "SUGGESTED", mappedDealId: "deal-1" }),
          row({ id: "u1", mappingStatus: "UNMAPPED" }),
        ]}
        partnerId={null}
        partners={[]}
        overrides={{}}
        onOverrideChange={() => {}}
        deals={[]}
      />
    );

    expect(screen.getByText(/미확정 2건은 반영에서 제외/)).toBeInTheDocument();
    // 확정 행이 없으므로 안내 문구
    expect(screen.getByText(/아직 확정된 행이 없습니다/)).toBeInTheDocument();
  });

  it("그룹 카드에 브랜드 입력·거래처 선택이 뜨고, 미연결이면 경고를 보여준다", () => {
    render(
      <DealGroupPreview
        rows={[
          row({ id: "r1", optionName: "젤리 2팩" }),
          row({ id: "r2", optionName: "젤리 6팩" }),
        ]}
        partnerId={null}
        partners={[{ id: "p1", name: "거래처X" }]}
        overrides={{}}
        onOverrideChange={() => {}}
        deals={[]}
      />
    );

    expect(screen.getByPlaceholderText("브랜드명 입력")).toBeInTheDocument();
    expect(screen.getByText("거래처")).toBeInTheDocument();
    expect(screen.getByText("거래처 미연결 상태로 생성됩니다")).toBeInTheDocument();
  });

  it("오버라이드의 브랜드 값이 입력창에 그대로 표시된다", () => {
    const rows = [
      row({ id: "r1", optionName: "젤리 2팩" }),
      row({ id: "r2", optionName: "젤리 6팩" }),
    ];
    // groupKey는 grouping SSOT가 정한다 — 여기서는 렌더된 입력값으로만 검증한다.
    render(
      <DealGroupPreview
        rows={rows}
        partnerId={null}
        partners={[]}
        overrides={new Proxy({}, { get: () => ({ brandName: "수정브랜드", partnerId: "p1" }) })}
        onOverrideChange={() => {}}
        deals={[]}
      />
    );
    expect(screen.getByDisplayValue("수정브랜드")).toBeInTheDocument();
  });

  it("기존 딜에 붙이는 묶음은 '기존 딜에 추가'로 표시되고 상위딜 가격을 보이지 않는다", () => {
    render(
      <DealGroupPreview
        rows={[
          row({ id: "r1", productName: "제품A", optionName: null }),
          row({ id: "r2", productName: "제품B", optionName: null }),
        ]}
        partnerId={null}
        deals={[]}
        partners={[]}
        overrides={{}}
        onOverrideChange={vi.fn()}
        bundle={{
          mode: "BUNDLE",
          target: {
            kind: "EXISTING",
            dealId: "d1",
            parentDealName: "기존상위딜",
            parentBrandName: null,
            parentPartnerId: null,
          },
          excludedRowIds: [],
        }}
      />
    );
    expect(screen.getByText("기존 딜에 추가")).toBeInTheDocument();
    expect(screen.getByText("기존상위딜")).toBeInTheDocument();
    expect(screen.queryByText(/상위딜 가격 없음/)).not.toBeInTheDocument();
  });

  it("행이 없으면 아무것도 렌더하지 않는다(추출 전)", () => {
    const { container } = render(<DealGroupPreview rows={[]} partnerId={null} deals={[]} partners={[]} overrides={{}} onOverrideChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
