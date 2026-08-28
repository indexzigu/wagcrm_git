import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignLaunchReadinessSection } from "@/components/crm/campaign-launch-readiness-section";

/**
 * 캠페인 오픈 준비 섹션(C2 M4b)의 계약.
 *
 * 화면에서 지켜야 하는 것:
 * - **BLOCK 이 FIX 위로 온다** — 사고 축을 성과 축 아래에 묻으면 운영자가
 *   법령 리스크를 스크롤 밖에서 놓친다.
 * - **오픈을 막는 UI 가 없다** — 판정을 보여주는 것까지가 일이다(스펙 §2).
 * - 응답 형태를 믿지 않는다 — items 가 없으면 캠페인 패널 전체가 죽는다.
 */

const FIX_RESPONSE = {
  campaignId: "c1",
  dealName: "테스트 공구",
  requiredDisclosureCount: 0,
  level: "FIX",
  daysUntilStart: 3,
  items: [
    {
      source: "OFFER",
      level: "FIX",
      message: "오퍼 미충족 1건 — 구성 차별",
      fix: "구성을 만드세요",
    },
    {
      source: "SETUP",
      level: "FIX",
      message: "주문관리 캠페인 등록이 안 됐습니다",
      fix: "주문관리에서 등록하세요",
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify(FIX_RESPONSE), { status: 200 }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CampaignLaunchReadinessSection", () => {
  it("등급과 항목을 보여준다", async () => {
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    expect(await screen.findByText("손볼 것 있음")).toBeInTheDocument();
    expect(screen.getByText("오퍼 미충족 1건 — 구성 차별")).toBeInTheDocument();
    expect(screen.getByText("→ 주문관리에서 등록하세요")).toBeInTheDocument();
  });

  /**
   * 표현 축은 검사할 본문(셀러에게 보낸 자료)이 있어야 돈다. 안 돌았을 때
   * **항목이 그냥 없으면 운영자는 "통과"로 읽는다** — 미검사와 무결점이 화면에서
   * 구분되지 않는 것이 이 축의 고유 실패 모드다(#174 가 근거 카드에서 만난 것과
   * 같은 종류).
   */
  describe("표현 축 미검사 사유", () => {
    const withGateSource = (over: Record<string, unknown>) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ ...FIX_RESPONSE, ...over }), {
              status: 200,
            }),
        ),
      );

    it("검사할 자료가 없으면 그 사실을 밝힌다", async () => {
      withGateSource({ claimGateSource: "NO_ASSET_DRAFT" });
      render(<CampaignLaunchReadinessSection campaignId="c1" />);
      expect(
        await screen.findByText(/표현 검사는 아직 돌지 않았습니다/),
      ).toBeInTheDocument();
    });

    it("검사가 돌았으면 안내를 띄우지 않는다 (소음 금지)", async () => {
      withGateSource({ claimGateSource: "ASSET_DRAFT" });
      render(<CampaignLaunchReadinessSection campaignId="c1" />);
      await screen.findByText("손볼 것 있음");
      expect(
        screen.queryByText(/표현 검사는 아직 돌지 않았습니다/),
      ).not.toBeInTheDocument();
    });

    it("브랜드용 자료의 미검사도 따로 밝힌다 — 한쪽만 검사됨이 검사됨으로 뭉개지면 안 된다", async () => {
      // 오너 결정(2026-08-02): 브랜드용도 판정 대상이다. 셀러용은 검사됐는데
      // 브랜드용이 안 됐을 때 화면이 침묵하면 부재가 통과처럼 읽힌다.
      withGateSource({
        claimGateSource: "ASSET_DRAFT",
        brandClaimGateSource: "NO_ASSET_DRAFT",
      });
      render(<CampaignLaunchReadinessSection campaignId="c1" />);
      expect(
        await screen.findByText(/브랜드용 자료는 아직 표현 검사를 받지 않았습니다/),
      ).toBeInTheDocument();
      // 셀러용은 검사됐으므로 그쪽 안내는 뜨지 않는다.
      expect(
        screen.queryByText(/표현 검사는 아직 돌지 않았습니다/),
      ).not.toBeInTheDocument();
    });

    it("브랜드용도 검사됐으면 안내를 띄우지 않는다 (소음 금지)", async () => {
      withGateSource({
        claimGateSource: "ASSET_DRAFT",
        brandClaimGateSource: "ASSET_DRAFT",
      });
      render(<CampaignLaunchReadinessSection campaignId="c1" />);
      await screen.findByText("손볼 것 있음");
      expect(
        screen.queryByText(/브랜드용 자료는 아직 표현 검사를/),
      ).not.toBeInTheDocument();
    });

    it("등록된 필수 고지 건수를 버리지 않는다", async () => {
      // 라우트가 주는데 화면이 쓰지 않던 값이다 — 안내에 녹여 살린다.
      withGateSource({
        claimGateSource: "NO_ASSET_DRAFT",
        requiredDisclosureCount: 3,
      });
      render(<CampaignLaunchReadinessSection campaignId="c1" />);
      expect(await screen.findByText(/필수 고지 3건/)).toBeInTheDocument();
    });

    it("고지가 0건이면 건수 대신 미등록으로 쓴다", async () => {
      withGateSource({
        claimGateSource: "NO_ASSET_DRAFT",
        requiredDisclosureCount: 0,
      });
      render(<CampaignLaunchReadinessSection campaignId="c1" />);
      expect(
        await screen.findByText(/필수 고지도 아직 등록되지 않았습니다/),
      ).toBeInTheDocument();
    });

    it("필드가 없는 옛 응답에는 아무 안내도 띄우지 않는다", async () => {
      // 배포 중 구버전 응답이 섞여도 없는 사실을 지어내지 않는다.
      render(<CampaignLaunchReadinessSection campaignId="c1" />);
      await screen.findByText("손볼 것 있음");
      expect(
        screen.queryByText(/표현 검사는 아직 돌지 않았습니다/),
      ).not.toBeInTheDocument();
    });
  });

  it("체크할 것이 없다는 사실을 밝힌다 (새 노동 0)", async () => {
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    expect(
      await screen.findByText(
        "이미 기록된 판정만 모았습니다. 따로 체크할 것은 없습니다.",
      ),
    ).toBeInTheDocument();
  });

  it("판매 시작까지 남은 일수를 방향까지 맞춰 보여준다", async () => {
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    expect(await screen.findByText("판매 시작 3일 전")).toBeInTheDocument();
  });

  it("판매일이 지났으면 지났다고 쓴다 (음수를 그대로 노출하지 않는다)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...FIX_RESPONSE, daysUntilStart: -5 }),
            { status: 200 },
          ),
      ),
    );
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    expect(await screen.findByText("판매 시작 5일 지남")).toBeInTheDocument();
  });

  it("BLOCK 항목이 FIX 위로 온다 — 사고 축을 묻지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...FIX_RESPONSE,
              level: "BLOCK",
              items: [
                ...FIX_RESPONSE.items,
                {
                  source: "CLAIMS",
                  level: "BLOCK",
                  message: "금지 표현 2건이 검출됐습니다",
                  fix: "표현 검사에서 바꾸세요",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    await screen.findByText("열기 전 조치 필요");

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("금지 표현 2건");
    expect(items[0]).toHaveTextContent("조치 필요");
  });

  it("걸리는 것이 없으면 준비됨만 보여주고 목록을 만들지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...FIX_RESPONSE, level: "SHIP", items: [] }),
            { status: 200 },
          ),
      ),
    );
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    expect(await screen.findByText("준비됨")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("오픈을 막는 버튼을 두지 않는다 (판정만 보여준다)", async () => {
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    await screen.findByText("손볼 것 있음");
    // 존재하는 버튼은 '다시 확인' 하나뿐이어야 한다
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("오픈 준비 다시 확인");
  });

  it("items 없는 응답에 크래시하지 않고 에러로 표시한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    expect(
      await screen.findByText("오픈 준비 응답 형식이 올바르지 않습니다"),
    ).toBeInTheDocument();
  });

  it("로드 실패는 조용히 넘어가지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "캠페인을 찾을 수 없습니다" }), {
            status: 404,
          }),
      ),
    );
    render(<CampaignLaunchReadinessSection campaignId="missing" />);
    expect(
      await screen.findByText("캠페인을 찾을 수 없습니다"),
    ).toBeInTheDocument();
  });

  it("다시 확인 버튼이 재조회한다", async () => {
    render(<CampaignLaunchReadinessSection campaignId="c1" />);
    await screen.findByText("손볼 것 있음");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    await userEvent.click(
      screen.getByRole("button", { name: "오픈 준비 다시 확인" }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
