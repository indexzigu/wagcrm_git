// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PriceSheetList } from "../price-sheet-list";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function getTrigger() {
  const trigger = document.querySelector('[data-slot="popover-trigger"]') as HTMLElement;
  if (!trigger) throw new Error("거래처 검색 드롭다운 트리거를 찾을 수 없습니다");
  return trigger;
}

function getSearchInput() {
  const input = document.querySelector('[cmdk-input]') as HTMLInputElement;
  if (!input) throw new Error("Could not find cmdk input");
  return input;
}

describe("PriceSheetList — 거래처 선택 검색화 (UX1-D)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/price-sheets") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ priceSheets: [] }) });
      }
      if (url === "/api/partners") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              partners: [
                { id: "partner-1", name: "코링코" },
                { id: "partner-2", name: "뉴트리원" },
                { id: "partner-3", name: "휴브론" },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  it("거래처 선택 UI가 searchable-dropdown(콤보박스)으로 렌더링된다", async () => {
    render(<PriceSheetList />);

    await waitFor(() => {
      expect(getTrigger()).toBeInTheDocument();
    });
    expect(getTrigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("기본값은 '지정 안 함'이다", async () => {
    render(<PriceSheetList />);

    await waitFor(() => {
      expect(screen.getByText("지정 안 함")).toBeInTheDocument();
    });
  });

  it("검색어를 입력하면 일치하는 거래처만 필터링된다", async () => {
    const user = userEvent.setup();
    render(<PriceSheetList />);

    await waitFor(() => {
      expect(getTrigger()).toBeInTheDocument();
    });
    await user.click(getTrigger());

    await waitFor(() => {
      expect(getSearchInput()).toBeInTheDocument();
    });

    await user.type(getSearchInput(), "코링코");

    await waitFor(() => {
      expect(screen.getByText("코링코")).toBeInTheDocument();
      expect(screen.queryByText("뉴트리원")).not.toBeInTheDocument();
    });
  });

  it("거래처를 선택하면 선택값이 트리거에 표시된다", async () => {
    const user = userEvent.setup();
    render(<PriceSheetList />);

    await waitFor(() => {
      expect(getTrigger()).toBeInTheDocument();
    });
    await user.click(getTrigger());

    await waitFor(() => {
      expect(screen.getByText("뉴트리원")).toBeInTheDocument();
    });
    await user.click(screen.getByText("뉴트리원"));

    await waitFor(() => {
      expect(getTrigger()).toHaveTextContent("뉴트리원");
    });
  });

  it("'지정 안 함'을 선택하면 업로드 시 partnerId가 포함되지 않는다", async () => {
    const user = userEvent.setup();
    render(<PriceSheetList />);

    await waitFor(() => {
      expect(getTrigger()).toBeInTheDocument();
    });
    await user.click(getTrigger());

    await waitFor(() => {
      expect(screen.getByText("뉴트리원")).toBeInTheDocument();
    });
    await user.click(screen.getByText("뉴트리원"));

    await waitFor(() => {
      expect(getTrigger()).toHaveTextContent("뉴트리원");
    });

    // 다시 열어서 '지정 안 함'으로 되돌린다
    await user.click(getTrigger());
    await waitFor(() => {
      expect(screen.getByText("지정 안 함")).toBeInTheDocument();
    });
    await user.click(screen.getByText("지정 안 함"));

    const file = new File(["dummy"], "sheet.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url === "/api/price-sheets" && options?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ priceSheet: { id: "sheet-1" } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ priceSheets: [], partners: [] }) });
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => {
      const postCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const formData = postCall?.[1] as RequestInit;
      const body = formData.body as FormData;
      expect(body.has("partnerId")).toBe(false);
    });
  });
});

/**
 * 종전에는 상태코드를 보지 않아 오류 응답의 `priceSheets` 부재가 `[]` 로 떨어졌다 — 조회가
 * 실패해도 「업로드된 가격표가 없습니다」가 떠서 올린 가격표가 사라진 것으로 읽혔다
 * (interfaces 점검 #9, 2026-09-24).
 */
describe("PriceSheetList — 목록 조회 실패는 빈 목록이 아니다", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("조회가 실패하면 복구 안내를 보이고, 「다시 불러오기」가 성공하면 진짜 빈 목록을 보인다", async () => {
    let listCalls = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/price-sheets") {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? { ok: false, status: 500, json: () => Promise.resolve({ error: "boom" }) }
            : { ok: true, json: () => Promise.resolve({ priceSheets: [] }) },
        );
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ partners: [] }) });
    });
    const user = userEvent.setup();
    render(<PriceSheetList />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("가격표 목록을 불러오지 못했습니다.");
    expect(screen.queryByText("업로드된 가격표가 없습니다.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "다시 불러오기" }));

    expect(await screen.findByText("업로드된 가격표가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(listCalls).toBe(2);
  });
});
