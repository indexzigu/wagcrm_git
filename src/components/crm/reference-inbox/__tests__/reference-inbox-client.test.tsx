// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ReferenceInboxClient } from "../reference-inbox-client";

// --- Mocks ---

// toast는 함수 호출(undo 토스트)과 메서드 호출을 모두 쓴다.
const mockToastFn = vi.fn();
const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
vi.mock("sonner", () => ({
  toast: Object.assign(
    (...args: unknown[]) => mockToastFn(...args),
    {
      success: (...args: unknown[]) => mockToast.success(...args),
      error: (...args: unknown[]) => mockToast.error(...args),
      warning: (...args: unknown[]) => mockToast.warning(...args),
    },
  ),
}));

// CrmShell은 셸 크롬(사이드바 등)이라 본문만 통과시킨다.
vi.mock("@/components/crm/crm-shell", () => ({
  CrmShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// --- fetch 라우팅 목 ---

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];

const profileItem = {
  id: "item-profile",
  rawUrl: "https://www.instagram.com/haon_shop/",
  normalizedUrl: "https://www.instagram.com/haon_shop/",
  linkName: "instagram.com/haon_shop",
  source: "MANUAL",
  thumbnailUrl: "https://cdn.example.com/aeng.jpg",
  videoUrl: null,
  igUsername: "haon_shop",
  igProfilePicUrl: "https://cdn.example.com/aeng.jpg",
  igFullName: "애엥의 기록",
  igBio: "일상과 육아 사이 어딘가",
  igFollowerCount: 32_000,
  igPostCount: 412,
  note: null,
  status: "PENDING",
  createdAt: "2026-07-08T12:00:00.000Z",
};

const reelsFeedItem = {
  ...profileItem,
  id: "item-reels-feed",
  rawUrl: "https://www.instagram.com/haon_shop/reels",
  normalizedUrl: "https://www.instagram.com/haon_shop/reels",
  linkName: "instagram.com/haon_shop/reels",
  igFullName: "애엥 릴스",
  igBio: null,
};

const postItem = {
  ...profileItem,
  id: "item-post",
  rawUrl: "https://www.instagram.com/reel/ABC123/",
  normalizedUrl: "https://www.instagram.com/reel/ABC123/",
  linkName: "instagram.com/reel/ABC123",
  igUsername: "danji_table",
  igProfilePicUrl: "https://cdn.example.com/danji.jpg",
  igFullName: null,
  igBio: null,
  igFollowerCount: 84_000,
  igPostCount: null,
  thumbnailUrl: "https://cdn.example.com/post.jpg",
  videoUrl: "https://cdn.example.com/post.mp4",
};

const pendingItem = {
  ...profileItem,
  id: "item-pending",
  rawUrl: "https://www.instagram.com/p/PENDING1/",
  normalizedUrl: "https://www.instagram.com/p/PENDING1/",
  linkName: "instagram.com/p/PENDING1",
  igUsername: null,
  igProfilePicUrl: null,
  igFullName: null,
  igBio: null,
  igFollowerCount: null,
  igPostCount: null,
  thumbnailUrl: null,
  videoUrl: null,
};

const recentDeals = [
  { id: "deal-1", dealName: "홍삼 스틱", brandName: "정관장", partnerName: "뉴트리원" },
];
const searchedDeals = [
  { id: "deal-2", dealName: "콜라겐 젤리", brandName: "트리프", partnerName: "트리프" },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function installFetchMock(overrides?: {
  onDelete?: (url: string) => Response | undefined;
}) {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/reference-inbox?status=PENDING")) {
        return jsonResponse({ items: [profileItem, reelsFeedItem, postItem, pendingItem] });
      }
      if (url.startsWith("/api/search/deals?q=")) {
        return jsonResponse({ results: searchedDeals });
      }
      if (url.startsWith("/api/search/deals")) {
        return jsonResponse({ results: recentDeals });
      }
      if (url.includes("/assign") && method === "POST") {
        return jsonResponse({ ok: true, alreadyExists: false });
      }
      if (url.includes("/restore") && method === "POST") {
        // 실제 계약: 서버가 복원된 최신 행을 돌려준다(클라이언트는 이를 우선 사용).
        const id = url.split("/")[3];
        const all = [profileItem, reelsFeedItem, postItem, pendingItem];
        return jsonResponse({ ok: true, item: all.find((i) => i.id === id) ?? null });
      }
      if (method === "DELETE") {
        const custom = overrides?.onDelete?.(url);
        return custom ?? jsonResponse({ ok: true });
      }
      throw new Error(`unmocked fetch: ${method} ${url}`);
    }),
  );
}

async function renderInbox() {
  render(<ReferenceInboxClient />);
  // 카드 로딩 완료 대기(같은 계정이 여러 카드·위치에 반복되므로 findAll)
  await screen.findAllByText(/haon_shop/);
}

beforeEach(() => {
  vi.clearAllMocks();
  installFetchMock();
});

describe("ReferenceInboxClient — 카드 렌더링", () => {
  it("프로필 카드: 이름·팔로워 칩·프로필 배지·bio를 표시한다", async () => {
    await renderInbox();

    expect(screen.getByText("애엥의 기록")).toBeInTheDocument();
    // 보강된 프로필 비주얼 카드는 우상단 유형 배지를 생략한다(아바타·라벨이 유형을 전담)
    expect(screen.queryByText("프로필")).not.toBeInTheDocument();
    expect(screen.getByText("일상과 육아 사이 어딘가")).toBeInTheDocument();
    // 팔로워 수치는 만 단위 축약 (칩 + 하단 정보 두 곳)
    expect(screen.getAllByText("3.2만").length).toBeGreaterThanOrEqual(2);
    // 프로필 카드 하단엔 게시물 수 표기
    expect(screen.getByText(/게시물 412/)).toBeInTheDocument();
  });

  it("릴스 피드 카드: 릴스 피드 라벨을 배지와 비주얼 라벨로 표시한다", async () => {
    await renderInbox();
    // 우상단 배지는 생략되고 비주얼 서브라인 라벨 1곳만 남는다
    expect(screen.getAllByText("릴스 피드")).toHaveLength(1);
  });

  it("게시물 카드: URL 텍스트 대신 팔로워 아이콘 수치를 표기한다", async () => {
    await renderInbox();

    expect(screen.getByText("@danji_table")).toBeInTheDocument();
    expect(screen.getByText("8.4만")).toBeInTheDocument();
    // URL 전문 링크 텍스트는 더 이상 노출하지 않는다
    expect(
      screen.queryByText("https://www.instagram.com/reel/ABC123/"),
    ).not.toBeInTheDocument();
    // 팔로워 아이콘의 접근성 라벨
    expect(screen.getAllByLabelText("팔로워").length).toBeGreaterThanOrEqual(1);
  });

  it("보강 대기 카드: 수집 대기 상태를 표시한다", async () => {
    await renderInbox();

    expect(screen.getByText("썸네일 수집 대기")).toBeInTheDocument();
    expect(screen.getByText("다음 수집 주기에 채워집니다")).toBeInTheDocument();
    // 계정명 미보강 게시물은 URL 파생 텍스트 대신 중립 유형 라벨을 쓴다
    expect(screen.getByText("인스타그램 게시물")).toBeInTheDocument();
    expect(screen.queryByText("instagram.com/p/PENDING1")).not.toBeInTheDocument();
  });

  it("원본 열기는 새 탭 링크로 제공한다", async () => {
    await renderInbox();

    const links = screen.getAllByLabelText("원본 열기");
    expect(links.length).toBe(4);
    expect(links[0]).toHaveAttribute("target", "_blank");
  });
});

describe("ReferenceInboxClient — 기각/실행 취소", () => {
  it("기각하면 DELETE 후 카드가 사라지고 실행 취소 토스트가 뜬다", async () => {
    await renderInbox();

    const dismissButtons = screen.getAllByRole("button", { name: "기각" });
    fireEvent.click(dismissButtons[0]);

    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) => c.url === "/api/reference-inbox/item-profile" && c.init?.method === "DELETE",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("애엥의 기록")).not.toBeInTheDocument();
    });

    // 성공 토스트는 실행 취소 액션을 포함한다(확인창 없음)
    expect(mockToastFn).toHaveBeenCalledWith(
      "기각했습니다.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "실행 취소" }),
      }),
    );
  });

  it("실행 취소를 누르면 restore를 호출하고 카드가 복귀한다", async () => {
    await renderInbox();

    fireEvent.click(screen.getAllByRole("button", { name: "기각" })[0]);
    await waitFor(() => {
      expect(screen.queryByText("애엥의 기록")).not.toBeInTheDocument();
    });

    const toastArgs = mockToastFn.mock.calls[0][1] as {
      action: { onClick: () => void };
    };
    toastArgs.action.onClick();

    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) =>
            c.url === "/api/reference-inbox/item-profile/restore" && c.init?.method === "POST",
        ),
      ).toBe(true);
    });
    await screen.findByText("애엥의 기록");
    expect(mockToast.success).toHaveBeenCalledWith("기각을 취소했습니다.");
  });

  it("기각 실패 시 카드를 유지하고 에러 토스트를 띄운다", async () => {
    installFetchMock({
      onDelete: () => jsonResponse({ error: "서버 오류" }, false, 500),
    });
    await renderInbox();

    fireEvent.click(screen.getAllByRole("button", { name: "기각" })[0]);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("서버 오류");
    });
    expect(screen.getByText("애엥의 기록")).toBeInTheDocument();
  });
});

describe("ReferenceInboxClient — 다중 선택·일괄 배정", () => {
  it("선택하면 액션 바가 뜨고, 같은 계정 모두 선택이 동작한다", async () => {
    await renderInbox();

    // 프로필 카드 선택 (체크 버튼 aria-label="선택")
    const checks = screen.getAllByRole("button", { name: "선택" });
    fireEvent.click(checks[0]);

    expect(screen.getByText("건 선택", { exact: false })).toBeInTheDocument();

    // 같은 계정(haon_shop) 카드 2장이 모두 선택된다
    fireEvent.click(screen.getByRole("button", { name: "같은 계정 모두 선택" }));
    expect(screen.getAllByRole("button", { name: "선택 해제" }).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("일괄 딜 배정: 선택 항목마다 assign을 호출하고 집계 토스트를 띄운다", async () => {
    await renderInbox();

    const checks = screen.getAllByRole("button", { name: "선택" });
    fireEvent.click(checks[0]);
    fireEvent.click(screen.getByRole("button", { name: "같은 계정 모두 선택" }));

    // 액션 바의 딜 배정 → 다이얼로그
    const bulkAssign = screen.getAllByRole("button", { name: "딜 배정" }).at(-1)!;
    fireEvent.click(bulkAssign);
    expect(await screen.findByText("2건을 딜에 배정하기")).toBeInTheDocument();

    // 최근 딜 목록에서 선택
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox"));
    const option = await screen.findByText("홍삼 스틱");
    fireEvent.click(option);

    await waitFor(() => {
      const assignCalls = fetchCalls.filter(
        (c) => c.url.includes("/assign") && c.init?.method === "POST",
      );
      expect(assignCalls.length).toBe(2);
    });
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("2건을 딜 자료로 배정했습니다.");
    });
    // 배정된 카드는 목록에서 사라진다
    expect(screen.queryByText("애엥의 기록")).not.toBeInTheDocument();
  });
});

describe("ReferenceInboxClient — 딜 서버 검색", () => {
  it("2자 이상 입력하면 디바운스 후 서버 검색(q=)을 호출해 결과를 갱신한다", async () => {
    await renderInbox();

    // 단건 배정 다이얼로그 열기
    fireEvent.click(screen.getAllByRole("button", { name: "딜 배정" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox"));

    const input = screen.getByPlaceholderText("검색하여 딜 선택...");
    fireEvent.change(input, { target: { value: "콜라겐" } });

    await waitFor(
      () => {
        expect(
          fetchCalls.some((c) => c.url.includes("/api/search/deals?q=")),
        ).toBe(true);
      },
      { timeout: 2000 },
    );
    expect(await screen.findByText("콜라겐 젤리")).toBeInTheDocument();
  });
});

describe("ReferenceInboxClient — 딜 선택 목록", () => {
  async function openDealList() {
    await renderInbox();
    fireEvent.click(screen.getAllByRole("button", { name: "딜 배정" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox"));
    return dialog;
  }

  // ⚠️ 스크롤 자체는 jsdom 이 검증하지 못한다 — 대신 스크롤을 죽이는 **배치**를 고정한다.
  // 목록이 body 로 포털되면 Radix Dialog 의 RemoveScroll(shards=[DialogContent]) 밖이라
  // 휠이 preventDefault 되고, 클릭·호버는 되는데 스크롤만 죽는다(실사고).
  it("목록을 다이얼로그 서브트리 안에 렌더한다(포털 금지)", async () => {
    const dialog = await openDealList();
    expect(await within(dialog).findByText("홍삼 스틱")).toBeInTheDocument();
  });

  it("딜 이름과 함께 브랜드명·거래처명을 보여준다", async () => {
    const dialog = await openDealList();
    expect(await within(dialog).findByText("홍삼 스틱")).toBeInTheDocument();
    expect(within(dialog).getByText("브랜드")).toBeInTheDocument();
    expect(within(dialog).getByText("정관장")).toBeInTheDocument();
    expect(within(dialog).getByText("거래처")).toBeInTheDocument();
    expect(within(dialog).getByText("뉴트리원")).toBeInTheDocument();
  });

  // 브랜드사가 곧 거래처인 딜이 흔하다 — getDealContextParts(SSOT)가 접는다.
  it("브랜드명과 거래처명이 같으면 한 번만 적는다", async () => {
    const dialog = await openDealList();

    const input = screen.getByPlaceholderText("검색하여 딜 선택...");
    fireEvent.change(input, { target: { value: "콜라겐" } });

    // searchedDeals 는 브랜드·거래처가 둘 다 "트리프"다.
    expect(await within(dialog).findByText("콜라겐 젤리")).toBeInTheDocument();
    expect(within(dialog).getAllByText("트리프")).toHaveLength(1);
    expect(within(dialog).queryByText("거래처")).not.toBeInTheDocument();
  });
});
