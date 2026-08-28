import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignShortLinkCard } from "@/components/crm/campaign-short-link-card";
import type { CampaignRow } from "@/lib/crm-types";

/**
 * 브랜드사몰 캠페인의 링크 입력 경로.
 *
 * 이 카드가 유일한 입구다 — nt_* 카드는 자사 네이버 전용이라 브랜드사몰에서는 접혀 있다.
 * 입력칸이 없으면 운영자는 목적지를 저장할 방법이 아예 없고, 카드는 "먼저 저장하라"고
 * 말하면서 저장 수단을 주지 않는 막다른 골목이 된다.
 */

function makeCampaign(overrides: Partial<CampaignRow> = {}) {
  return {
    id: "c1",
    // 캠페인 생성이 박아 넣는 자리표시자 — 모든 캠페인이 이 상태로 태어난다.
    baseNaverLink: "https://smartstore.naver.com",
    generatedTrackingLink: "https://smartstore.naver.com/?nt_source=INSTAGRAM",
    ...overrides,
  } as CampaignRow;
}

const noop = () => {};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // 목록 조회는 빈 배열 — "아직 발급 안 됨" 상태에서 시작한다.
  fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CampaignShortLinkCard — 목적지 입력", () => {
  it("상품 링크가 미확정이면 입력칸을 보여준다", async () => {
    render(
      <CampaignShortLinkCard
        campaign={makeCampaign()}
        channelUnassigned={false}
        onCampaignUpdated={noop}
      />,
    );
    expect(await screen.findByLabelText("상품 페이지 주소")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장하고 발급" })).toBeInTheDocument();
  });

  it("도메인만 입력하면 인라인 오류를 띄우고 저장을 시도하지 않는다", async () => {
    // 지금은 도메인만 저장돼도 통과했다가 발급 단계에서야 서버가 거절한다.
    // 자리표시자를 저장 자체에서 막는 것이 실사고(2026-07-31)의 입력 측 방어다.
    render(
      <CampaignShortLinkCard
        campaign={makeCampaign()}
        channelUnassigned={false}
        onCampaignUpdated={noop}
      />,
    );
    const input = await screen.findByLabelText("상품 페이지 주소");
    await userEvent.type(input, "https://brand.example.com");
    await userEvent.click(screen.getByRole("button", { name: "저장하고 발급" }));

    expect(await screen.findByText(/상품 페이지 주소가 아닙니다/)).toBeInTheDocument();
    const writes = fetchMock.mock.calls.filter(
      ([, init]) => init && init.method && init.method !== "GET",
    );
    expect(writes).toHaveLength(0);
  });

  it("실패 사유를 뭉치지 않는다 — 스킴 누락과 http/https 아님을 구분해 말한다", async () => {
    // 경로가 멀쩡한데 스킴만 없는 입력에 "도메인만 넣었다"는 문구가 뜨면 운영자가
    // 엉뚱한 곳을 고친다. isPlaceholderTargetUrl 하나로 뭉치면 그렇게 된다.
    render(
      <CampaignShortLinkCard
        campaign={makeCampaign()}
        channelUnassigned={false}
        onCampaignUpdated={noop}
      />,
    );
    const input = await screen.findByLabelText("상품 페이지 주소");
    const issue = screen.getByRole("button", { name: "저장하고 발급" });

    await userEvent.type(input, "brand.example.com/view/good/AbC123");
    await userEvent.click(issue);
    expect(await screen.findByText(/유효한 URL 형식이 아닙니다/)).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "javascript:alert(1)");
    await userEvent.click(issue);
    expect(await screen.findByText("http/https 주소만 등록할 수 있습니다")).toBeInTheDocument();

    // 어느 쪽도 캠페인에 저장되지 않는다
    const writes = fetchMock.mock.calls.filter(
      ([, init]) => init && init.method && init.method !== "GET",
    );
    expect(writes).toHaveLength(0);
  });

  it("이미 발급된 링크가 있으면 입력칸을 보여주지 않는다", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              code: "abcd2345",
              shortUrl: "https://go.ygrd.kr/abcd2345",
              clickCount: 0,
              visitDays: 0,
            },
          ]),
          { status: 200 },
        ),
    );
    render(
      <CampaignShortLinkCard
        campaign={makeCampaign()}
        channelUnassigned={false}
        onCampaignUpdated={noop}
      />,
    );
    expect(await screen.findByText("https://go.ygrd.kr/abcd2345")).toBeInTheDocument();
    expect(screen.queryByLabelText("상품 페이지 주소")).not.toBeInTheDocument();
  });

  it("정상 상품 URL 이면 저장한 뒤 발급까지 이어간다", async () => {
    const updated = makeCampaign({ baseNaverLink: "https://brand.example.com/view/good/AbC123" });
    const onCampaignUpdated = vi.fn();

    fetchMock.mockImplementation(async (_input: unknown, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify([]), { status: 200 });
      if (method === "PATCH") return new Response(JSON.stringify(updated), { status: 200 });
      // POST /api/tracked-links — 발급
      return new Response(
        JSON.stringify({ code: "abcd2345", shortUrl: "https://go.ygrd.kr/abcd2345" }),
        { status: 201 },
      );
    });

    render(
      <CampaignShortLinkCard
        campaign={makeCampaign()}
        channelUnassigned={false}
        onCampaignUpdated={onCampaignUpdated}
      />,
    );
    await userEvent.type(
      await screen.findByLabelText("상품 페이지 주소"),
      "https://brand.example.com/view/good/AbC123",
    );
    await userEvent.click(screen.getByRole("button", { name: "저장하고 발급" }));

    // 발급된 링크가 화면에 뜬다
    expect(await screen.findByText("https://go.ygrd.kr/abcd2345")).toBeInTheDocument();
    // 패널이 미확정 → 확정으로 다시 그려질 수 있게 알린다
    expect(onCampaignUpdated).toHaveBeenCalledWith(updated);
    // 저장이 발급보다 먼저다 — 순서가 뒤집히면 서버가 옛 목적지로 발급한다
    const methods = fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.indexOf("PATCH")).toBeLessThan(methods.indexOf("POST"));
  });

  it("저장이 끝나기 전에 Enter 를 다시 눌러도 재실행하지 않는다", async () => {
    // 버튼은 disabled 로 막히지만 Enter 는 그 가드를 우회한다. 중복 실행되면 서버의
    // ensureCampaignTrackedLink 가 findFirst → create 를 트랜잭션 없이 하고
    // salesCampaignId 에 unique 제약도 없어서, 캠페인 하나에 링크가 2행 생긴다 —
    // 셀러가 이미 뿌린 링크의 통계가 그 시점부터 갈라진다("캠페인당 1개 멱등" 위반).
    const updated = makeCampaign({ baseNaverLink: "https://brand.example.com/view/good/AbC123" });
    let releasePatch: () => void = () => {};
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });

    fetchMock.mockImplementation(async (_input: unknown, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify([]), { status: 200 });
      if (method === "PATCH") {
        await patchGate; // 저장을 붙잡아 둔다 — 그 사이에 두 번째 Enter 가 들어온다
        return new Response(JSON.stringify(updated), { status: 200 });
      }
      return new Response(
        JSON.stringify({ code: "abcd2345", shortUrl: "https://go.ygrd.kr/abcd2345" }),
        { status: 201 },
      );
    });

    render(
      <CampaignShortLinkCard
        campaign={makeCampaign()}
        channelUnassigned={false}
        onCampaignUpdated={noop}
      />,
    );
    const input = await screen.findByLabelText("상품 페이지 주소");
    await userEvent.type(input, "https://brand.example.com/view/good/AbC123");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");
    releasePatch();

    expect(await screen.findByText("https://go.ygrd.kr/abcd2345")).toBeInTheDocument();
    const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(patches).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  it("저장이 실패하면 발급을 시도하지 않는다", async () => {
    fetchMock.mockImplementation(async (_input: unknown, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ error: "Campaign not found" }), { status: 400 });
    });

    render(
      <CampaignShortLinkCard
        campaign={makeCampaign()}
        channelUnassigned={false}
        onCampaignUpdated={noop}
      />,
    );
    await userEvent.type(
      await screen.findByLabelText("상품 페이지 주소"),
      "https://brand.example.com/view/good/AbC123",
    );
    await userEvent.click(screen.getByRole("button", { name: "저장하고 발급" }));

    // 서버의 영문 오류를 그대로 노출하지 않는다(preferServerError 미사용)
    expect(await screen.findByText("링크 저장에 실패했습니다")).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(0);
  });
});

describe("CampaignShortLinkCard — 미리보기 새로고침", () => {
  it("발급된 링크에는 새로고침 액션과 현재 미리보기를 보여준다", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              code: "Kp7mQ2xd",
              shortUrl: "https://go.ygrd.kr/Kp7mQ2xd",
              clickCount: 3,
              visitDays: 2,
              ogTitle: "여름 공구",
              ogImage: null,
              ogFetchedAt: new Date().toISOString(),
            },
          ]),
          { status: 200 },
        ),
    );
    render(
      <CampaignShortLinkCard
        campaign={makeCampaign({ baseNaverLink: "https://brand.example.com/p/1" })}
        channelUnassigned={false}
        onCampaignUpdated={noop}
      />,
    );

    expect(await screen.findByRole("button", { name: /새로고침/ })).toBeInTheDocument();
    expect(screen.getByText("여름 공구")).toBeInTheDocument();
  });

  it("링크가 없으면 새로고침 액션을 노출하지 않는다", async () => {
    // 없는 링크의 미리보기를 말하지 않는다 (P2 Unconfirmed Link Guard).
    render(
      <CampaignShortLinkCard
        campaign={makeCampaign({ baseNaverLink: "https://brand.example.com/p/1" })}
        channelUnassigned={false}
        onCampaignUpdated={noop}
      />,
    );
    await screen.findByRole("button", { name: "단축링크 발급" });
    expect(screen.queryByRole("button", { name: /새로고침/ })).not.toBeInTheDocument();
  });
});
