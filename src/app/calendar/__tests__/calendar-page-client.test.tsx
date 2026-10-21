// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CalendarPageClient } from "../calendar-page-client";
import type { CalendarCampaign } from "@/components/crm/calendar-view";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
const pushMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

// 페이지가 예비 일정 생성 후 공백 브리핑 갱신에 useRouter().refresh()를 쓴다.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

// 현재 월(로컬 기준) — 컴포넌트가 new Date()로 초기 월을 잡으므로 픽스처도 같은 기준으로 생성
function currentYm(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function makeCampaign(overrides: Partial<CalendarCampaign> = {}): CalendarCampaign {
  const ym = currentYm();
  return {
    id: "camp-1",
    dealName: "프리미엄 마린콜라겐",
    sellerName: "하늘언니",
    sellerId: "seller-1",
    startDate: `${ym}-05T00:00:00.000Z`,
    endDate: `${ym}-20T00:00:00.000Z`,
    status: "ACTIVE",
    settlementSales: null,
    actualSales: null,
    sellerExpense: null,
    actualPayoutAmount: null,
    settlementGoodsCost: null,
    ...overrides,
  };
}

function stubFetch(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CalendarPageClient 응답 파싱 (버그 회귀: 항상 빈 달력)", () => {
  it("API의 { campaigns } 객체 응답에서 배열을 꺼내 렌더한다", async () => {
    // route.ts는 NextResponse.json({ campaigns })로 감싸 반환 — 배열 캐스팅하면 항상 빈 달력이 됐다
    const fetchMock = stubFetch({ campaigns: [makeCampaign()] });

    render(<CalendarPageClient />);

    // 바 라벨은 이제 "딜명 · 셀러명" 조합 — 딜명이 부분 문자열로 포함된다.
    // 캠페인이 여러 주(week)에 걸치면 주마다 바가 렌더되므로 복수 매칭 허용
    expect((await screen.findAllByText(/프리미엄 마린콜라겐/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("이 달에 진행되는 캠페인 없음")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/api/campaigns/calendar?month=${currentYm()}`);
  });

  it("campaigns가 빈 배열이면 빈 상태 문구를 보여준다", async () => {
    stubFetch({ campaigns: [] });

    render(<CalendarPageClient />);

    expect(await screen.findByText("이 달에 진행되는 캠페인 없음")).toBeInTheDocument();
  });

  // ⚠️ 종전 이 자리는 「비정상 응답이면 빈 배열로 폴백」을 고정했다 — 그 폴백이 곧 「조회가
  // 실패했는데 일정이 없는 달처럼 보이는」 결함이었다(interfaces 점검 #9, 2026-09-24).
  it("campaigns 필드가 없는 비정상 응답은 빈 달이 아니라 조회 실패로 알린다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({});

    render(<CalendarPageClient />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("캠페인을 불러오지 못했습니다.");
    expect(screen.queryByText("이 달에 진행되는 캠페인 없음")).not.toBeInTheDocument();
  });

  it("「다시 불러오기」는 같은 달을 다시 조회하고, 성공하면 안내를 거둔다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValue({ ok: true, json: async () => ({ campaigns: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<CalendarPageClient />);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));

    expect(await screen.findByText("이 달에 진행되는 캠페인 없음")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/campaigns/calendar?month=${currentYm()}`);
  });
});

// [캘린더수집] 「캘린더에서 가져오기」 — 30분 수집을 기다리지 않고 지금 한 회차를 돈다.
describe("CalendarPageClient — 캘린더에서 가져오기", () => {
  function routeFetch(scanResponse: { ok: boolean; status?: number; body: unknown }, gate?: Promise<void>) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/integrations/google-calendar/inbound-scan") {
        await gate;
        return {
          ok: scanResponse.ok,
          status: scanResponse.status ?? 200,
          json: async () => scanResponse.body,
        };
      }
      return Promise.resolve({ ok: true, json: async () => ({ campaigns: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("전체 동기화 옆에 같은 모양의 버튼이 있고, 누르면 수집 라우트를 POST 로 부르고 결과를 토스트로 알린다", async () => {
    toastMock.success.mockReset();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = routeFetch(
      {
        ok: true,
        body: { ok: true, proposed: 2, skippedUnparsed: 1, alreadyHandled: 3, adoptedNoop: 0, dropped: 0, hintDeferred: 0, errors: 0 },
      },
      gate,
    );
    render(<CalendarPageClient />);

    const button = screen.getByRole("button", { name: "캘린더에서 가져오기" });
    const sync = screen.getByRole("button", { name: "구글 캘린더 전체 동기화" });
    expect(button.getAttribute("data-variant")).toBe(sync.getAttribute("data-variant"));
    expect(button.getAttribute("data-size")).toBe(sync.getAttribute("data-size"));

    fireEvent.click(button);
    // 응답 전에는 눌린 상태로 막혀 있다(연타 방지)
    expect(await screen.findByRole("button", { name: "가져오는 중..." })).toBeDisabled();
    release();
    await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    const [message, options] = toastMock.success.mock.calls[0];
    expect(message).toBe("기안 2건 올림 · 해석 못 함 1건 · 이미 처리 3건");
    // 기안을 올렸으면 토스트에서 바로 결재함으로 간다
    expect(options.action.label).toBe("결재함 열기");
    options.action.onClick();
    expect(pushMock).toHaveBeenCalledWith("/approvals");
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/google-calendar/inbound-scan", { method: "POST" });
    expect(await screen.findByRole("button", { name: "캘린더에서 가져오기" })).not.toBeDisabled();
  });

  it("캘린더 연결이 없으면 설정 위치를 알려 주는 오류 토스트", async () => {
    toastMock.error.mockReset();
    routeFetch({
      ok: false,
      status: 401,
      body: { ok: false, skipped: "not_connected", error: "구글 캘린더가 연결되어 있지 않습니다. 설정 > 외부 연동 진단에서 연동하세요." },
    });
    render(<CalendarPageClient />);
    fireEvent.click(screen.getByRole("button", { name: "캘린더에서 가져오기" }));
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.error.mock.calls[0][0]).toContain("외부 연동 진단");
  });

  it("올린 기안이 없으면 결재함 버튼을 달지 않는다", async () => {
    toastMock.success.mockReset();
    routeFetch({
      ok: true,
      body: { ok: true, proposed: 0, skippedUnparsed: 0, alreadyHandled: 2, adoptedNoop: 0, dropped: 0, hintDeferred: 0, errors: 0 },
    });
    render(<CalendarPageClient />);
    fireEvent.click(screen.getByRole("button", { name: "캘린더에서 가져오기" }));
    await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(toastMock.success.mock.calls[0][1]).toBeUndefined();
  });

  it("다른 가져오기가 도는 중이면 「이미 가져오는 중」 안내", async () => {
    toastMock.info.mockReset();
    routeFetch({ ok: true, body: { ok: true, skipped: "busy", proposed: 0, skippedUnparsed: 0, alreadyHandled: 0, adoptedNoop: 0, dropped: 0, hintDeferred: 0, errors: 0 } });
    render(<CalendarPageClient />);
    fireEvent.click(screen.getByRole("button", { name: "캘린더에서 가져오기" }));
    await vi.waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith("이미 가져오는 중입니다. 잠시 뒤 다시 눌러 주세요."),
    );
  });

  it("JSON 이 아닌 오류 응답이면 기본 오류 문구를 띄운다(파싱 예외 문구가 새지 않는다)", async () => {
    toastMock.error.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/integrations/google-calendar/inbound-scan"
          ? { ok: false, status: 504, json: async () => { throw new SyntaxError("Unexpected token <"); } }
          : { ok: true, json: async () => ({ campaigns: [] }) },
      ),
    );
    render(<CalendarPageClient />);
    fireEvent.click(screen.getByRole("button", { name: "캘린더에서 가져오기" }));
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("캘린더 일정을 가져오지 못했습니다."));
  });

  it("버튼에 「승인하기 전에는 CRM이 바뀌지 않습니다」 설명창이 붙는다(포커스로도 열린다)", async () => {
    routeFetch({ ok: true, body: {} });
    render(<CalendarPageClient />);
    fireEvent.focus(screen.getByRole("button", { name: "캘린더에서 가져오기" }));
    expect((await screen.findAllByText("승인하기 전에는 CRM이 바뀌지 않습니다")).length).toBeGreaterThan(0);
  });
});
