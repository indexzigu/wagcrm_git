// @vitest-environment jsdom
/**
 * useReadRecords — 봇 조회 결과 목록 (Plan 2 Task 4).
 *
 * 두 가지를 고정한다: ① 목록 API 가 `structuredResult` 를 역직렬화하지 않으므로
 * (SQLite 는 문자열로 온다 — `docs/agents/codebase-map.md` 의 Json 이원화 함정)
 * 훅이 읽기 SSOT 로 파싱하고, 깨진 값에는 던지지 않고 null 로 접는다.
 * ② 커서(`before`) 페이지네이션이 두 번째 요청에 실제로 실린다.
 */
import * as React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useReadRecords } from "../useReadRecords";

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "read-1",
    title: "딜 검색: 유산균",
    status: "EXECUTED",
    kind: "READ",
    targetEntityType: null,
    targetEntityId: null,
    targetEntityName: null,
    payload: null,
    createdBy: "AGENT_WORKER",
    createdAt: "2026-09-22T05:30:00.000Z",
    resultSummary: "딜 3건을 찾았습니다.",
    structuredResult: '{"operation":"search_deals"}',
    ...overrides,
  };
}

describe("useReadRecords", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [makeRow()], count: 1, nextBefore: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("문자열로 온 structuredResult 를 객체로 되돌린다 (SQLite 경로)", async () => {
    const { result } = renderHook(() => useReadRecords(), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].structuredResult?.operation).toBe("search_deals");
    expect(result.current.count).toBe(1);
  });

  it("이미 객체로 온 structuredResult 는 그대로 쓴다 (Postgres 경로)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [makeRow({ structuredResult: { operation: "get_settlement_report" } })],
        count: 1,
        nextBefore: null,
      }),
    });
    const { result } = renderHook(() => useReadRecords(), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].structuredResult?.operation).toBe("get_settlement_report");
  });

  it("깨진 문자열은 던지지 않고 structuredResult=null 로 접는다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [makeRow({ structuredResult: "{깨진 값" })],
        count: 1,
        nextBefore: null,
      }),
    });
    const { result } = renderHook(() => useReadRecords(), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].structuredResult).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("첫 요청은 status=EXECUTED&kind=READ 이고 before 가 없다", async () => {
    const { result } = renderHook(() => useReadRecords(), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("status=EXECUTED");
    expect(url).toContain("kind=READ");
    expect(url).not.toContain("before=");
  });

  it("nextBefore 가 null 이면 hasMore 가 false 다", async () => {
    const { result } = renderHook(() => useReadRecords(), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it("loadMore 는 다음 요청에 before 커서를 싣는다", async () => {
    const cursor = "2026-09-20T00:00:00.000Z";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [makeRow()], count: 2, nextBefore: cursor }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [makeRow({ id: "read-2" })], count: 2, nextBefore: null }),
    });

    const { result } = renderHook(() => useReadRecords(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(decodeURIComponent(String(fetchMock.mock.calls[1][0]))).toContain(`before=${cursor}`);
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.hasMore).toBe(false);
  });

  it("직전 더 보기가 진행 중이면 loadMore 는 아무것도 하지 않는다", async () => {
    const cursor = "2026-09-20T00:00:00.000Z";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [makeRow()], count: 3, nextBefore: cursor }),
    });
    // 두 번째 페이지는 손으로 풀 때까지 매달아 둔다 — 그 사이의 재클릭이 중복 요청을
    // 내지 않아야 한다(같은 커서로 두 번 부르면 같은 행이 두 번 쌓인다).
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              json: async () => ({ items: [makeRow({ id: "read-2" })], count: 3, nextBefore: null }),
            });
        })
    );

    const { result } = renderHook(() => useReadRecords(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(true));

    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => {
      release?.();
    });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
  });
});
