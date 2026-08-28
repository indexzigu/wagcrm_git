/**
 * Contrast tests for the SHARED Badge variants in src/components/ui/badge.tsx.
 *
 * These `status-*` variants render `text-<token>` over a `bg-<base>/10` tint
 * (the base color composited at 10% opacity over the card/page white). The
 * amber `status-pending` variant originally used the base color as its own
 * text color, which fails WCAG AA on the near-white tint (~2.1:1). It now uses
 * a dedicated dark-amber text token (`--status-pending-text`), mirroring the
 * earlier `--status-urgent-text` precedent.
 *
 * NOTE: distinct from badge-contrast.property.test.ts, which covers the kanban
 * SUB_STAGE_BADGE_CONFIG (Tailwind palette pairs), not these shared variants.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// WCAG contrast utilities (mirrors badge-contrast.property.test.ts)
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace("#", "");
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

function linearize(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  return (
    0.2126 * linearize(rgb.r) +
    0.7152 * linearize(rgb.g) +
    0.0722 * linearize(rgb.b)
  );
}

function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite a foreground color over an opaque background at a given alpha.
 * Models Tailwind's `bg-<color>/10` = base color at 10% over the page white.
 */
function composite(
  fg: { r: number; g: number; b: number },
  bg: { r: number; g: number; b: number },
  alpha: number,
): { r: number; g: number; b: number } {
  return {
    r: alpha * fg.r + (1 - alpha) * bg.r,
    g: alpha * fg.g + (1 - alpha) * bg.g,
    b: alpha * fg.b + (1 - alpha) * bg.b,
  };
}

// Token values from src/app/globals.css (:root)
const WHITE = { r: 255, g: 255, b: 255 };
const STATUS_PENDING = hexToRgb("#F59E0B"); // --status-pending (tint base)
const STATUS_PENDING_TEXT = hexToRgb("#B45309"); // --status-pending-text (new)

describe("shared Badge status-pending variant contrast", () => {
  const tintBg = composite(STATUS_PENDING, WHITE, 0.1); // bg-status-pending/10

  it("regression: base amber text on the tint fails WCAG AA (why the fix exists)", () => {
    const ratio = contrastRatio(STATUS_PENDING, tintBg);
    expect(ratio).toBeLessThan(4.5);
  });

  it("dark-amber text token on the tint meets WCAG AA 4.5:1", () => {
    const ratio = contrastRatio(STATUS_PENDING_TEXT, tintBg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
