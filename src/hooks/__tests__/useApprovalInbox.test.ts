// @vitest-environment jsdom
/**
 * useApprovalInbox — status 파라미터화 (청사진 §6-1, §6-3).
 *
 * status 인자별 fetch URL·쿼리키가 정확한지, 그리고 기존 무인자 호출부(기본값
 * PENDING_APPROVAL)가 하위호환되는지를 검증한다. approve/reject는 useProposalActions를
 * 그대로 재사용하므로 여기서는 반환값 형태만 확인한다(회귀 검증은 useProposalActions.test.ts).
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useApprovalInbox } from "../useApprovalInbox";
import { queryKeys } from "@/lib/query-keys";

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useApprovalInbox", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], count: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("무인자 호출 시 기본값 PENDING_APPROVAL로 fetch하고 쿼리키도 동일하다 (하위호환)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useApprovalInbox(), { wrapper: wrapper(queryClient) });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals?status=PENDING_APPROVAL&kind=WRITE");
    });

    expect(
      queryClient.getQueryData(queryKeys.actionProposals("PENDING_APPROVAL"))
    ).toEqual({ items: [], count: 0, nextBefore: null });
  });

  it("status='EXECUTED' 호출 시 해당 status로 fetch하고 쿼리키에 EXECUTED가 포함된다", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useApprovalInbox("EXECUTED"), { wrapper: wrapper(queryClient) });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals?status=EXECUTED&kind=WRITE");
    });

    expect(
      queryClient.getQueryData(queryKeys.actionProposals("EXECUTED"))
    ).toEqual({ items: [], count: 0, nextBefore: null });
  });

  it("status='FAILED' 호출 시 해당 status로 fetch한다", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useApprovalInbox("FAILED"), { wrapper: wrapper(queryClient) });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals?status=FAILED&kind=WRITE");
    });
  });

  it("status='REJECTED' 호출 시 해당 status로 fetch한다", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useApprovalInbox("REJECTED"), { wrapper: wrapper(queryClient) });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals?status=REJECTED&kind=WRITE");
    });
  });

  it("서로 다른 status는 서로 다른 쿼리키(독립 캐시)를 가진다", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result: pendingResult } = renderHook(() => useApprovalInbox("PENDING_APPROVAL"), {
      wrapper: wrapper(queryClient),
    });
    const { result: executedResult } = renderHook(() => useApprovalInbox("EXECUTED"), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => {
      expect(pendingResult.current.isLoading).toBe(false);
      expect(executedResult.current.isLoading).toBe(false);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals?status=PENDING_APPROVAL&kind=WRITE");
    expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals?status=EXECUTED&kind=WRITE");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetch 실패 시 에러를 throw한다 (기존 동작 회귀 없음)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useApprovalInbox(), { wrapper: wrapper(queryClient) });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    // 에러 상태에서도 items/count는 안전한 기본값을 유지한다.
    expect(result.current.items).toEqual([]);
    expect(result.current.count).toBe(0);
  });

  it("kind='READ' 호출 시 kind 파라미터와 쿼리키가 함께 갈라진다", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useApprovalInbox("EXECUTED", "READ"), { wrapper: wrapper(queryClient) });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals?status=EXECUTED&kind=READ");
    });

    // 같은 status 라도 kind 가 다르면 별도 캐시다 — 조회 결과(READ) 탭이 기안 완료 탭을
    // 덮어쓰지 않게 하는 계약.
    expect(queryClient.getQueryData(queryKeys.actionProposals("EXECUTED", "READ"))).toEqual({
      items: [],
      count: 0,
      nextBefore: null,
    });
    expect(queryClient.getQueryData(queryKeys.actionProposals("EXECUTED"))).toBeUndefined();
  });

  it("무인자 kind 는 WRITE 다 (사이드바 배지 하위호환)", () => {
    expect(queryKeys.actionProposals("PENDING_APPROVAL")).toEqual(
      queryKeys.actionProposals("PENDING_APPROVAL", "WRITE")
    );
  });

  it("approve/reject 함수를 반환한다 (useProposalActions 재사용)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useApprovalInbox(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(typeof result.current.approve).toBe("function");
    expect(typeof result.current.reject).toBe("function");
  });
});
