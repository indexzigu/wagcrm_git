/**
 * Property-based tests for badge color contrast.
 *
 * Feature: pipeline-kanban-remodel
 * Property 5: Badge color contrast meets WCAG AA
 * Validates: Requirements 2.4
 *
 * Tests that all badge color combinations in SUB_STAGE_BADGE_CONFIG meet
 * WCAG AA 4.5:1 contrast ratio between text color and background color.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { SUB_STAGE_BADGE_CONFIG } from "../badge-config";
import type { CampaignStatus } from "../crm-types";

// ---------------------------------------------------------------------------
// Tailwind color hex mapping (default palette)
// ---------------------------------------------------------------------------

const TAILWIND_COLOR_HEX: Record<string, string> = {
  "blue-100": "#dbeafe",
  "blue-800": "#1e40af",
  "slate-100": "#f1f5f9",
  "slate-200": "#e2e8f0",
  "slate-700": "#334155",
  "slate-800": "#1e293b",
  "emerald-100": "#d1fae5",
  "emerald-800": "#065f46",
  // purple-100/800 은 의도적으로 제거했다 — CLOSED 가 purple 을 쓰던 유일한 소비처였고
  // (P8 가드레일 2 회수, 오너 지시 2026-07-30), 매핑을 남겨두면 purple 이 되돌아와도
  // 이 대비 게이트를 통과해 버린다. 되살리지 말 것.
  "amber-100": "#fef3c7",
  "amber-800": "#92400e",
  "orange-100": "#ffedd5",
  "orange-800": "#9a3412",
  "green-100": "#dcfce7",
  "green-800": "#166534",
  "rose-100": "#ffe4e6",
  "rose-800": "#9f1239",
  // Shared status design tokens. Keyed by CSS variable name and kept in sync
  // with the :root definitions in src/app/globals.css. badge-config.ts migrated
  // ACTIVE / SETTLEMENT_IN_PROGRESS / DROPPED onto these tokens per
  // PALETTE_IMPL_SPEC.md (owner-approved 2026-07-09), so the guardrail resolves
  // the arbitrary-value classes (e.g. "bg-[var(--status-success-bg)]") to the
  // real token hex and verifies contrast against the actual rendered colors.
  "--status-success": "#047857",
  "--status-success-bg": "#ECFDF5",
  "--status-caution": "#B45309",
  "--status-caution-bg": "#FFFBEB",
  "--status-caution-text": "#92400E",
  "--status-urgent-text": "#8F3C3C",
  "--status-urgent-bg": "#F9EEEE",
  // ⛔ `transparent` / `foreground` 매핑은 **제거했다**(한 축 규칙, 오너 결정 2026-07-30).
  // 중립이 outline 이던 동안에는 `bg-transparent` 를 "뒤 표면"으로 가정해 판정해야 했고,
  // 그 가정값(표면 종속)이 이 게이트의 약한 고리였다 — 표면이 바뀌면 조용히 낡는다.
  // 지금은 8개 전부 **불투명 채움**이라 대비가 표면과 무관한 한 값으로 확정된다.
  // 되살리지 말 것: `bg-transparent` 를 다시 쓰는 상태가 생기면 그건 축이 흔들린 신호다.
};

// Semantic status tokens resolved to hex. badge-config.ts migrated some entries
// from Tailwind palette keys to CSS-var tokens (승인 팔레트, globals.css). The
// extracted key for e.g. "bg-[var(--status-caution-bg)]" is the whole bracketed
// string, so we resolve those here. Values MUST mirror :root in src/app/globals.css.
const STATUS_TOKEN_HEX: Record<string, string> = {
  "[var(--status-success-bg)]": "#ECFDF5",
  "[var(--status-success)]": "#047857",
  "[var(--status-caution-bg)]": "#FFFBEB",
  "[var(--status-caution)]": "#B45309",
  "[var(--status-urgent-bg)]": "#F9EEEE",
  "[var(--status-urgent-text)]": "#8F3C3C",
};

// ---------------------------------------------------------------------------
// WCAG contrast ratio utilities
// ---------------------------------------------------------------------------

/**
 * Parse a hex color string to RGB components (0-255).
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace("#", "");
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

/**
 * Convert an sRGB channel value (0-255) to its relative luminance component.
 * Per WCAG 2.1: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function linearize(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

/**
 * Compute relative luminance of a color.
 * Per WCAG 2.1: L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Compute WCAG contrast ratio between two colors.
 * Returns a value >= 1 (lighter / darker + 0.05 each).
 */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Extract the color key from a Tailwind class.
 *
 * Handles two shapes:
 * - Default palette classes: "bg-blue-100" / "text-slate-700" → "blue-100" / "slate-700"
 * - Arbitrary-value CSS variable classes: "bg-[var(--status-success-bg)]" →
 *   "--status-success-bg" (the token name, which TAILWIND_COLOR_HEX maps to its
 *   globals.css hex value).
 */
function extractColorKey(tailwindClass: string): string {
  // Remove prefix: "bg-" or "text-"
  const withoutPrefix = tailwindClass.replace(/^(bg-|text-)/, "");
  const varMatch = withoutPrefix.match(/^\[var\((--[a-z0-9-]+)\)\]$/);
  if (varMatch) {
    return varMatch[1];
  }
  return withoutPrefix;
}

// ---------------------------------------------------------------------------
// Property 5: Badge color contrast meets WCAG AA
// Validates: Requirements 2.4
// ---------------------------------------------------------------------------

describe("Property 5: Badge color contrast meets WCAG AA", () => {
  const allStatuses = Object.keys(SUB_STAGE_BADGE_CONFIG) as CampaignStatus[];

  it("all badge color combinations meet WCAG AA 4.5:1 contrast ratio (exhaustive)", () => {
    // Since badge configs are finite, we exhaustively test all 6 statuses
    fc.assert(
      fc.property(
        fc.constantFrom(...allStatuses),
        (status) => {
          const config = SUB_STAGE_BADGE_CONFIG[status];
          const bgKey = extractColorKey(config.bg);
          const textKey = extractColorKey(config.text);

          const bgHex = TAILWIND_COLOR_HEX[bgKey] ?? STATUS_TOKEN_HEX[bgKey];
          const textHex = TAILWIND_COLOR_HEX[textKey] ?? STATUS_TOKEN_HEX[textKey];

          expect(bgHex).toBeDefined();
          expect(textHex).toBeDefined();

          const ratio = contrastRatio(bgHex, textHex);
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Also verify each status individually for clear failure messages
  it.each(allStatuses)(
    "badge for %s has contrast ratio >= 4.5:1",
    (status) => {
      const config = SUB_STAGE_BADGE_CONFIG[status];
      const bgKey = extractColorKey(config.bg);
      const textKey = extractColorKey(config.text);

      const bgHex = TAILWIND_COLOR_HEX[bgKey] ?? STATUS_TOKEN_HEX[bgKey];
      const textHex = TAILWIND_COLOR_HEX[textKey] ?? STATUS_TOKEN_HEX[textKey];

      const ratio = contrastRatio(bgHex, textHex);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    },
  );
});
