/**
 * usePartners.updatePartnerField — 인라인 저장 무음 계약 (셀러 PR #36과 동일).
 *
 * partners-panel.test.tsx의 blur 저장 테스트는 onPatchPartner 미전달 시 패널 내장
 * defaultPatchPartner 폴백을 타므로, 운영에서 실제 주입되는 이 훅의 토스트를 관측하지
 * 못한다(과거 회귀가 그 사각에서 살아남음). 여기서 운영 경로(훅)를 직접 검증한다:
 * 성공 = 무음(낙관적 값 갱신이 피드백), 실패 = throw 전파(토스트는 InlineEditField 소유).
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { usePartners, type PartnerRow } from "../usePartners";
import { queryKeys } from "@/lib/query-keys";

const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
    warning: (...args: unknown[]) => mockToast.warning(...args),
  },
}));

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const basePartner = {
  id: "partner-1",
  name: "테스트 파트너",
  type: "BRAND",
  contactInfo: "010-1234-5678",
  bankAccount: "국민은행 123-456-789",
  contacts: [],
} as unknown as PartnerRow;

describe("usePartners.updatePartnerField", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("성공 시 PATCH 호출·상태 동기화하되 성공 토스트는 띄우지 않는다 (무음 계약)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "partner-1", contactInfo: "010-9999-8888" }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePartners([basePartner]), {
      wrapper: wrapper(queryClient),
    });

    await result.current.updatePartnerField("partner-1", "contactInfo", "010-9999-8888");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/partners/partner-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ contactInfo: "010-9999-8888" }),
      }),
    );

    await waitFor(() => {
      const rows = queryClient.getQueryData<PartnerRow[]>(queryKeys.partners());
      expect(rows?.find((r) => r.id === "partner-1")?.contactInfo).toBe("010-9999-8888");
    });

    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("실패 시 에러를 던져 전파하고 훅 스스로는 토스트하지 않는다 (실패 토스트는 InlineEditField 소유)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "저장 실패" }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePartners([basePartner]), {
      wrapper: wrapper(queryClient),
    });

    await expect(
      result.current.updatePartnerField("partner-1", "contactInfo", "x"),
    ).rejects.toThrow("저장 실패");

    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("updateContact 성공 시에도 무음이다 (담당자 인라인 수정 성공 토스트는 패널 patchContact 소유·무음)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "contact-1", name: "수정된 담당자" }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePartners([basePartner]), {
      wrapper: wrapper(queryClient),
    });

    await result.current.updateContact("partner-1", "contact-1", { name: "수정된 담당자" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/partners/contacts/contact-1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});
