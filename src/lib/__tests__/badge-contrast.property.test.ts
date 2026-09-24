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

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  // 토큰 유틸 형태(`bg-status-active/10` → "status-active"). 2026-09-24 SSOT 전수 정렬로
  // badge-config 가 StatusBadge 와 같은 **토큰 유틸**을 쓰게 되면서 추가했다.
  "status-active": "#0A3D62",
  "status-info": "#4A6B82",
  "status-success": "#047857",
  "status-success-bg": "#ECFDF5",
  "status-caution": "#B45309",
  "status-caution-bg": "#FFFBEB",
  "status-urgent-text": "#8F3C3C",
  "status-urgent-bg": "#F9EEEE",
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
 * Extract the color key (and optional alpha) from a Tailwind class.
 *
 * Handles three shapes:
 * - Default palette classes: "bg-slate-100" / "text-slate-700" → "slate-100" / "slate-700"
 * - Token utilities, optionally with alpha: "bg-status-active/10" → "status-active" · 0.1
 * - Arbitrary-value CSS variable classes: "bg-[var(--status-success-bg)]" →
 *   "--status-success-bg" (kept for backward compatibility).
 */
function extractColorKey(tailwindClass: string): { key: string; alpha: number } {
  const withoutPrefix = tailwindClass.replace(/^(bg-|text-)/, "");
  const varMatch = withoutPrefix.match(/^\[var\((--[a-z0-9-]+)\)\]$/);
  if (varMatch) {
    return { key: varMatch[1], alpha: 1 };
  }
  const alphaMatch = withoutPrefix.match(/^(.+)\/(\d+)$/);
  if (alphaMatch) {
    return { key: alphaMatch[1], alpha: Number(alphaMatch[2]) / 100 };
  }
  return { key: withoutPrefix, alpha: 1 };
}

function resolveHex(key: string): string | undefined {
  return TAILWIND_COLOR_HEX[key] ?? STATUS_TOKEN_HEX[key];
}

/** Source-over composite of `fg` at `alpha` onto an opaque `bg` (sRGB, 8-bit). */
function composite(fg: string, alpha: number, bg: string): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const ch = (x: number, y: number) =>
    Math.round(x * alpha + y * (1 - alpha)).toString(16).padStart(2, "0");
  return `#${ch(f.r, b.r)}${ch(f.g, b.g)}${ch(f.b, b.b)}`;
}

/**
 * 알파 틴트 배경은 **뒤 표면에 따라** 대비가 바뀐다(P8 §5 「토큰은 표면 종속」). 이 배지가
 * 실제로 얹히는 두 표면(흰 카드 · slate-50 목록/박스)에서 모두 재고 **낮은 쪽**을 판정한다.
 */
const SURFACES = ["#FFFFFF", "#F8FAFC"] as const;

function worstBadgeContrast(status: CampaignStatus): number {
  const config = SUB_STAGE_BADGE_CONFIG[status];
  const bg = extractColorKey(config.bg);
  const text = extractColorKey(config.text);
  const bgHex = resolveHex(bg.key);
  const textHex = resolveHex(text.key);
  expect(bgHex, `${status} 배경 ${config.bg} 를 hex 로 못 풀었다`).toBeDefined();
  expect(textHex, `${status} 글자 ${config.text} 를 hex 로 못 풀었다`).toBeDefined();
  expect(text.alpha, `${status} 글자에 알파가 있다 — 표면 종속이라 금지`).toBe(1);
  return Math.min(
    ...SURFACES.map((surface) =>
      contrastRatio(composite(bgHex!, bg.alpha, surface), textHex!),
    ),
  );
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
          expect(worstBadgeContrast(status)).toBeGreaterThanOrEqual(4.5);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Also verify each status individually for clear failure messages
  it.each(allStatuses)(
    "badge for %s has contrast ratio >= 4.5:1",
    (status) => {
      expect(worstBadgeContrast(status)).toBeGreaterThanOrEqual(4.5);
    },
  );
});

// 위 hex 표는 손으로 옮긴 사본이다 — globals.css 의 값이 바뀌면 이 게이트가 **옛 값으로**
// 초록을 낸다. 토큰 유틸 키는 정본 :root 선언과 문자 그대로 대조한다.
describe("STATUS_TOKEN_HEX 는 globals.css :root 와 같다", () => {
  const globals = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  const tokenKeys = Object.keys(STATUS_TOKEN_HEX).filter((k) => k.startsWith("status-"));

  it("대조 대상이 비어 있지 않다(앵커 붕괴 시 공허 통과 방지)", () => {
    expect(tokenKeys.length).toBeGreaterThanOrEqual(8);
  });

  it.each(tokenKeys)("--%s", (key) => {
    const match = globals.match(new RegExp(`--${key}:\\s*(#[0-9A-Fa-f]{6})`));
    expect(match, `globals.css 에 --${key} 선언이 없다`).not.toBeNull();
    expect(match![1].toUpperCase()).toBe(STATUS_TOKEN_HEX[key].toUpperCase());
  });
});
