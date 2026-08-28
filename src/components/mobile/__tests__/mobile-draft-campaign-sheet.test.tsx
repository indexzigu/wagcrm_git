// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileDraftCampaignSheet } from "../mobile-draft-campaign-sheet";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

/**
 * 예비 캠페인 생성 시트(§4 · Phase 4) 렌더 검증:
 * 이름 미리보기("딜 - 셀러" + 차수 자동 캡션), CTA 비활성 조건,
 * 검색 파라미터(status=CONFIRMED), 제출 페이로드.
 */

const SELLERS = [
  { id: "seller-1", name: "김하늘", alias: "하늘맘" },
  { id: "seller-2", name: "박미나", alias: null },
];

const DEALS = [
  { id: "deal-1", dealName: "비타민C 앰플", brandName: "코링코", status: "CONFIRMED" },
];

const DRAFT_RESPONSE = {
  id: "camp-new",
  dealId: "deal-1",
  sellerId: "seller-1",
  campaignName: "비타민C 앰플 - 하늘맘 2차",
  roundNumber: 2,
  startDate: "2026-07-10T00:00:00.000Z",
  endDate: "2026-07-10T00:00:00.000Z",
  status: "PROPOSAL",
  dealName: "비타민C 앰플",
  sellerName: "하늘맘",
};

const fetchMock = vi.fn();

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => payload,
  };
}

beforeEach(() => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/search/sellers")) return jsonResponse({ results: SELLERS });
    if (url.includes("/api/search/deals")) return jsonResponse({ results: DEALS });
    if (url.includes("/api/mobile/campaigns/draft")) {
      return jsonResponse(DRAFT_RESPONSE, 201);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderSheet(overrides: Partial<Parameters<typeof MobileDraftCampaignSheet>[0]> = {}) {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <MobileDraftCampaignSheet
      open
      onOpenChange={onOpenChange}
      initialStartYmd="2026-07-10"
      onCreated={onCreated}
      {...overrides}
    />,
  );
  return { onCreated, onOpenChange };
}

async function pickSellerAndDeal(user: ReturnType<typeof userEvent.setup>) {
  // 열림 즉시 최근 목록(빈 검색어) 로드 — 디바운스 없이 도착
  await user.click(await screen.findByRole("button", { name: /하늘맘/ }));
  await user.click(await screen.findByRole("button", { name: /비타민C 앰플/ }));
}

describe("MobileDraftCampaignSheet — 초기 상태", () => {
  it("기간은 선택일 프리필, 종료 기본=시작일", async () => {
    renderSheet();

    expect(screen.getByLabelText("시작일")).toHaveValue("2026-07-10");
    expect(screen.getByLabelText("종료일")).toHaveValue("2026-07-10");
  });

  it("CTA 는 셀러·딜 선택 전에는 비활성", async () => {
    renderSheet();

    expect(screen.getByRole("button", { name: "예비 일정 만들기" })).toBeDisabled();
  });

  it("딜 검색은 status=CONFIRMED 로 요청한다", async () => {
    renderSheet();

    await waitFor(() => {
      const dealCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/api/search/deals"),
      );
      expect(dealCall).toBeTruthy();
      expect(String(dealCall?.[0])).toContain("status=CONFIRMED");
    });
  });

  // §1 공통 시트 헤더 — 정산 대기 시트와 같은 셸(MobileSheetHeader)을 공유한다
  it("헤더는 제목 + 닫기 버튼을 탭 상단바 위계로 렌더한다", async () => {
    renderSheet();

    // 캡션 슬롯은 제거됐다(오너 지시 2026-08-26) — 재유입 방지용 역단언.
    expect(screen.queryByText("WAG CRM")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "예비 일정 만들기" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "예비 일정 만들기 닫기" }),
    ).toBeInTheDocument();
  });

  it("셀러 결과는 alias 우선으로 표시한다", async () => {
    renderSheet();

    expect(await screen.findByText("하늘맘")).toBeInTheDocument();
    // alias 없는 셀러는 실명 표시
    expect(screen.getByText("박미나")).toBeInTheDocument();
  });
});

describe("MobileDraftCampaignSheet — 이름 미리보기", () => {
  it("딜·셀러 선택 시 '딜 - 셀러' 미리보기와 차수 자동 캡션을 보여준다", async () => {
    const user = userEvent.setup();
    renderSheet();

    await pickSellerAndDeal(user);

    expect(screen.getByText("비타민C 앰플 - 하늘맘")).toBeInTheDocument();
    expect(screen.getByText("(차수는 자동 계산)")).toBeInTheDocument();
    // 이름 직접 입력란은 없다 — 미리보기 전용
    expect(screen.queryByLabelText(/캠페인명/)).not.toBeInTheDocument();
  });

  it("선택이 완성되면 CTA 가 활성화된다", async () => {
    const user = userEvent.setup();
    renderSheet();

    await pickSellerAndDeal(user);

    expect(screen.getByRole("button", { name: "예비 일정 만들기" })).toBeEnabled();
  });
});

describe("MobileDraftCampaignSheet — 제출", () => {
  it("CTA 탭 시 draft POST 후 onCreated·시트 닫기", async () => {
    const user = userEvent.setup();
    const { onCreated, onOpenChange } = renderSheet();

    await pickSellerAndDeal(user);
    await user.click(screen.getByRole("button", { name: "예비 일정 만들기" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(DRAFT_RESPONSE));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const postCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/mobile/campaigns/draft"),
    );
    expect(postCall?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      dealId: "deal-1",
      sellerId: "seller-1",
      startDate: "2026-07-10",
      endDate: "2026-07-10",
    });
  });

  it("실패 시 서버 에러 메시지를 표면화하고 시트를 유지한다", async () => {
    const user = userEvent.setup();
    const { onCreated, onOpenChange } = renderSheet();
    await pickSellerAndDeal(user);

    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ error: "해당 딜을 찾을 수 없습니다." }, 404),
    );

    await user.click(screen.getByRole("button", { name: "예비 일정 만들기" }));

    expect(await screen.findByText("해당 딜을 찾을 수 없습니다.")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
