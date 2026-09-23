// @vitest-environment jsdom
/**
 * useAgentJobs — 결재함 「봇 활동」 목록 (Plan 2 Task 4).
 *
 * 기본은 성공 제외이고 「완료 포함」을 켤 때만 `includeSucceeded=1` 을 붙인다 —
 * 두 목록은 쿼리키가 다르므로 서로의 캐시를 덮지 않는다. 커서(`before`)는 두 번째
 * 요청에 실린다.
 */
import * as React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useAgentJobs } from "../useAgentJobs";

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status: "FAILED_FINAL",
    operation: "search_deals",
    taskType: "READ",
    createdAt: "2026-09-22T05:30:00.000Z",
    updatedAt: "2026-09-22T05:30:10.000Z",
    attempt: 1,
    failureCode: "TIMEOUT",
    resultStatus: null,
    resultSummary: null,
    actionProposalId: null,
    payloadUnreadable: false,
    ...overrides,
  };
}

describe("useAgentJobs", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [makeJob()], nextBefore: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("기본(false)은 includeSucceeded 파라미터를 붙이지 않는다", async () => {
    const { result } = renderHook(() => useAgentJobs(false), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith("/api/agent-jobs");
    expect(result.current.items).toHaveLength(1);
    expect(result.current.hasMore).toBe(false);
  });

  it("true 면 includeSucceeded=1 을 붙인다", async () => {
    const { result } = renderHook(() => useAgentJobs(true), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(String(fetchMock.mock.calls[0][0])).toContain("includeSucceeded=1");
  });

  it("완료 포함 여부가 다르면 서로 다른 캐시를 쓴다 (요청이 각각 나간다)", async () => {
    const queryClient = newClient();
    const { result: off } = renderHook(() => useAgentJobs(false), { wrapper: wrapper(queryClient) });
    const { result: on } = renderHook(() => useAgentJobs(true), { wrapper: wrapper(queryClient) });

    await waitFor(() => {
      expect(off.current.isLoading).toBe(false);
      expect(on.current.isLoading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loadMore 는 다음 요청에 before 커서를 싣는다", async () => {
    const cursor = "2026-09-20T00:00:00.000Z";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [makeJob()], nextBefore: cursor }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [makeJob({ id: "job-2" })], nextBefore: null }),
    });

    const { result } = renderHook(() => useAgentJobs(false), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(decodeURIComponent(String(fetchMock.mock.calls[1][0]))).toContain(`before=${cursor}`);
    await waitFor(() => expect(result.current.items).toHaveLength(2));
  });

  it("직전 더 보기가 진행 중이면 loadMore 는 아무것도 하지 않는다", async () => {
    const cursor = "2026-09-20T00:00:00.000Z";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [makeJob()], nextBefore: cursor }),
    });
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              json: async () => ({ items: [makeJob({ id: "job-2" })], nextBefore: null }),
            });
        })
    );

    const { result } = renderHook(() => useAgentJobs(false), { wrapper: wrapper(newClient()) });
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

  it("fetch 실패는 isError 로 드러난다", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { result } = renderHook(() => useAgentJobs(false), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.items).toEqual([]);
  });
});
