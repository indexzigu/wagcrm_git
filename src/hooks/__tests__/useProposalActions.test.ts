/**
 * useProposalActions — approve/reject 공용 훅 (청사진 §3-#3).
 *
 * useApprovalInbox에 있던 approve/reject를 추출한 것 — M1 Promise 계약(호출부가
 * await하고 finally에서 pending을 해제)을 그대로 상속해야 하므로, 성공/실패 양쪽
 * 경로에서 Promise가 fetch 완료까지 이어지는지, 그리고 성공/실패 후 정확한
 * invalidateQueries 키(["action-proposal", id] + 인박스 키)가 호출되는지를 검증한다.
 */
import * as React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useProposalActions } from "../useProposalActions";
import { queryKeys } from "@/lib/query-keys";

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useProposalActions", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("approve(id) 성공 시 POST /approve를 호출하고 자기쿼리+인박스쿼리를 invalidate한다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ proposal: { id: "p1", status: "EXECUTED" } }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useProposalActions(), { wrapper: wrapper(queryClient) });

    let response: unknown;
    await act(async () => {
      response = await result.current.approve("p1");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals/p1/approve", { method: "POST" });
    expect(response).toEqual({ proposal: { id: "p1", status: "EXECUTED" } });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["action-proposal", "p1"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.actionProposals("PENDING_APPROVAL") });
    });
  });

  it("approve(id) 실패(4xx/5xx) 시 invalidate 후 에러를 throw한다 (M1 Promise 계약)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "이미 처리된 기안입니다 (동시 요청)." }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useProposalActions(), { wrapper: wrapper(queryClient) });

    await expect(
      act(async () => {
        await result.current.approve("p1");
      })
    ).rejects.toThrow(/이미 처리된 기안입니다/);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["action-proposal", "p1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.actionProposals("PENDING_APPROVAL") });
  });

  it("reject(id) 성공 시 POST /reject를 호출하고 자기쿼리+인박스쿼리를 invalidate한다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ proposal: { id: "p1", status: "REJECTED" } }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useProposalActions(), { wrapper: wrapper(queryClient) });

    await act(async () => {
      await result.current.reject("p1");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals/p1/reject", { method: "POST" });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["action-proposal", "p1"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.actionProposals("PENDING_APPROVAL") });
    });
  });

  it("reject(id) 실패 시 에러를 throw한다", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "반려 처리 중 서버 오류가 발생했습니다." }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProposalActions(), { wrapper: wrapper(queryClient) });

    await expect(
      act(async () => {
        await result.current.reject("p1");
      })
    ).rejects.toThrow(/반려 처리 중 서버 오류가 발생했습니다/);
  });

  it("json() 파싱 실패 시에도 status 기반 fallback 에러 메시지를 던진다", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("invalid json");
      },
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProposalActions(), { wrapper: wrapper(queryClient) });

    await expect(
      act(async () => {
        await result.current.approve("p1");
      })
    ).rejects.toThrow(/status=502/);
  });
});
