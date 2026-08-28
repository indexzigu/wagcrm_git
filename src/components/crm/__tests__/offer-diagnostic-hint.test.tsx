import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfferDiagnosticHint } from "@/components/crm/offer-diagnostic-hint";

/**
 * 콘텐츠 가이드 생성 버튼 옆 오퍼 경고의 계약 (C3 M3).
 *
 * 지켜야 하는 선:
 * - **미충족이 없으면 아무것도 렌더하지 않는다** — 상시 배지는 노이즈가 되고,
 *   노이즈가 되면 운영자가 읽지 않는다.
 * - **생성을 막지 않는다** — 이 컴포넌트에는 버튼이 없다(C2 스펙 §2).
 * - **조회 실패로 생성을 방해하지 않는다** — 조용히 접는다.
 * - `FAIL` 만 센다. `UNKNOWN`(확인 안 됨)은 미충족이 아니다 — 여기서 뭉개면
 *   데이터가 적은 딜마다 경고가 떠서 곧 무시된다.
 */

const RESPONSE = {
  score: null,
  coverage: { decided: 6, applicable: 9 },
  rows: [
    {
      id: "BUNDLE_DIFF",
      label: "구성 차별",
      verdict: "FAIL",
      reason: "",
      fix: "x",
    },
    {
      id: "PRICE_ADVANTAGE",
      label: "가격 우위",
      verdict: "FAIL",
      reason: "",
      fix: "y",
    },
    {
      id: "RISK_REVERSAL",
      label: "위험 역전",
      verdict: "UNKNOWN",
      reason: "",
      fix: "z",
    },
    {
      id: "SELLER_FIT",
      label: "셀러 정합",
      verdict: "NA",
      reason: "",
      fix: null,
    },
    {
      id: "PURCHASE_FRICTION",
      label: "구매 마찰",
      verdict: "PASS",
      reason: "",
      fix: null,
    },
  ],
};

const stubFetch = (body: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

beforeEach(() => stubFetch(RESPONSE));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OfferDiagnosticHint", () => {
  it("미충족 건수와 행 이름을 보여준다", async () => {
    render(<OfferDiagnosticHint dealId="d1" />);
    const hint = await screen.findByText(/오퍼 미충족 2건/);
    expect(hint).toHaveTextContent("구성 차별");
    expect(hint).toHaveTextContent("가격 우위");
  });

  it("왜 오퍼를 먼저 봐야 하는지 이유를 붙인다", async () => {
    render(<OfferDiagnosticHint dealId="d1" />);
    expect(
      await screen.findByText(/카피를 다듬어도 오퍼가 약하면/),
    ).toBeInTheDocument();
  });

  it("UNKNOWN·NA 는 미충족으로 세지 않는다", async () => {
    render(<OfferDiagnosticHint dealId="d1" />);
    const hint = await screen.findByText(/오퍼 미충족/);
    // 2건(FAIL)만 — UNKNOWN(위험 역전)·NA(셀러 정합)가 섞이면 3~4건이 된다
    expect(hint).toHaveTextContent("2건");
    expect(hint).not.toHaveTextContent("위험 역전");
    expect(hint).not.toHaveTextContent("셀러 정합");
  });

  it("미충족이 없으면 아무것도 렌더하지 않는다 — 노이즈 0", async () => {
    stubFetch({
      ...RESPONSE,
      rows: RESPONSE.rows.filter((r) => r.verdict !== "FAIL"),
    });
    const { container } = render(<OfferDiagnosticHint dealId="d1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("생성을 막는 UI 를 두지 않는다 — 버튼이 없다", async () => {
    render(<OfferDiagnosticHint dealId="d1" />);
    await screen.findByText(/오퍼 미충족/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("조회 실패는 조용히 접는다 — 생성을 방해하지 않는다", async () => {
    stubFetch({ error: "없음" }, 404);
    const { container } = render(<OfferDiagnosticHint dealId="missing" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("rows 없는 응답에도 크래시하지 않는다", async () => {
    stubFetch([]);
    const { container } = render(<OfferDiagnosticHint dealId="d1" />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
