// @vitest-environment jsdom
// 반품/교환 카드의 개인정보 가림 계약(오너 결정 2026-09-28):
//  ① 주문번호·이름·연락처·사유는 기본 *** 로 보인다.
//  ② 누르면 연락처는 뒷 4자리만, 나머지는 전체가 보이고, 다시 누르면 가린다.
//  ③ 값이 없으면 누를 수 있는 버튼 없이 — 로 보인다.
// 픽스처는 전부 가짜 값이다(공개 저장소 — 실제 주문번호·이름 금지).
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimItemCard } from "../claim-list";
import type { ClaimWithCompanyName } from "@/hooks/useClaims";

const FAKE_ORDER_NO = "2099010112345678";

function makeClaim(overrides: Partial<ClaimWithCompanyName> = {}): ClaimWithCompanyName {
  return {
    productOrderId: FAKE_ORDER_NO,
    claimType: "RETURN",
    claimStatus: "RETURN_REQUEST",
    claimStatusLabel: "반품 요청",
    collectDeliveryCompanyCode: null,
    collectDeliveryInvoiceNo: null,
    collectDeliveryCompanyName: null,
    productName: "테스트 상품",
    productOption: null,
    productId: null,
    quantity: 1,
    requestDate: null,
    isCompleted: false,
    buyerName: "홍길동",
    buyerTelLast4: "5678",
    claimReason: "사이즈 불만족",
    raw: undefined,
    ...overrides,
  };
}

describe("ClaimItemCard 개인정보 가림", () => {
  it("기본은 네 항목 모두 *** 이고 원문은 화면에 없다", () => {
    render(<ClaimItemCard claim={makeClaim()} />);
    for (const label of ["주문번호", "이름", "연락처", "사유"]) {
      expect(screen.getByRole("button", { name: `${label} 보기` }).textContent).toBe("***");
    }
    expect(document.body.textContent).not.toContain(FAKE_ORDER_NO);
    expect(document.body.textContent).not.toContain("홍길동");
  });

  it("누르면 연락처는 뒷 4자리, 이름·주문번호·사유는 전체가 보이고 다시 누르면 가린다", () => {
    render(<ClaimItemCard claim={makeClaim()} />);
    const phone = screen.getByRole("button", { name: "연락처 보기" });
    fireEvent.click(phone);
    expect(phone.textContent).toBe("5678");
    fireEvent.click(phone);
    expect(phone.textContent).toBe("***");

    const name = screen.getByRole("button", { name: "이름 보기" });
    fireEvent.click(name);
    expect(name.textContent).toBe("홍길동");

    const orderNo = screen.getByRole("button", { name: "주문번호 보기" });
    fireEvent.click(orderNo);
    expect(orderNo.textContent).toBe(FAKE_ORDER_NO);

    const reason = screen.getByRole("button", { name: "사유 보기" });
    fireEvent.click(reason);
    expect(reason.textContent).toBe("사이즈 불만족");
  });

  it("값이 없으면 버튼 없이 — 로 표시한다", () => {
    render(<ClaimItemCard claim={makeClaim({ buyerName: null })} />);
    expect(screen.queryByRole("button", { name: "이름 보기" })).toBeNull();
    expect(screen.getByLabelText("이름 정보 없음").textContent).toBe("—");
  });
});
