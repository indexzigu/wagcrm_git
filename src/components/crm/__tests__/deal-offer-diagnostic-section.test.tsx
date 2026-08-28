// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DealOfferDiagnosticSection } from "@/components/crm/deal-offer-diagnostic-section";

/**
 * 딜 오퍼 진단 섹션(C2 M2)의 계약.
 *
 * 화면에서 지켜야 하는 것:
 * - **점수를 보여주지 않는다**(M1 오너 결정). 커버리지와 조치 건수만.
 * - **고쳐야 할 행이 위로 온다** — PASS 가 목록 위에 깔리면 미충족 항목이
 *   스크롤 아래로 밀려 안 보인다.
 * - 미충족 행에는 **구체 수정**이 함께 보인다. 판정만 보여주면 못 고친다.
 * - 로드 실패는 조용히 넘어가지 않는다.
 */

const RESPONSE = {
  dealId: "d1",
  dealName: "테스트 공구",
  resolvedFromParent: false,
  priceSnapshotDate: "2026-07-30",
  score: null,
  coverage: { decided: 4, applicable: 5 },
  rows: [
    {
      id: "RESULT_CLARITY",
      label: "결과 명확성",
      verdict: "PASS",
      reason: "승인 소구점 3건",
      fix: null,
    },
    {
      id: "PRICE_ADVANTAGE",
      label: "가격 우위",
      verdict: "FAIL",
      reason: "최저가 방어 실패 — 타처가 더 쌉니다",
      fix: "브랜드와 공급가를 재협상하세요",
    },
    {
      id: "EVIDENCE",
      label: "근거 실증",
      verdict: "UNKNOWN",
      reason: "판정할 소구점이 없습니다",
      fix: "소구점을 먼저 등록하세요",
    },
    {
      id: "SELLER_FIT",
      label: "셀러 정합",
      verdict: "NA",
      reason: "셀러 미배정",
      fix: null,
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DealOfferDiagnosticSection", () => {
  it("커버리지와 손볼 항목 건수를 보여주고 점수는 보여주지 않는다", async () => {
    render(<DealOfferDiagnosticSection dealId="d1" />);

    expect(await screen.findByText("판정 4/5행")).toBeInTheDocument();
    // FAIL 1건만 조치 대상(UNKNOWN·NA 는 제외)
    expect(screen.getByText("손볼 항목 1건")).toBeInTheDocument();
    // 점수 표기(n/10)가 어디에도 없어야 한다 — M1 규율
    expect(screen.queryByText(/\/\s*10/)).not.toBeInTheDocument();
  });

  it("고쳐야 할 행이 목록 맨 위로 온다", async () => {
    render(<DealOfferDiagnosticSection dealId="d1" />);
    await screen.findByText("가격 우위");

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("가격 우위");
    expect(items[0]).toHaveTextContent("미충족");
    // PASS 는 맨 아래로 밀린다
    expect(items[items.length - 1]).toHaveTextContent("해당 없음");
  });

  it("미충족 행은 구체 수정을 함께 보여준다", async () => {
    render(<DealOfferDiagnosticSection dealId="d1" />);
    expect(
      await screen.findByText("→ 브랜드와 공급가를 재협상하세요"),
    ).toBeInTheDocument();
  });

  it("UNKNOWN 은 실패가 아니라 '확인 안 됨'으로 표시한다", async () => {
    render(<DealOfferDiagnosticSection dealId="d1" />);
    expect(await screen.findByText("확인 안 됨")).toBeInTheDocument();
  });

  it("옵션 딜이면 본품 기준 판정임을 밝힌다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...RESPONSE, resolvedFromParent: true }),
            { status: 200 },
          ),
      ),
    );
    render(<DealOfferDiagnosticSection dealId="opt1" />);
    expect(
      await screen.findByText("옵션 딜이라 본품 기준으로 판정했습니다"),
    ).toBeInTheDocument();
  });

  it("로드 실패는 조용히 넘어가지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "딜을 찾을 수 없습니다" }), {
            status: 404,
          }),
      ),
    );
    render(<DealOfferDiagnosticSection dealId="missing" />);
    expect(
      await screen.findByText("딜을 찾을 수 없습니다"),
    ).toBeInTheDocument();
  });

  it("다시 계산 버튼이 재조회한다", async () => {
    render(<DealOfferDiagnosticSection dealId="d1" />);
    await screen.findByText("판정 4/5행");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    await userEvent.click(
      screen.getByRole("button", { name: "오퍼 진단 다시 계산" }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("rows 없는 응답에 크래시하지 않고 에러로 표시한다", async () => {
    // 실제로 밟은 회귀: 딜 패널의 공통 fetch mock 이 `[]` 를 돌려주자
    // `[...data.rows]` 가 터져 패널 전체가 죽었다. 계약 변경·프록시 오류
    // 페이지에서도 같은 일이 난다 — 형태를 믿지 않는 것이 규율이다.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
    render(<DealOfferDiagnosticSection dealId="d1" />);
    expect(
      await screen.findByText("진단 응답 형식이 올바르지 않습니다"),
    ).toBeInTheDocument();
  });

  it("모르는 verdict 가 와도 목록을 렌더한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...RESPONSE,
              rows: [
                {
                  id: "FUTURE_ROW",
                  label: "미래의 행",
                  verdict: "SOMETHING_NEW",
                  reason: "서버가 새 판정을 추가했다",
                  fix: null,
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    render(<DealOfferDiagnosticSection dealId="d1" />);
    expect(await screen.findByText("미래의 행")).toBeInTheDocument();
  });
});

describe("수동 행 응답 (M3)", () => {
  const WITH_MANUAL = {
    ...RESPONSE,
    rows: [
      ...RESPONSE.rows,
      {
        id: "SCARCITY_TRUTH",
        label: "한정성 진위",
        verdict: "UNKNOWN",
        reason: "운영자 확인 필요",
        fix: "브랜드에 확보 수량을 확인하세요",
      },
    ],
  };

  it("수동 행에는 3택 버튼이 붙고 자동 행에는 붙지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(WITH_MANUAL), { status: 200 }),
      ),
    );
    render(<DealOfferDiagnosticSection dealId="d1" />);
    await screen.findByText("한정성 진위");

    // 수동 행 그룹만 존재 — 자동 행(가격 우위)엔 판정 버튼이 없다
    const group = screen.getByRole("group", {
      name: "한정성 진위 운영자 판정",
    });
    expect(group).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "가격 우위 운영자 판정" }),
    ).not.toBeInTheDocument();
    // PARTIAL 은 의도적으로 없다
    expect(within(group).getAllByRole("button")).toHaveLength(3);
    expect(within(group).queryByText("부분 충족")).not.toBeInTheDocument();
  });

  it("판정을 누르면 저장하고 재조회한다", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify(init?.method === "PUT" ? { answer: {} } : WITH_MANUAL),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DealOfferDiagnosticSection dealId="d1" />);
    await screen.findByText("한정성 진위");

    const group = screen.getByRole("group", {
      name: "한정성 진위 운영자 판정",
    });
    await userEvent.click(
      within(group).getByRole("button", { name: "확인함" }),
    );

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(JSON.parse((put![1] as RequestInit).body as string)).toMatchObject(
        { rowId: "SCARCITY_TRUTH", verdict: "PASS" },
      );
    });
  });

  it("저장 실패는 조용히 넘어가지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "PUT"
          ? new Response(JSON.stringify({ error: "저장 권한이 없습니다" }), {
              status: 403,
            })
          : new Response(JSON.stringify(WITH_MANUAL), { status: 200 }),
      ),
    );
    render(<DealOfferDiagnosticSection dealId="d1" />);
    await screen.findByText("한정성 진위");

    const group = screen.getByRole("group", {
      name: "한정성 진위 운영자 판정",
    });
    await userEvent.click(
      within(group).getByRole("button", { name: "미충족" }),
    );
    expect(await screen.findByText("저장 권한이 없습니다")).toBeInTheDocument();
  });
});

describe("점수 표시", () => {
  it("커버리지가 다 차면 점수를 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...RESPONSE,
              score: 8.5,
              coverage: { decided: 9, applicable: 9 },
            }),
            { status: 200 },
          ),
      ),
    );
    render(<DealOfferDiagnosticSection dealId="d1" />);
    expect(await screen.findByText("8.5/10")).toBeInTheDocument();
  });

  it("미확인이 있으면 점수 대신 그 사실을 밝힌다", async () => {
    render(<DealOfferDiagnosticSection dealId="d1" />);
    expect(
      await screen.findByText("미확인 항목이 있어 점수를 내지 않았습니다"),
    ).toBeInTheDocument();
  });
});
