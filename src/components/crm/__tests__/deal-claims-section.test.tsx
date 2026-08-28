// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DealClaimsSection } from "@/components/crm/deal-claims-section";

/**
 * 딜 표현 관리 섹션(C1 M2b)의 계약.
 *
 * 여기서 지키는 핵심은 **승인 규율**이다 — 신규 등록은 PROPOSED 에서
 * 출발하고, 근거 미확보 승인 거부(서버 판정)는 화면에 그대로 드러나야 한다.
 * 조용히 성공한 것처럼 보이면 근거 없는 표현이 승인된 채로 자료 생성에
 * 흘러든다.
 */

const CLAIM = {
  id: "c1",
  kind: "APPROVED_CLAIM" as const,
  text: "국내산 원료 100%",
  evidence: "시험성적서 2026-001",
  evidenceType: "MEASURED" as const,
  status: "PROPOSED" as const,
  reviewBy: null,
  source: "운영자 직접",
};

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function mockFetch(handlers: Record<string, FetchHandler>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const key = `${method} ${url.split("?")[0]}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unhandled: ${key}`);
    // 인자를 그대로 넘긴다 — 테스트가 요청 본문을 검증할 수 있어야 한다.
    return handler(input, init);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DealClaimsSection", () => {
  it("등록된 표현이 없으면 안내를 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deals/d1/claims": () => json({ category: null, claims: [] }),
      }),
    );
    render(<DealClaimsSection dealId="d1" />);

    expect(
      await screen.findByText(/등록된 표현이 없습니다/),
    ).toBeInTheDocument();
  });

  it("클레임을 상태·종류·근거유형과 함께 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deals/d1/claims": () =>
          json({ category: "FOOD", claims: [CLAIM] }),
      }),
    );
    render(<DealClaimsSection dealId="d1" />);

    expect(await screen.findByText("국내산 원료 100%")).toBeInTheDocument();
    // 등록 폼의 Select 에도 같은 라벨이 있으므로 목록 안으로 스코프를 좁힌다.
    const list = within(screen.getByLabelText("등록된 표현 목록"));
    expect(list.getByText("검토 대기")).toBeInTheDocument();
    expect(list.getByText("승인 소구점")).toBeInTheDocument();
    expect(list.getByText("실측 근거")).toBeInTheDocument();
    expect(list.getByText(/시험성적서 2026-001/)).toBeInTheDocument();
  });

  it("근거 미확보 승인 거부(서버 400)를 화면에 드러낸다", async () => {
    const needsSource = { ...CLAIM, evidenceType: "NEEDS_SOURCE" as const };
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deals/d1/claims": () =>
          json({ category: null, claims: [needsSource] }),
        "PATCH /api/deals/d1/claims": () =>
          json(
            { error: "근거 미확보(NEEDS_SOURCE) 상태로는 승인할 수 없습니다" },
            400,
          ),
      }),
    );
    const user = userEvent.setup();
    render(<DealClaimsSection dealId="d1" />);

    await user.click(await screen.findByRole("button", { name: "승인" }));

    expect(
      await screen.findByText(/근거 미확보.*승인할 수 없습니다/),
    ).toBeInTheDocument();
  });

  it("신규 등록은 PROPOSED 로 보내고 목록을 다시 읽는다", async () => {
    const post = vi.fn(() => json(CLAIM, 201));
    let getCount = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deals/d1/claims": () => {
          getCount += 1;
          return json({ category: null, claims: [] });
        },
        "POST /api/deals/d1/claims": post,
      }),
    );
    const user = userEvent.setup();
    render(<DealClaimsSection dealId="d1" />);
    await screen.findByText(/등록된 표현이 없습니다/);

    await user.type(screen.getByLabelText("표현"), "무농약 재배");
    await user.click(screen.getByRole("button", { name: /검토 대기로 등록/ }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // 등록 후 재조회로 목록이 갱신된다.
    await waitFor(() => expect(getCount).toBeGreaterThan(1));
  });

  it("AI 추출 후보는 고른 것만 검토 대기로 등록한다", async () => {
    const post = vi.fn(() => json(CLAIM, 201));
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deals/d1/claims": () => json({ category: null, claims: [] }),
        "POST /api/deals/d1/claims/extract": () =>
          json({
            truncated: false,
            candidates: [
              {
                kind: "APPROVED_CLAIM",
                text: "국내산 원료",
                evidence: null,
                evidenceType: "USER_PROVIDED",
                quote: "국내산 원료를 씁니다",
              },
              {
                kind: "BANNED_PHRASE",
                text: "면역력 강화",
                evidence: null,
                evidenceType: "NEEDS_SOURCE",
                quote: null,
              },
            ],
          }),
        "POST /api/deals/d1/claims": post,
      }),
    );
    const user = userEvent.setup();
    render(<DealClaimsSection dealId="d1" />);
    await screen.findByText(/등록된 표현이 없습니다/);

    await user.click(
      screen.getByRole("button", { name: /상품자료에서 후보 뽑기/ }),
    );
    await user.type(screen.getByLabelText("상품자료"), "국내산 원료를 씁니다");
    await user.click(screen.getByRole("button", { name: /^후보 뽑기$/ }));

    await screen.findByLabelText("추출 후보 목록");
    // 기본은 전부 미선택 — 검토 없이 일괄 등록되는 흐름을 만들지 않는다.
    const registerButton = screen.getByRole("button", {
      name: /선택 0건 검토 대기로 등록/,
    });
    expect(registerButton).toBeDisabled();

    await user.click(screen.getByLabelText("후보 선택: 국내산 원료"));
    await user.click(
      screen.getByRole("button", { name: /선택 1건 검토 대기로 등록/ }),
    );

    // 고른 1건만 등록되고, source 는 AI 추출로 남는다.
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (post.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body).toMatchObject({
      kind: "APPROVED_CLAIM",
      text: "국내산 원료",
      source: "AI 추출",
    });
  });

  it("등록 도중 실패하면 성공분을 선택에서 빼 재시도 시 중복되지 않는다", async () => {
    // 2건을 고르고, 첫 건은 성공·둘째 건은 실패시킨다.
    let postCount = 0;
    const post = vi.fn(() => {
      postCount += 1;
      return postCount === 1
        ? json(CLAIM, 201)
        : json({ error: "등록에 실패했습니다" }, 500);
    });
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deals/d1/claims": () => json({ category: null, claims: [] }),
        "POST /api/deals/d1/claims/extract": () =>
          json({
            truncated: false,
            candidates: [
              {
                kind: "APPROVED_CLAIM",
                text: "국내산 원료",
                evidence: null,
                evidenceType: "USER_PROVIDED",
                quote: null,
              },
              {
                kind: "APPROVED_CLAIM",
                text: "무농약 재배",
                evidence: null,
                evidenceType: "USER_PROVIDED",
                quote: null,
              },
            ],
          }),
        "POST /api/deals/d1/claims": post,
      }),
    );
    const user = userEvent.setup();
    render(<DealClaimsSection dealId="d1" />);
    await screen.findByText(/등록된 표현이 없습니다/);

    await user.click(
      screen.getByRole("button", { name: /상품자료에서 후보 뽑기/ }),
    );
    await user.type(screen.getByLabelText("상품자료"), "자료");
    await user.click(screen.getByRole("button", { name: /^후보 뽑기$/ }));
    await screen.findByLabelText("추출 후보 목록");

    await user.click(screen.getByLabelText("후보 선택: 국내산 원료"));
    await user.click(screen.getByLabelText("후보 선택: 무농약 재배"));
    await user.click(
      screen.getByRole("button", { name: /선택 2건 검토 대기로 등록/ }),
    );

    // 실패를 알리고, 성공한 1건은 선택에서 빠진다 → 재시도해도 중복 등록 없음.
    expect(await screen.findByText(/등록에 실패했습니다/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /선택 1건 검토 대기로 등록/ }),
      ).toBeInTheDocument(),
    );
  });

  it("추출 실패는 삼키지 않고 사유를 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deals/d1/claims": () => json({ category: null, claims: [] }),
        "POST /api/deals/d1/claims/extract": () =>
          json({ error: "Gemini API 키가 서버에 설정되지 않았습니다" }, 502),
      }),
    );
    const user = userEvent.setup();
    render(<DealClaimsSection dealId="d1" />);
    await screen.findByText(/등록된 표현이 없습니다/);

    await user.click(
      screen.getByRole("button", { name: /상품자료에서 후보 뽑기/ }),
    );
    await user.type(screen.getByLabelText("상품자료"), "자료");
    await user.click(screen.getByRole("button", { name: /^후보 뽑기$/ }));

    expect(
      await screen.findByText(/Gemini API 키가 서버에/),
    ).toBeInTheDocument();
  });

  it("카테고리 저장이 실패하면 되돌리고 알린다(무음 성공 위장 금지)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/deals/d1/claims": () =>
          json({ category: "FOOD", claims: [] }),
        "PATCH /api/deals/d1": () => json({ error: "fail" }, 500),
      }),
    );
    const user = userEvent.setup();
    render(<DealClaimsSection dealId="d1" />);
    await screen.findByText(/등록된 표현이 없습니다/);

    await user.click(screen.getByLabelText("상품 카테고리"));
    await user.click(screen.getByRole("option", { name: "화장품" }));

    expect(await screen.findByText(/카테고리 저장에 실패/)).toBeInTheDocument();
  });
});
