import { describe, expect, it } from "vitest";
import { buildNaverTrackingLink, DEFAULT_TRACKING_BASE_URL } from "../tracking";

describe("buildNaverTrackingLink", () => {
  it("appends tracking params to a valid base URL", () => {
    const link = buildNaverTrackingLink({
      baseUrl: "https://brand.example.com/product?id=1",
      snsType: "INSTAGRAM",
      sellerId: "seller-1",
      campaignId: "camp-1",
    });

    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://brand.example.com/product");
    expect(url.searchParams.get("id")).toBe("1");
    expect(url.searchParams.get("nt_source")).toBe("INSTAGRAM");
    expect(url.searchParams.get("nt_medium")).toBe("seller-1");
    expect(url.searchParams.get("nt_detail")).toBe("camp-1");
  });

  it("respects overrideParams when provided and appends nt_keyword", () => {
    const link = buildNaverTrackingLink({
      baseUrl: "https://brand.example.com/product?id=1",
      snsType: "INSTAGRAM",
      sellerId: "seller-1",
      campaignId: "camp-1",
      overrideParams: {
        nt_source: "instalink",
        nt_medium: "social",
        nt_detail: "wagcm",
        nt_keyword: "influencer_handle",
      },
    });

    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://brand.example.com/product");
    expect(url.searchParams.get("id")).toBe("1");
    expect(url.searchParams.get("nt_source")).toBe("instalink");
    expect(url.searchParams.get("nt_medium")).toBe("social");
    expect(url.searchParams.get("nt_detail")).toBe("wagcm");
    expect(url.searchParams.get("nt_keyword")).toBe("influencer_handle");
  });

  it("falls back to default base URL when base URL is empty or invalid", () => {
    const fromEmpty = buildNaverTrackingLink({
      baseUrl: "",
      snsType: "YOUTUBE",
      sellerId: "seller-2",
      campaignId: "camp-2",
    });

    const fromInvalid = buildNaverTrackingLink({
      baseUrl: "not-a-url",
      snsType: "INSTAGRAM",
      sellerId: "seller-3",
      campaignId: "camp-3",
    });

    const emptyUrl = new URL(fromEmpty);
    const invalidUrl = new URL(fromInvalid);

    expect(emptyUrl.origin).toBe(new URL(DEFAULT_TRACKING_BASE_URL).origin);
    expect(invalidUrl.origin).toBe(new URL(DEFAULT_TRACKING_BASE_URL).origin);
    expect(emptyUrl.searchParams.get("nt_source")).toBe("YOUTUBE");
    expect(invalidUrl.searchParams.get("nt_source")).toBe("INSTAGRAM");
  });
});
