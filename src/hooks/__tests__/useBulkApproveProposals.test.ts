// @vitest-environment jsdom
/**
 * useBulkApproveProposals — 결재함 대기 탭의 일괄 승인 훅.
 *
 * 끝나면 단건 경로(useProposalActions)와 같은 키를 **한 번** 무효화한다: 건별 상세 2종 +
 * 인박스 전 탭(프리픽스). 요청이 실패해도(던지지 않고) 무효화는 한다 — 서버가 일부를
 * 처리했을 수 있다.
 */
import * as React from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBulkApproveProposals } from "../useBulkApproveProposals";

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useBulkApproveProposals", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("일괄 승인 라우트를 부르고 결과를 돌려준 뒤 상세·인박스 캐시를 무효화한다", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { id: "p1", ok: true, outcome: "executed", status: "EXECUTED" },
            { id: "p2", ok: false, outcome: "skipped", status: "EXECUTED", error: "이미 처리" },
          ],
          counts: { total: 2, executed: 1, failed: 0, skipped: 1 },
        }),
        { status: 200 }
      )
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useBulkApproveProposals(), { wrapper: wrapper(queryClient) });

    const onProgress = vi.fn();
    let response: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      response = await result.current(["p1", "p2"], { onProgress });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/action-proposals/bulk-approve",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: ["p1", "p2"] }) })
    );
    expect(response?.counts).toEqual({ total: 2, executed: 1, failed: 0, skipped: 1 });
    expect(onProgress).toHaveBeenCalledWith(2, 2);
    for (const id of ["p1", "p2"]) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["action-proposal", id] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["approval-detail", id] });
    }
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["action-proposals"] });
  });

  it("요청이 실패해도 던지지 않고 실패 결과를 돌려주며 무효화는 한다", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useBulkApproveProposals(), { wrapper: wrapper(queryClient) });

    let response: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      response = await result.current(["p1"]);
    });

    expect(response?.counts).toEqual({ total: 1, executed: 0, failed: 1, skipped: 0 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["action-proposals"] });
  });
});
