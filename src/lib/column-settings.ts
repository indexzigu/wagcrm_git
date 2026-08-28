import type { CampaignStatus } from "./crm-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ColumnState = {
  collapsed: boolean;
  visible: boolean;
};

export type ColumnSettings = Record<CampaignStatus, ColumnState>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "pipeline-column-settings";

/** Canonical pipeline stage order used for column positioning. */
export const PIPELINE_STAGE_ORDER: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
  "DROPPED",
];

/** Default settings: COMPLETED is collapsed by default, all columns visible. */
export const DEFAULT_COLUMN_SETTINGS: ColumnSettings = {
  PROPOSAL: { collapsed: false, visible: true },
  PREPARATION: { collapsed: false, visible: true },
  ACTIVE: { collapsed: false, visible: true },
  CLOSED: { collapsed: false, visible: true },
  SETTLEMENT_WAIT: { collapsed: false, visible: true },
  SETTLEMENT_IN_PROGRESS: { collapsed: false, visible: true },
  COMPLETED: { collapsed: true, visible: true },
  DROPPED: { collapsed: true, visible: true },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that a parsed object is a valid ColumnSettings.
 * Returns true only if every CampaignStatus key exists with proper boolean fields.
 */
function isValidColumnSettings(value: unknown): value is ColumnSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  for (const status of PIPELINE_STAGE_ORDER) {
    const state = obj[status];
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      return false;
    }
    const s = state as Record<string, unknown>;
    if (typeof s.collapsed !== "boolean" || typeof s.visible !== "boolean") {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// localStorage utilities
// ---------------------------------------------------------------------------

/**
 * Loads column settings from localStorage.
 * Falls back to DEFAULT_COLUMN_SETTINGS on any error (missing, corrupt, invalid).
 */
export function loadColumnSettings(): ColumnSettings {
  try {
    if (typeof window === "undefined") {
      return DEFAULT_COLUMN_SETTINGS;
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_COLUMN_SETTINGS;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isValidColumnSettings(parsed)) {
      console.warn(
        "[column-settings] Corrupt localStorage data detected, falling back to defaults.",
      );
      return DEFAULT_COLUMN_SETTINGS;
    }

    return parsed;
  } catch {
    console.warn(
      "[column-settings] Failed to load column settings from localStorage, falling back to defaults.",
    );
    return DEFAULT_COLUMN_SETTINGS;
  }
}

/**
 * Saves column settings to localStorage as JSON.
 */
export function saveColumnSettings(settings: ColumnSettings): void {
  try {
    if (typeof window === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    console.warn("[column-settings] Failed to save column settings to localStorage.");
  }
}

// ---------------------------------------------------------------------------
// Column visibility toggle
// ---------------------------------------------------------------------------

/**
 * Attempts to toggle a column's visibility.
 * Returns the updated settings if the toggle is allowed, or `null` if the
 * operation is rejected (e.g., trying to hide the last visible column).
 *
 * Invariant: At least one column must remain visible at all times.
 */
export function toggleColumnVisibility(
  settings: ColumnSettings,
  stage: CampaignStatus,
  visible: boolean,
): ColumnSettings | null {
  // If we're trying to hide a column, check the minimum-one-visible invariant
  if (!visible) {
    const visibleCount = PIPELINE_STAGE_ORDER.filter(
      (s) => settings[s].visible,
    ).length;
    if (visibleCount <= 1) {
      return null; // Reject: cannot hide the last visible column
    }
  }

  return {
    ...settings,
    [stage]: { ...settings[stage], visible },
  };
}
