// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimCheckerPanel } from "@/components/crm/claim-checker-panel";
import type { BannedRuleInput } from "@/lib/claims/claim-gate";

/**
 * 표현 검사 패널(C1 M2)의 판정 표시 계약.
 *
 * 게이트 판정 자체는 `claim-gate.contract.test.ts`가 고정한다. 여기서 지키는
 * 것은 **운영자가 화면에서 무엇을 보는가** — 위반 구간이 본문에 표시되는지,
 * 법령 근거가 함께 나오는지, 카테고리 규칙이 해당 카테고리에서만 걸리는지.
 */

const RULES: BannedRuleInput[] = [
  {
    id: "r-global",
    phrase: "부작용 없음",
    pattern: "부작용\\s*(이)?\\s*없",
    category: null,
    severity: "WARN",
    legalBasis: "표시광고법 §3",
    note: "안전성 단정",
  },
  {
    id: "r-cosmetic",
    phrase: "아토피 치료",
    pattern: "아토피\\s*(치료|개선)",
    category: "COSMETIC",
    severity: "BLOCK",
    legalBasis: "화장품법 §13",
    note: null,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClaimCheckerPanel", () => {
  it("입력 전에는 결과 영역을 보여주지 않는다", () => {
    render(<ClaimCheckerPanel rules={RULES} />);
    expect(screen.queryByLabelText("검사 결과 본문")).not.toBeInTheDocument();
    expect(screen.queryByText(/지적 사항 없음/)).not.toBeInTheDocument();
  });

  it("공통 규칙 위반을 법령 근거와 함께 보여준다", async () => {
    const user = userEvent.setup();
    render(<ClaimCheckerPanel rules={RULES} />);

    await user.type(screen.getByLabelText("검사할 문구"), "부작용이 없어요");

    expect(screen.getByText(/표현 1건/)).toBeInTheDocument();
    expect(screen.getByText("표시광고법 §3 · 안전성 단정")).toBeInTheDocument();
    // 위반 구간이 본문에서 마크업된다(하이라이트 캐리어).
    const body = screen.getByLabelText("검사 결과 본문");
    expect(body.querySelector("mark")?.textContent).toContain("부작용");
  });

  it("깨끗한 문구는 지적 없음으로 표시한다", async () => {
    const user = userEvent.setup();
    render(<ClaimCheckerPanel rules={RULES} />);

    await user.type(
      screen.getByLabelText("검사할 문구"),
      "이번 주 금요일에 오픈합니다",
    );

    expect(screen.getByText("지적 사항 없음")).toBeInTheDocument();
    expect(screen.queryByLabelText("검사 결과 본문")).not.toBeInTheDocument();
  });

  it("카테고리 규칙은 해당 카테고리를 골랐을 때만 걸린다", async () => {
    const user = userEvent.setup();
    render(<ClaimCheckerPanel rules={RULES} />);

    await user.type(
      screen.getByLabelText("검사할 문구"),
      "아토피 치료에 좋아요",
    );
    // 기본값은 공통(카테고리 미지정) — 화장품 규칙은 적용되지 않는다.
    expect(screen.getByText("지적 사항 없음")).toBeInTheDocument();

    await user.click(screen.getByLabelText("상품 카테고리"));
    await user.click(screen.getByRole("option", { name: "화장품" }));

    expect(screen.getByText(/표현 1건/)).toBeInTheDocument();
    expect(screen.getByText("사용 불가")).toBeInTheDocument();
    expect(screen.getByText("화장품법 §13")).toBeInTheDocument();
  });

  it("겹치는 매치는 버려지지 않고 병합돼 본문에서 찾을 수 있다", async () => {
    const user = userEvent.setup();
    // "아토피"(WARN)와 "아토피 치료"(BLOCK)가 같은 구간에서 겹쳐 걸린다.
    const overlapping: BannedRuleInput[] = [
      {
        id: "r-short",
        phrase: "아토피",
        pattern: "아토피",
        category: null,
        severity: "WARN",
        legalBasis: "화장품법 §13",
        note: null,
      },
      {
        id: "r-long",
        phrase: "아토피 치료",
        pattern: "아토피\\s*치료",
        category: null,
        severity: "BLOCK",
        legalBasis: "화장품법 §13",
        note: null,
      },
    ];
    render(<ClaimCheckerPanel rules={overlapping} />);

    await user.type(screen.getByLabelText("검사할 문구"), "아토피 치료 효과");

    // 두 규칙 모두 목록에 잡히고
    expect(screen.getByText(/표현 2건/)).toBeInTheDocument();
    // 본문 하이라이트는 하나로 병합되며, 더 무거운 BLOCK 을 따른다.
    const marks = screen
      .getByLabelText("검사 결과 본문")
      .querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("아토피 치료");
    expect(marks[0].className).toContain("underline");
  });

  it("딜을 연결하면 승인된 딜 표현만 검사에 반영한다", async () => {
    const claims = [
      // 승인된 딜 전용 금지 — 게이트에 들어가 BLOCK 을 낸다.
      {
        id: "dc1",
        kind: "BANNED_PHRASE",
        text: "리뉴얼 전 제품",
        status: "APPROVED",
      },
      // 검토 대기 — 반영되면 승인 규율이 무너진다.
      {
        id: "dc2",
        kind: "BANNED_PHRASE",
        text: "한정 수량",
        status: "PROPOSED",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ category: "FOOD", claims }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const user = userEvent.setup();
    render(
      <ClaimCheckerPanel
        rules={RULES}
        deals={[
          {
            id: "d1",
            dealName: "테스트 딜",
            brandName: "브랜드",
            category: "FOOD",
          },
        ]}
      />,
    );

    await user.click(screen.getByLabelText("딜 연결"));
    await user.click(screen.getByRole("option", { name: /테스트 딜/ }));
    await screen.findByText(/딜 표현 1건/); // APPROVED 1건만 로드

    await user.type(
      screen.getByLabelText("검사할 문구"),
      "리뉴얼 전 제품 한정 수량 입고",
    );

    // 승인된 것만 걸린다 — PROPOSED("한정 수량")는 하이라이트되지 않는다.
    expect(screen.getByText("사용 불가")).toBeInTheDocument();
    const marks = screen
      .getByLabelText("검사 결과 본문")
      .querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("리뉴얼 전 제품");
  });

  it("딜 표현 로드가 실패해도 공통 사전으로 검사를 계속한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const user = userEvent.setup();
    render(
      <ClaimCheckerPanel
        rules={RULES}
        deals={[
          { id: "d1", dealName: "테스트 딜", brandName: null, category: null },
        ]}
      />,
    );

    await user.click(screen.getByLabelText("딜 연결"));
    await user.click(screen.getByRole("option", { name: /테스트 딜/ }));
    expect(
      await screen.findByText(/공통 사전만으로 검사 중/),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("검사할 문구"), "부작용이 없어요");
    expect(screen.getByText(/표현 1건/)).toBeInTheDocument();
  });

  it("적용 규칙 수가 선택한 카테고리를 따른다", async () => {
    const user = userEvent.setup();
    render(<ClaimCheckerPanel rules={RULES} />);

    expect(screen.getByText("적용 규칙 1건")).toBeInTheDocument();

    await user.click(screen.getByLabelText("상품 카테고리"));
    await user.click(screen.getByRole("option", { name: "화장품" }));

    // 공통 1 + 화장품 1
    expect(screen.getByText("적용 규칙 2건")).toBeInTheDocument();
  });
});
