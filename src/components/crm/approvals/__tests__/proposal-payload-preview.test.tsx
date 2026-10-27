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

  it("판매 조건 기안은 가격을 값으로 보여준다 — 값이 다르면 화면이 다르다", () => {
    const { unmount } = render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partnerId: "partner-1", mainDeal: { dealName: "판매 조건A", sellingPrice: 1_000 } }}
      />,
    );
    expect(screen.getByText("1,000원")).toBeTruthy();
    unmount();

    render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partnerId: "partner-1", mainDeal: { dealName: "판매 조건A", sellingPrice: 999_000 } }}
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
        args={{ partnerId: "partner-1", mainDeal: { dealName: "판매 조건A" }, optionDeals }}
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
        args={{ partnerId: "clx0000partner", mainDeal: { dealName: "판매 조건A" } }}
      />,
    );
    expect(screen.queryByText("clx0000partner")).toBeNull();
    expect(screen.queryByText("기존 거래처")).toBeNull();
    expect(screen.getByText("판매 조건A")).toBeTruthy();
  });

  it("판매 조건에 거래처를 동봉하면 그 거래처도 함께 만들어진다고 알린다", () => {
    render(
      <ProposalPayloadPreview
        action="create_deal"
        args={{ partner: { name: "새거래처", type: "VENDOR" }, mainDeal: { dealName: "판매 조건A" } }}
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
        args={{ partner: { id: "p-1" }, mainDeal: { dealName: "판매 조건A", costPrice: 9_000, supplyPrice: 8_500 } }}
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
        targetEntityName="테스트브랜드 봄딜 - 샘플 2차"
      />,
    );
    // 대상 칸은 종류(「캠페인」)가 아니라 그 캠페인 이름을 보인다
    expect(screen.getByText("캠페인")).toBeTruthy();
    expect(screen.getByText("테스트브랜드 봄딜 - 샘플 2차")).toBeTruthy();
    expect(screen.getByText("판매 채널")).toBeTruthy();
    expect(screen.getByText("미지정 → 브랜드몰")).toBeTruthy();
    expect(screen.getByText("입금일")).toBeTruthy();
    expect(screen.getByText("비어 있음 → 2026-04-28")).toBeTruthy();
    expect(screen.getByText("오너 확인")).toBeTruthy();
  });

  it("기록 수정의 대상 이름을 못 풀었으면 대상 칸을 뺀다(종류만 적지 않는다)", () => {
    render(
      <ProposalPayloadPreview
        action="update_record"
        args={{ entityType: "CAMPAIGN", entityId: "camp-1", changes: { salesChannel: "BRAND_MALL" }, expected: { salesChannel: "UNSPECIFIED" } }}
      />,
    );
    expect(screen.queryByText("캠페인")).toBeNull();
    expect(screen.getByText("미지정 → 브랜드몰")).toBeTruthy();
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
      "승인하면 화면 저장과 같이 이 캠페인 전체의 판매 조건 자동 연결이 다시 돕니다(기존 연결이 바뀔 수 있음).";

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

describe("ProposalPayloadPreview — [캘린더수집] 캘린더에서 온 기안", () => {
  const calendarRef = (over: Record<string, unknown> = {}) => ({
    calendarInbound: {
      inboundId: "in-1",
      eventId: "ev-1",
      calendarId: "primary",
      ledgerKind: "campaign",
      adopt: true,
      summary: "샘플 테스트브랜드 2차",
      startDate: "2026-12-01",
      endDate: "2026-12-07",
      htmlLink: "https://calendar.google.com/event?eid=abc",
      warnings: ["종료일 확인 필요", "가장 최근 회차로 자동 지정"],
      ...over,
    },
  });

  it("새 회차 생성은 셀러·판매 조건·기간·생성 상태를 이름으로 보여준다(id 가 아니라)", () => {
    render(
      <ProposalPayloadPreview
        action="create_campaign_round"
        args={{ dealId: "d1", sellerId: "s1", startDate: "2026-12-01", endDate: "2026-12-07" }}
        argLabels={{ seller: "샘플", deal: "테스트브랜드 봄딜" }}
      />,
    );
    expect(screen.getByText("샘플")).toBeTruthy();
    expect(screen.getByText("테스트브랜드 봄딜")).toBeTruthy();
    expect(screen.getByText("2026-12-01 ~ 2026-12-07")).toBeTruthy();
    // 상태 이름은 캠페인 상태 라벨 표(PREPARATION = 세팅대기)와 같은 말
    expect(screen.getByText("세팅대기로 생성")).toBeTruthy();
    expect(screen.queryByText("d1")).toBeNull();
    expect(screen.queryByText("s1")).toBeNull();
  });

  it("이름을 못 풀었으면 셀러·판매 조건 칸을 id 로 채우지 않고 뺀다", () => {
    render(
      <ProposalPayloadPreview
        action="create_campaign_round"
        args={{ dealId: "d1", sellerId: "s1", startDate: "2026-12-01", endDate: "2026-12-01" }}
      />,
    );
    expect(screen.queryByText("d1")).toBeNull();
    expect(screen.queryByText("셀러")).toBeNull();
    expect(screen.getByText("2026-12-01")).toBeTruthy();
  });

  it("캘린더 출처: 바뀔 칸 → 흐린 원본 한 줄(제목·날짜·구글 링크) → 확인할 점 순서", () => {
    const { container } = render(
      <ProposalPayloadPreview
        action="create_campaign_round"
        args={{ dealId: "d1", sellerId: "s1", startDate: "2026-12-01", endDate: "2026-12-07" }}
        argLabels={{ seller: "샘플", deal: "테스트브랜드 봄딜" }}
        sourceRef={calendarRef()}
      />,
    );
    const origin = screen.getByText(/^원본: 샘플 테스트브랜드 2차 · 2026-12-01 ~ 2026-12-07/);
    expect(origin.className).toContain("text-muted-foreground");
    const link = screen.getByRole("link", { name: /구글 캘린더에서 보기/ });
    expect(origin.contains(link)).toBe(true);
    // 순서: 바뀔 칸(기간) → 원본 → 확인할 점
    const period = screen.getByText("2026-12-01 ~ 2026-12-07");
    const warningsTitle = screen.getByText("확인할 점");
    expect(period.compareDocumentPosition(origin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(origin.compareDocumentPosition(warningsTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain("원본 일정");
    expect(link.getAttribute("href")).toBe("https://calendar.google.com/event?eid=abc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["종료일 확인 필요", "가장 최근 회차로 자동 지정"]);
  });

  it("기록 수정 기안에도 원본 일정이 붙고, 링크가 없으면 링크를 그리지 않는다", () => {
    render(
      <ProposalPayloadPreview
        action="update_record"
        args={{
          entityType: "CAMPAIGN",
          entityId: "c1",
          changes: { startDate: "2026-12-02" },
          expected: { startDate: "2026-12-01" },
        }}
        sourceRef={JSON.stringify(calendarRef({ htmlLink: null, warnings: [] }))}
      />,
    );
    expect(screen.getByText(/^원본: 샘플 테스트브랜드 2차/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("확인할 점")).toBeNull();
    // 기록 수정 본문(지금 값 → 바꿀 값)도 그대로 그린다
    expect(screen.getByText(/→/)).toBeTruthy();
  });

  it("캘린더 출처가 없거나 모양이 틀리면 원본 일정 블록이 없다", () => {
    const { unmount } = render(
      <ProposalPayloadPreview action="create_deal" args={{ mainDeal: { dealName: "A", sellingPrice: 1 } }} sourceRef={{ slack: {} }} />,
    );
    expect(screen.queryByText(/^원본:/)).toBeNull();
    unmount();
    render(<ProposalPayloadPreview action="create_deal" args={{ mainDeal: { dealName: "A" } }} sourceRef={{ calendarInbound: { summary: "x" } }} />);
    expect(screen.queryByText(/^원본:/)).toBeNull();
  });

  it("https 가 아닌 링크는 그리지 않는다(원본 줄은 남는다)", () => {
    render(
      <ProposalPayloadPreview
        action="create_campaign_round"
        args={{ dealId: "d1", sellerId: "s1", startDate: "2026-12-01", endDate: "2026-12-07" }}
        sourceRef={calendarRef({ htmlLink: "javascript:alert(1)" })}
      />,
    );
    expect(screen.getByText(/^원본:/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  describe("판매캠페인 품목 추가(T-271)", () => {
    const args = {
      campaignId: "sc-1",
      mainDealId: "main-1",
      items: [
        { dealName: "3개입", sellingPrice: 27_000, totalCommissionRate: 18 },
        { dealId: "opt-2" },
        { dealId: "gone" },
      ],
      memo: "새 구성 추가",
    };

    it("새 줄·연결 줄 모두 이름과 판매가(총수수료율)를 보여 주고 id 는 내보이지 않는다", () => {
      render(
        <ProposalPayloadPreview
          action="add_campaign_items"
          args={args}
          argLabels={{
            seller: null,
            deal: "샘플 상품",
            linkedDeals: { "opt-2": { name: "샘플 상품 2개입", sellingPrice: 19_000, totalCommissionRate: 20 } },
          }}
          targetEntityName="샘플 셀러 2차"
        />,
      );
      expect(screen.getByText("샘플 셀러 2차")).toBeTruthy();
      expect(screen.getByText("샘플 상품")).toBeTruthy();
      expect(screen.getByText("새 구성 추가")).toBeTruthy();
      // 새 하위품목은 실행기가 저장할 이름(「판매 조건 이름 - 옵션 이름」)으로 보인다.
      expect(screen.getByText("샘플 상품 - 3개입")).toBeTruthy();
      expect(screen.getByText("27,000원 · 총수수료율 18%")).toBeTruthy();
      expect(screen.getByText("샘플 상품 2개입")).toBeTruthy();
      expect(screen.getByText("19,000원 · 총수수료율 20%")).toBeTruthy();
      expect(screen.getByText("이름 확인 불가")).toBeTruthy();
      expect(screen.getAllByText("기존 하위품목 연결")).toHaveLength(2);
      expect(screen.getByText("새로 만들기")).toBeTruthy();
      expect(screen.getByText(/주문수량 0인 품목이 더해집니다/)).toBeTruthy();
      // 이름을 못 푼 연결 줄은 판매가도 「—」(지어내지 않는다).
      expect(screen.getByText("—")).toBeTruthy();
      expect(screen.queryByText("opt-2")).toBeNull();
      expect(screen.queryByText("gone")).toBeNull();
    });

    it("판매가가 다르면 화면이 달라진다(승인자가 틀린 값을 알아볼 수 있다)", () => {
      const { rerender } = render(<ProposalPayloadPreview action="add_campaign_items" args={args} />);
      expect(screen.getByText("27,000원 · 총수수료율 18%")).toBeTruthy();
      rerender(
        <ProposalPayloadPreview
          action="add_campaign_items"
          args={{ ...args, items: [{ dealName: "3개입", sellingPrice: 270_000 }] }}
        />,
      );
      expect(screen.getByText("270,000원")).toBeTruthy();
      expect(screen.queryByText("27,000원 · 총수수료율 18%")).toBeNull();
    });
  });
});
