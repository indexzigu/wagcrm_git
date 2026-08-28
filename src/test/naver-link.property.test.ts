/**
 * Property-based tests for Naver tracking link generation.
 *
 * Feature: business-logic-automation
 * Property 4: Naver tracking link generation preserves parameters
 * Property 5: Invalid URL rejection for tracking link
 *
 * **Validates: Requirements 3.1, 3.4**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { buildNaverTrackingLink, DEFAULT_TRACKING_BASE_URL } from "@/lib/tracking";
import type { SnsType } from "@/lib/crm-types";

// ---------------------------------------------------------------------------
// Helpers (mirrors the logic in naver-link-preview.tsx)
// ---------------------------------------------------------------------------

/**
 * Validates whether a string is a usable URL for tracking link generation.
 * Mirrors the `isValidUrl` function in NaverLinkPreview.
 */
function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * The full link-builder pipeline as used by NaverLinkPreview:
 * validate first, then build. Returns null for invalid URLs.
 */
function buildTrackingLinkSafe(input: {
  baseUrl: string;
  snsType: SnsType;
  sellerId: string;
  campaignId: string;
}): string | null {
  if (!input.baseUrl || !isValidUrl(input.baseUrl)) return null;
  return buildNaverTrackingLink(input);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const snsTypeArb: fc.Arbitrary<SnsType> = fc.constantFrom(
  "INSTAGRAM" as const,
  "YOUTUBE" as const,
);

/** Valid HTTPS base URLs with optional paths and no pre-existing query params. */
const validBaseUrlArb = fc.webUrl({
  validSchemes: ["https"],
  withFragments: false,
  withQueryParameters: false,
});

/** Non-empty seller IDs (cuid-like strings). */
const sellerIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter(
  (s) => s.trim().length > 0,
);

/** Non-empty campaign IDs. */
const campaignIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter(
  (s) => s.trim().length > 0,
);

/**
 * Strings that are NOT valid URLs per the URL constructor.
 * Note: "javascript:alert(1)" IS parseable by new URL(), so it is excluded here.
 * The validation boundary is: does `new URL(str)` throw?
 */
const invalidUrlArb = fc.oneof(
  fc.constant(""),
  fc.constant("not-a-url"),
  fc.constant("://missing-scheme"),
  fc.constant("just some text with spaces"),
  fc.constant("example.com"),          // bare domain, no scheme
  fc.constant("//no-scheme.com/path"), // protocol-relative, not a valid URL
  // Random strings that won't parse as URLs
  fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((s) => !isValidUrl(s)),
);

// ---------------------------------------------------------------------------
// Property 4: Naver tracking link generation preserves parameters
// Feature: business-logic-automation
// Validates: Requirements 3.1
// ---------------------------------------------------------------------------

describe("Property 4: Naver tracking link generation preserves parameters", () => {
  it("generated URL contains nt_source equal to snsType", () => {
    fc.assert(
      fc.property(
        validBaseUrlArb,
        snsTypeArb,
        sellerIdArb,
        campaignIdArb,
        (baseUrl, snsType, sellerId, campaignId) => {
          const result = buildNaverTrackingLink({
            baseUrl,
            snsType,
            sellerId,
            campaignId,
          });

          const parsed = new URL(result);
          expect(parsed.searchParams.get("nt_source")).toBe(snsType);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("generated URL contains nt_medium equal to sellerId", () => {
    fc.assert(
      fc.property(
        validBaseUrlArb,
        snsTypeArb,
        sellerIdArb,
        campaignIdArb,
        (baseUrl, snsType, sellerId, campaignId) => {
          const result = buildNaverTrackingLink({
            baseUrl,
            snsType,
            sellerId,
            campaignId,
          });

          const parsed = new URL(result);
          expect(parsed.searchParams.get("nt_medium")).toBe(sellerId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("generated URL contains nt_detail equal to campaignId", () => {
    fc.assert(
      fc.property(
        validBaseUrlArb,
        snsTypeArb,
        sellerIdArb,
        campaignIdArb,
        (baseUrl, snsType, sellerId, campaignId) => {
          const result = buildNaverTrackingLink({
            baseUrl,
            snsType,
            sellerId,
            campaignId,
          });

          const parsed = new URL(result);
          expect(parsed.searchParams.get("nt_detail")).toBe(campaignId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("generated URL preserves the base path of the input URL", () => {
    fc.assert(
      fc.property(
        validBaseUrlArb,
        snsTypeArb,
        sellerIdArb,
        campaignIdArb,
        (baseUrl, snsType, sellerId, campaignId) => {
          const result = buildNaverTrackingLink({
            baseUrl,
            snsType,
            sellerId,
            campaignId,
          });

          const inputParsed = new URL(baseUrl);
          const outputParsed = new URL(result);

          expect(outputParsed.origin).toBe(inputParsed.origin);
          expect(outputParsed.pathname).toBe(inputParsed.pathname);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("all three tracking parameters are present simultaneously", () => {
    fc.assert(
      fc.property(
        validBaseUrlArb,
        snsTypeArb,
        sellerIdArb,
        campaignIdArb,
        (baseUrl, snsType, sellerId, campaignId) => {
          const result = buildNaverTrackingLink({
            baseUrl,
            snsType,
            sellerId,
            campaignId,
          });

          const parsed = new URL(result);
          expect(parsed.searchParams.has("nt_source")).toBe(true);
          expect(parsed.searchParams.has("nt_medium")).toBe(true);
          expect(parsed.searchParams.has("nt_detail")).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("different snsType values produce different nt_source values", () => {
    fc.assert(
      fc.property(
        validBaseUrlArb,
        sellerIdArb,
        campaignIdArb,
        (baseUrl, sellerId, campaignId) => {
          const instagramResult = buildNaverTrackingLink({
            baseUrl,
            snsType: "INSTAGRAM",
            sellerId,
            campaignId,
          });
          const youtubeResult = buildNaverTrackingLink({
            baseUrl,
            snsType: "YOUTUBE",
            sellerId,
            campaignId,
          });

          const instagramParsed = new URL(instagramResult);
          const youtubeParsed = new URL(youtubeResult);

          expect(instagramParsed.searchParams.get("nt_source")).toBe("INSTAGRAM");
          expect(youtubeParsed.searchParams.get("nt_source")).toBe("YOUTUBE");
          expect(instagramResult).not.toBe(youtubeResult);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Invalid URL rejection for tracking link
// Feature: business-logic-automation
// Validates: Requirements 3.4
// ---------------------------------------------------------------------------

describe("Property 5: Invalid URL rejection for tracking link", () => {
  it("buildTrackingLinkSafe returns null for invalid URLs", () => {
    fc.assert(
      fc.property(
        invalidUrlArb,
        snsTypeArb,
        sellerIdArb,
        campaignIdArb,
        (badUrl, snsType, sellerId, campaignId) => {
          const result = buildTrackingLinkSafe({
            baseUrl: badUrl,
            snsType,
            sellerId,
            campaignId,
          });
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("isValidUrl returns false for empty string", () => {
    expect(isValidUrl("")).toBe(false);
  });

  it("isValidUrl returns false for strings without a scheme", () => {
    fc.assert(
      fc.property(
        fc.domain(),
        (domain) => {
          // A bare domain without scheme is not a valid URL
          expect(isValidUrl(domain)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("isValidUrl returns true for valid https URLs", () => {
    fc.assert(
      fc.property(
        validBaseUrlArb,
        (url) => {
          expect(isValidUrl(url)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("buildTrackingLinkSafe returns a non-null string for valid URLs", () => {
    fc.assert(
      fc.property(
        validBaseUrlArb,
        snsTypeArb,
        sellerIdArb,
        campaignIdArb,
        (baseUrl, snsType, sellerId, campaignId) => {
          const result = buildTrackingLinkSafe({
            baseUrl,
            snsType,
            sellerId,
            campaignId,
          });
          expect(result).not.toBeNull();
          expect(typeof result).toBe("string");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("buildNaverTrackingLink falls back to default URL for invalid base URLs", () => {
    fc.assert(
      fc.property(
        invalidUrlArb.filter((s) => s.length > 0 && !isValidUrl(s)),
        snsTypeArb,
        sellerIdArb,
        campaignIdArb,
        (badUrl, snsType, sellerId, campaignId) => {
          const result = buildNaverTrackingLink({
            baseUrl: badUrl,
            snsType,
            sellerId,
            campaignId,
          });
          const parsed = new URL(result);
          expect(parsed.origin).toBe(new URL(DEFAULT_TRACKING_BASE_URL).origin);
        },
      ),
      { numRuns: 100 },
    );
  });
});
