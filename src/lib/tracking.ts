import type { SnsType } from "./crm-types";

export const DEFAULT_TRACKING_BASE_URL = "https://example.com";

function resolveTrackingBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return DEFAULT_TRACKING_BASE_URL;
  try {
    // Validate URL shape; fall back if invalid.
    new URL(trimmed);
    return trimmed;
  } catch {
    return DEFAULT_TRACKING_BASE_URL;
  }
}

export function buildNaverTrackingLink(input: {
  baseUrl: string;
  snsType: SnsType;
  sellerId: string;
  campaignId: string;
  overrideParams?: {
    nt_source?: string;
    nt_medium?: string;
    nt_detail?: string;
    nt_keyword?: string;
  };
}) {
  const url = new URL(resolveTrackingBaseUrl(input.baseUrl));
  const source = input.overrideParams?.nt_source ?? input.snsType;
  const medium = input.overrideParams?.nt_medium ?? input.sellerId;
  const detail = input.overrideParams?.nt_detail ?? input.campaignId;

  url.searchParams.set("nt_source", source);
  url.searchParams.set("nt_medium", medium);
  url.searchParams.set("nt_detail", detail);

  if (input.overrideParams?.nt_keyword) {
    url.searchParams.set("nt_keyword", input.overrideParams.nt_keyword);
  }

  return url.toString();
}

export const trackingParamKeys = ["nt_source", "nt_medium", "nt_detail"] as const;

export type TrackingParamKey = (typeof trackingParamKeys)[number];
