// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const get = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get }),
}));

import { useCampaignDeepLink } from "./use-campaign-deep-link";

beforeEach(() => vi.clearAllMocks());

describe("useCampaignDeepLink", () => {
  it("campaignId 파라미터가 있으면 onOpen을 그 값으로 1회 호출한다", () => {
    get.mockReturnValue("camp-1");
    const onOpen = vi.fn();
    renderHook(() => useCampaignDeepLink(onOpen));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("camp-1");
  });

  it("파라미터가 없으면 호출하지 않는다", () => {
    get.mockReturnValue(null);
    const onOpen = vi.fn();
    renderHook(() => useCampaignDeepLink(onOpen));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("리렌더에도 재발화하지 않는다(중복 패널 열림 방지)", () => {
    get.mockReturnValue("camp-1");
    const onOpen = vi.fn();
    const { rerender } = renderHook(() => useCampaignDeepLink(onOpen));
    rerender();
    rerender();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
