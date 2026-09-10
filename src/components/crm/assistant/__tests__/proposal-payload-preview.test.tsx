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
    expect(screen.getByText("공급사")).toBeTruthy();
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
