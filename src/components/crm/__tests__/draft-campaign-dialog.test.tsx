import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DraftCampaignDialog } from "../draft-campaign-dialog";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

/**
 * 데스크톱 예비 일정 다이얼로그 — 모바일 시트와 동일 계약 검증:
 * 선택일 프리필, CTA 비활성 조건, status=CONFIRMED 검색, alias 우선,
 * 이름 미리보기(입력란 없음), 제출 페이로드, 실패 표면화.
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
  startDate: "2026-07-20T00:00:00.000Z",
  endDate: "2026-07-20T00:00:00.000Z",
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

function renderDialog(
  overrides: Partial<Parameters<typeof DraftCampaignDialog>[0]> = {},
) {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <DraftCampaignDialog
      open
      onOpenChange={onOpenChange}
      initialStartYmd="2026-07-20"
      onCreated={onCreated}
      {...overrides}
    />,
  );
  return { onCreated, onOpenChange };
}

async function pickSellerAndDeal(user: ReturnType<typeof userEvent.setup>) {
  // 결과 오버레이는 입력 focus 중에만 뜬다(다이얼로그 높이 안정화). 먼저 focus.
  await user.click(screen.getByLabelText("셀러"));
  await user.click(await screen.findByRole("button", { name: /하늘맘/ }));
  await user.click(screen.getByLabelText(/^딜/));
  await user.click(await screen.findByRole("button", { name: /비타민C 앰플/ }));
}

describe("DraftCampaignDialog — 초기 상태", () => {
  it("기간은 클릭일 프리필, 종료 기본=시작일, 헤더에 선택일 표기", async () => {
    renderDialog();

    expect(screen.getByLabelText("시작일")).toHaveValue("2026-07-20");
    expect(screen.getByLabelText("종료일")).toHaveValue("2026-07-20");
    // 컨텍스트 스트립 — 요일 포함 "7월 20일(월)에 추가합니다"
    expect(screen.getByText(/7월 20일\(월\)에 추가합니다/)).toBeInTheDocument();
  });

  it("CTA 는 셀러·딜 선택 전에는 비활성", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "예비 일정 만들기" })).toBeDisabled();
  });

  it("딜 검색은 status=CONFIRMED 로 요청한다", async () => {
    renderDialog();

    await waitFor(() => {
      const dealCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/api/search/deals"),
      );
      expect(dealCall).toBeTruthy();
      expect(String(dealCall?.[0])).toContain("status=CONFIRMED");
    });
  });

  it("셀러 결과는 alias 우선으로 표시한다", async () => {
    const user = userEvent.setup();
    renderDialog();

    // 결과 오버레이는 입력 focus 중에만 노출
    await user.click(screen.getByLabelText("셀러"));
    expect(await screen.findByText("하늘맘")).toBeInTheDocument();
    expect(screen.getByText("박미나")).toBeInTheDocument();
  });
});

describe("DraftCampaignDialog — 이름 미리보기", () => {
  it("딜·셀러 선택 시 '딜 - 셀러' 미리보기와 차수 자동 캡션, 이름 입력란 없음", async () => {
    const user = userEvent.setup();
    renderDialog();

    await pickSellerAndDeal(user);

    expect(screen.getByText("비타민C 앰플 - 하늘맘")).toBeInTheDocument();
    expect(screen.getByText("캠페인명 자동(차수 포함)")).toBeInTheDocument();
    expect(screen.queryByLabelText(/캠페인명/)).not.toBeInTheDocument();
  });

  it("선택이 완성되면 CTA 가 활성화된다", async () => {
    const user = userEvent.setup();
    renderDialog();

    await pickSellerAndDeal(user);

    expect(screen.getByRole("button", { name: "예비 일정 만들기" })).toBeEnabled();
  });
});

describe("DraftCampaignDialog — 제출", () => {
  it("CTA 클릭 시 draft POST 후 onCreated·다이얼로그 닫기", async () => {
    const user = userEvent.setup();
    const { onCreated, onOpenChange } = renderDialog();

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
      startDate: "2026-07-20",
      endDate: "2026-07-20",
    });
  });

  it("실패 시 서버 에러 메시지를 표면화하고 다이얼로그를 유지한다", async () => {
    const user = userEvent.setup();
    const { onCreated, onOpenChange } = renderDialog();
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
