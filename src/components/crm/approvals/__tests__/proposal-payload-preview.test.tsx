// @vitest-environment jsdom
/**
 * ProposalPayloadPreview — 승인 전에 저장될 값을 보여준다.
 *
 * ⚠️ 이 테스트가 지키는 것은 "무엇이 렌더되는가"가 아니라 **승인자가 틀린 값을 알아볼
 * 수 있는가**다. 그래서 값을 바꾸면 화면이 달라진다는 것(가격)과, 줄을 감추지 않는다는
 * 것(옵션 전량)을 각각 센다 — 이 화면이 없던 동안 판매가가 1,000이든 999,000이든
 * 카드가 같았고, 그것이 이 컴포넌트를 만든 이유다.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProposalPayloadPreview } from "../proposal-payload-preview";

describe("ProposalPayloadPreview", () => {
  it("거래처 기안은 저장될 거래처 칸과 담당자를 모두 보여준다", () => {
    render(
      <ProposalPayloadPreview
        action="create_partner"
        args={{
          partner: {
            name: "테스트상사",
            type: "BRAND",
            businessNumber: "1234567890",
            ceoName: "홍길동",
            address: "서울시 강남구",
          },
          contacts: [
            { name: "김담당", role: "영업팀 과장", phoneNumber: "010-1234-5678" },
            { name: "이담당", email: "lee@example.com" },
          ],
        }}
      />,
    );

    expect(screen.getByText("테스트상사")).toBeTruthy();
    expect(screen.getByText("브랜드")).toBeTruthy();
    expect(screen.getByText("1234567890")).toBeTruthy();
    expect(screen.getByText("홍길동")).toBeTruthy();
    expect(screen.getByText("담당자 2명")).toBeTruthy();
    expect(screen.getByText(/김담당/)).toBeTruthy();
    expect(screen.getByText(/이담당/)).toBeTruthy();
  });

  it("딜 기안은 가격을 값으로 보여준다 — 값이 다르면 화면이 다르다", () => {
    const { unmount } = render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partnerId: "partner-1", mainDeal: { dealName: "딜A", sellingPrice: 1_000 } }}
      />,
    );
    expect(screen.getByText("1,000원")).toBeTruthy();
    unmount();

    render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partnerId: "partner-1", mainDeal: { dealName: "딜A", sellingPrice: 999_000 } }}
      />,
    );
    expect(screen.getByText("999,000원")).toBeTruthy();
    expect(screen.queryByText("1,000원")).toBeNull();
  });

  it("옵션은 개수로 줄이지 않고 모든 줄을 그린다", () => {
    const optionDeals = Array.from({ length: 12 }, (_, index) => ({
      dealName: `옵션${index}`,
      supplyPrice: 1_000 + index,
    }));
    render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partnerId: "partner-1", mainDeal: { dealName: "딜A" }, optionDeals }}
      />,
    );

    expect(screen.getByText("옵션 12건")).toBeTruthy();
    for (const option of optionDeals) {
      // 부분일치를 쓰면 `옵션1` 이 `옵션10`·`옵션11` 까지 집어 "다 그렸다"를 못 센다.
      expect(screen.getByText(option.dealName)).toBeTruthy();
    }
    expect(screen.getByText(/공급가 1,011원/)).toBeTruthy();
  });

  it("이미 등록된 거래처는 내부 id 를 찍지 않는다 — 카드 배지가 상호를 이미 보여준다", () => {
    render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partnerId: "clx0000partner", mainDeal: { dealName: "딜A" } }}
      />,
    );
    expect(screen.queryByText("clx0000partner")).toBeNull();
    expect(screen.queryByText("기존 거래처")).toBeNull();
    expect(screen.getByText("딜A")).toBeTruthy();
  });

  it("딜에 거래처를 동봉하면 그 거래처도 함께 만들어진다고 알린다", () => {
    render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partner: { name: "새거래처", type: "VENDOR" }, mainDeal: { dealName: "딜A" } }}
      />,
    );
    expect(screen.getByText("거래처도 새로 등록됩니다")).toBeTruthy();
    expect(screen.getByText("새거래처")).toBeTruthy();
    // 거래처 유형은 crm-types 라벨 표 한 곳에서 — VENDOR 는 「벤더」(「공급사」는 브랜드·벤더를 아우르는 다른 역할 이름).
    expect(screen.getByText("벤더")).toBeTruthy();
    expect(screen.queryByText("공급사")).toBeNull();
  });

  it("두 공급가(직접 입력·자동 계산)가 함께 있을 때만 계산 칸을 「공급가(계산값)」로 가른다", () => {
    render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partner: { id: "p-1" }, mainDeal: { dealName: "딜A", costPrice: 9_000, supplyPrice: 8_500 } }}
      />,
    );
    expect(screen.getByText("공급가")).toBeTruthy();
    expect(screen.getByText("공급가(계산값)")).toBeTruthy();
    expect(screen.queryByText("원가")).toBeNull();
  });

  it("값이 없는 칸은 빈칸으로 남기지 않고 뺀다", () => {
    render(
      <ProposalPayloadPreview
        action="create_partner"
        args={{ partner: { name: "테스트상사", type: "BRAND" } }}
      />,
    );
    expect(screen.queryByText("사업자번호")).toBeNull();
    expect(screen.queryByText("대표자")).toBeNull();
    expect(screen.queryByText(/담당자/)).toBeNull();
  });

  it("정산 금액 수정은 칸 이름·지금 값·바꿀 값·메모를 보여준다", () => {
    render(
      <ProposalPayloadPreview
        action="update_settlement_amount"
        args={{
          campaignId: "camp-1",
          field: "settlementSales",
          expectedCurrentKrw: 1_200_000,
          newAmountKrw: 1_350_000,
          memo: "10월 정산 정정",
        }}
      />,
    );
    expect(screen.getByText("수수료매출")).toBeTruthy();
    expect(screen.getByText("1,200,000원")).toBeTruthy();
    expect(screen.getByText("1,350,000원")).toBeTruthy();
    expect(screen.getByText("10월 정산 정정")).toBeTruthy();
  });

  it("정산 금액 수정의 비어 있는 현재 값은 0원이 아니라 「비어 있음」으로 적는다", () => {
    render(
      <ProposalPayloadPreview
        action="update_settlement_amount"
        args={{ campaignId: "camp-1", field: "settlementGoodsCost", expectedCurrentKrw: null, newAmountKrw: 0 }}
      />,
    );
    expect(screen.getByText("물품대금")).toBeTruthy();
    expect(screen.getByText("비어 있음")).toBeTruthy();
    expect(screen.getByText("0원")).toBeTruthy();
    expect(screen.queryByText("메모")).toBeNull();
  });

  it("정산 금액 수정의 모양이 깨진 기안(모르는 칸)은 그리지 않는다", () => {
    const { container } = render(
      <ProposalPayloadPreview
        action="update_settlement_amount"
        args={{ campaignId: "camp-1", field: "operatingProfit", expectedCurrentKrw: 0, newAmountKrw: 1 }}
      />,
    );
    // 다른 미리보기와 같은 규약 — 감싸는 상자는 남아도 칸은 하나도 그리지 않는다.
    expect(container.textContent).toBe("");
    expect(screen.queryByText("1원")).toBeNull();
  });

  it("기록 수정은 대상·칸마다 지금 값 → 바꿀 값·메모를 화면 이름으로 보여준다", () => {
    render(
      <ProposalPayloadPreview
        action="update_record"
        args={{
          entityType: "CAMPAIGN",
          entityId: "camp-1",
          changes: { salesChannel: "BRAND_MALL", depositReceivedAt: "2026-04-28" },
          expected: { salesChannel: "UNSPECIFIED", depositReceivedAt: null },
          memo: "오너 확인",
        }}
      />,
    );
    expect(screen.getByText("캠페인")).toBeTruthy();
    expect(screen.getByText("판매 채널")).toBeTruthy();
    expect(screen.getByText("미지정 → 브랜드몰")).toBeTruthy();
    expect(screen.getByText("입금일")).toBeTruthy();
    expect(screen.getByText("비어 있음 → 2026-04-28")).toBeTruthy();
    expect(screen.getByText("오너 확인")).toBeTruthy();
  });

  it("기록 수정의 표에 없는 칸은 칸 이름 그대로 보인다", () => {
    render(
      <ProposalPayloadPreview
        action="update_record"
        args={{ entityType: "SELLER", entityId: "s-1", changes: { legacyMemo: "가상담당" }, expected: { legacyMemo: null } }}
      />,
    );
    expect(screen.getByText("legacyMemo")).toBeTruthy();
    expect(screen.getByText("비어 있음 → 가상담당")).toBeTruthy();
  });

  it("기록 수정의 모양이 깨진 기안(지금 값 빠짐·모르는 대상)은 그리지 않는다", () => {
    const { container: missing } = render(
      <ProposalPayloadPreview
        action="update_record"
        args={{ entityType: "CAMPAIGN", entityId: "c", changes: { salesChannel: "BRAND_MALL" }, expected: {} }}
      />,
    );
    expect(missing.textContent).toBe("");
    const { container: unknown } = render(
      <ProposalPayloadPreview
        action="update_record"
        args={{ entityType: "ORDER", entityId: "c", changes: { a: 1 }, expected: { a: 2 } }}
      />,
    );
    expect(unknown.textContent).toBe("");
  });

  describe("상품 매핑 등록(upsert_product_mappings)", () => {
    const base = {
      orderCampaignId: "oc-1",
      orderCampaignName: "10월 공구 캠페인",
      mappings: [
        { optionName: "새 옵션 A", productName: "새 상품", brandCode: "TC000202", price: 11_000, expectedBrandCode: null, expectedPrice: null },
        { optionName: "고칠 옵션 B", brandCode: "TC000203", price: 30_000, expectedBrandCode: "TC000201", expectedPrice: 15_000 },
      ],
    };

    function bodyRows(container: HTMLElement) {
      return Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => td.textContent),
      );
    }

    it("주문캠페인 한 줄 + 표: 새 줄은 「없음(새로 추가)」, 고칠 줄은 지금 → 바꿀 값", () => {
      const { container } = render(<ProposalPayloadPreview action="upsert_product_mappings" args={base} />);
      expect(screen.getByText("주문캠페인: 10월 공구 캠페인")).toBeTruthy();
      expect(Array.from(container.querySelectorAll("th")).map((th) => th.textContent)).toEqual([
        "옵션명", "상품명", "지금(코드 / 가격)", "바꿀(코드 / 가격)",
      ]);
      const rows = bodyRows(container);
      expect(rows).toEqual([
        ["새 옵션 A", "새 상품", "없음(새로 추가)", "TC000202 / 11,000원"],
        ["고칠 옵션 B", "(그대로)", "TC000201 / 15,000원", "TC000203 / 30,000원"],
      ]);
    });

    it("상품명을 비우는 줄은 「(비움)」으로 적는다", () => {
      const { container } = render(
        <ProposalPayloadPreview
          action="upsert_product_mappings"
          args={{
            ...base,
            mappings: [{ optionName: "옵션", productName: "", brandCode: "TC1", price: 1_000, expectedBrandCode: "TC0", expectedPrice: 900 }],
          }}
        />,
      );
      expect(bodyRows(container)[0][1]).toBe("(비움)");
    });

    it("지금 코드가 빈 문자열이면 「(빈 코드) / 가격」으로 적는다", () => {
      const { container } = render(
        <ProposalPayloadPreview
          action="upsert_product_mappings"
          args={{
            ...base,
            mappings: [{ optionName: "옵션", brandCode: "TC1", price: 1_000, expectedBrandCode: "", expectedPrice: 900 }],
          }}
        />,
      );
      expect(bodyRows(container)[0][2]).toBe("(빈 코드) / 900원");
    });

    const AUTO_LINK_NOTICE =
      "승인하면 화면 저장과 같이 이 캠페인 전체의 판매 딜 자동 연결이 다시 돕니다(기존 연결이 바뀔 수 있음).";

    it("새 줄이 하나라도 있으면 표 위에 「전체 자동 연결이 다시 돈다」 한 줄을 보인다", () => {
      const { container } = render(<ProposalPayloadPreview action="upsert_product_mappings" args={base} />);
      const notice = screen.getByText(AUTO_LINK_NOTICE);
      // 표보다 위에 있다(승인자가 표를 읽기 전에 본다).
      const table = container.querySelector("table");
      expect(table).not.toBeNull();
      expect(notice.compareDocumentPosition(table as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("고칠 줄만 있으면(새 줄 없음) 자동 연결 안내를 보이지 않는다", () => {
      render(
        <ProposalPayloadPreview
          action="upsert_product_mappings"
          args={{ ...base, mappings: [base.mappings[1]] }}
        />,
      );
      expect(screen.queryByText(AUTO_LINK_NOTICE)).toBeNull();
    });

    it("메모가 있으면 표 위 한 줄로 보인다", () => {
      render(<ProposalPayloadPreview action="upsert_product_mappings" args={{ ...base, memo: "제안서 3쪽 기준" }} />);
      expect(screen.getByText("메모: 제안서 3쪽 기준")).toBeTruthy();
    });

    it("50줄을 접거나 줄이지 않고 모두 그린다", () => {
      const mappings = Array.from({ length: 50 }, (_, i) => ({
        optionName: `옵션 ${i + 1}`,
        brandCode: `TC${String(i).padStart(6, "0")}`,
        price: 1_000 + i,
        expectedBrandCode: null,
        expectedPrice: null,
      }));
      const { container } = render(
        <ProposalPayloadPreview action="upsert_product_mappings" args={{ ...base, mappings }} />,
      );
      expect(container.querySelectorAll("tbody tr")).toHaveLength(50);
      expect(screen.getByText("옵션 50")).toBeTruthy();
      expect(container.textContent).not.toMatch(/외 \d+줄/);
    });

    it("모양이 깨진 기안(줄이 없음·줄이 객체가 아님)은 그리지 않고 죽지도 않는다", () => {
      for (const args of [
        { ...base, mappings: [] },
        { ...base, mappings: "x" },
        { ...base, mappings: [null] },
        { ...base, mappings: [{ optionName: "옵션" }] },
      ]) {
        const { container, unmount } = render(<ProposalPayloadPreview action="upsert_product_mappings" args={args} />);
        expect(container.textContent).toBe("");
        unmount();
      }
    });
  });

  it("미리보기가 없는 action 은 아무것도 그리지 않는다(기존 표시 유지)", () => {
    const { container } = render(
      <ProposalPayloadPreview
        action="add_entity_memo"
        args={{ entityType: "DEAL", entityId: "deal-1", content: "재입고 확인" }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
