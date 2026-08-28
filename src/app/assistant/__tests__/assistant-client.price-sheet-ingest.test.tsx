// @vitest-environment jsdom
/**
 * AssistantClient — 가격표 인제스트 슬롯 (1단계).
 *
 * 계약: ① 클립/드롭으로 올린 파일은 즉시 서버에 쓰지 않고 대기 바(거래처 확인)를
 * 거친다 ② 결과는 채팅 메시지가 아니라 입력줄 위 상태 카드다 ③ 대기 바/결과 카드와
 * 빈 대화 제안 칩은 같은 슬롯을 상호 배타적으로 점유한다 ④ 검증 실패는 서버 호출
 * 없이 서버와 동일 문구로 거부한다.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/crm/assistant/approval-inbox", () => ({
  ApprovalInbox: () => <div data-testid="approval-inbox-stub" />,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AssistantClient } from "../assistant-client";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function stageFile(name: string) {
  const file = new File(["x"], name, { type: "application/octet-stream" });
  fireEvent.change(screen.getByTestId("price-sheet-file-input"), {
    target: { files: [file] },
  });
}

describe("AssistantClient — 가격표 인제스트 슬롯", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(jsonResponse({ conversations: [] }));
      }
      if (url === "/api/partners") {
        return Promise.resolve(jsonResponse({ partners: [{ id: "p-1", name: "거래처A" }] }));
      }
      if (url === "/api/price-sheets") {
        return Promise.resolve(jsonResponse({ priceSheet: { id: "ps-1" } }));
      }
      if (url === "/api/price-sheets/ps-1/extract") {
        return Promise.resolve(jsonResponse({ priceSheet: { detectedTables: 2 }, rowCount: 2 }));
      }
      if (url === "/api/price-sheets/ps-1/map") {
        return Promise.resolve(jsonResponse({ mappingCount: 2 }));
      }
      // GET 상세 — 기본은 전량 깨끗(NEW_DEAL)으로 두어 채팅 적용 경로를 검증한다.
      if (url === "/api/price-sheets/ps-1") {
        return Promise.resolve(
          jsonResponse({
            priceSheet: {
              rows: [
                { productName: "새 상품 A", optionName: null, sellingPrice: 9000, mappingStatus: "NEW_DEAL" },
                { productName: "새 상품 B", optionName: null, sellingPrice: 8000, mappingStatus: "NEW_DEAL" },
              ],
            },
          }),
        );
      }
      if (url === "/api/price-sheets/ps-1/apply") {
        return Promise.resolve(jsonResponse({ rowCount: 2, results: [{}, {}] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("파일 첨부 버튼이 입력줄에 렌더된다", async () => {
    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "파일 첨부" })).toBeInTheDocument();
  });

  it("파일 선택 시 즉시 업로드하지 않고 대기 바를 띄우며, 제안 칩을 숨긴다", async () => {
    renderWithQueryClient(<AssistantClient />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "이번달 정산 현황 알려줘" })).toBeInTheDocument(),
    );

    stageFile("가격표.png");

    expect(await screen.findByText(/가격표\.png/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "업로드" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "취소" })).toBeInTheDocument();
    // 즉시 서버 쓰기 금지 — 업로드 확정 전에는 POST /api/price-sheets가 없어야 한다.
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/price-sheets"),
    ).toHaveLength(0);
    // 슬롯 점유 중에는 제안 칩이 사라진다(상호 배타).
    expect(screen.queryByRole("button", { name: "이번달 정산 현황 알려줘" })).not.toBeInTheDocument();
  });

  it("업로드 확정 시 업로드→추출→매핑을 호출하고 검토 카드(깨끗한 행)를 보여준다", async () => {
    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    stageFile("가격표.png");
    await userEvent.click(await screen.findByRole("button", { name: "업로드" }));

    expect(await screen.findByText(/가격표 분석 완료 · 품목 2개/)).toBeInTheDocument();
    expect(screen.getByText(/새 상품 A/)).toBeInTheDocument();
    // 전량 깨끗 → 채팅 적용 버튼이 열린다.
    expect(screen.getByRole("button", { name: /새 딜 2개 반영/ })).toBeInTheDocument();

    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/price-sheets")).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/price-sheets/ps-1/extract"),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/price-sheets/ps-1/map")).toHaveLength(1);
  });

  it("깨끗한 행 적용 시 /apply를 호출하고 반영 완료 카드를 보여준다", async () => {
    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    stageFile("가격표.png");
    await userEvent.click(await screen.findByRole("button", { name: "업로드" }));
    await userEvent.click(await screen.findByRole("button", { name: /새 딜 2개 반영/ }));

    expect(await screen.findByText(/품목 2개를 딜에 반영 완료/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /반영 결과 보기/ })).toHaveAttribute(
      "href",
      "/assets/price-sheets/ps-1",
    );
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/price-sheets/ps-1/apply")).toHaveLength(1);
  });

  it("애매한 행이 있으면 채팅 적용을 열지 않고 검토 화면 링크만 보여준다", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") return Promise.resolve(jsonResponse({ conversations: [] }));
      if (url === "/api/partners") return Promise.resolve(jsonResponse({ partners: [] }));
      if (url === "/api/price-sheets") return Promise.resolve(jsonResponse({ priceSheet: { id: "ps-1" } }));
      if (url === "/api/price-sheets/ps-1/extract")
        return Promise.resolve(jsonResponse({ priceSheet: { detectedTables: 1 }, rowCount: 2 }));
      if (url === "/api/price-sheets/ps-1/map") return Promise.resolve(jsonResponse({ mappingCount: 2 }));
      if (url === "/api/price-sheets/ps-1") {
        return Promise.resolve(
          jsonResponse({
            priceSheet: {
              rows: [
                { productName: "새 상품", optionName: null, sellingPrice: 9000, mappingStatus: "NEW_DEAL" },
                { productName: "겹치는 상품", optionName: null, sellingPrice: 8000, mappingStatus: "SUGGESTED" },
              ],
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    stageFile("가격표.png");
    await userEvent.click(await screen.findByRole("button", { name: "업로드" }));

    expect(await screen.findByText(/확인이 필요한 품목 1개/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /검토 화면에서 확인/ })).toHaveAttribute(
      "href",
      "/assets/price-sheets/ps-1",
    );
    // 애매 행 존재 → 채팅 적용 버튼 없음(부분 적용 = APPLIED 잠금 충돌 회피).
    expect(screen.queryByRole("button", { name: /반영/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/price-sheets/ps-1/apply")).toHaveLength(0);
  });

  it("추출 실패 시 서버 error 원문과 상세 재시도 링크를 보여준다", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/assistant/conversations") {
        return Promise.resolve(jsonResponse({ conversations: [] }));
      }
      if (url === "/api/partners") {
        return Promise.resolve(jsonResponse({ partners: [] }));
      }
      if (url === "/api/price-sheets") {
        return Promise.resolve(jsonResponse({ priceSheet: { id: "ps-9" } }));
      }
      if (url === "/api/price-sheets/ps-9/extract") {
        return Promise.resolve(jsonResponse({ error: "원본 파일을 읽을 수 없습니다." }, false));
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    stageFile("가격표.png");
    await userEvent.click(await screen.findByRole("button", { name: "업로드" }));

    expect(await screen.findByText("원본 파일을 읽을 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "상세에서 재시도" })).toHaveAttribute(
      "href",
      "/assets/price-sheets/ps-9",
    );
  });

  it("허용 밖 확장자는 서버 호출 없이 서버와 동일 문구로 거부한다", async () => {
    renderWithQueryClient(<AssistantClient />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    stageFile("문서.hwp");

    expect(await screen.findByText(/지원하지 않는 파일 형식/)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/price-sheets"),
    ).toHaveLength(0);
  });

  it("검토 카드 닫기 시 슬롯이 비워지고 제안 칩이 돌아온다", async () => {
    renderWithQueryClient(<AssistantClient />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "이번달 정산 현황 알려줘" })).toBeInTheDocument(),
    );

    stageFile("가격표.png");
    await userEvent.click(await screen.findByRole("button", { name: "업로드" }));
    await screen.findByText(/가격표 분석 완료/);

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(screen.queryByText(/가격표 분석 완료/)).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "이번달 정산 현황 알려줘" }),
    ).toBeInTheDocument();
  });

  it("취소하면 슬롯이 비워지고 제안 칩이 돌아온다", async () => {
    renderWithQueryClient(<AssistantClient />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "이번달 정산 현황 알려줘" })).toBeInTheDocument(),
    );

    stageFile("가격표.png");
    await userEvent.click(await screen.findByRole("button", { name: "취소" }));

    expect(screen.queryByText(/가격표\.png/)).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "이번달 정산 현황 알려줘" }),
    ).toBeInTheDocument();
  });
});
