// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ZoneViewMode = "VIEW_B" | "VIEW_C";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZONE_VIEW_MODE_KEY = "wag-crm:zone-view-mode";

const DEFAULT_ZONE_VIEW_MODE: ZoneViewMode = "VIEW_B";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that a value is a valid ZoneViewMode ("VIEW_B" or "VIEW_C").
 */
export function isValidZoneViewMode(value: unknown): value is ZoneViewMode {
  return value === "VIEW_B" || value === "VIEW_C";
}

// ---------------------------------------------------------------------------
// Zone View Mode — localStorage utilities
// ---------------------------------------------------------------------------

/**
 * Loads the zone view mode from localStorage.
 * Falls back to "VIEW_B" on any error (missing, corrupt, invalid).
 */
export function loadZoneViewMode(): ZoneViewMode {
  try {
    if (typeof window === "undefined") {
      return DEFAULT_ZONE_VIEW_MODE;
    }

    const raw = localStorage.getItem(ZONE_VIEW_MODE_KEY);
    if (raw === null) {
      return DEFAULT_ZONE_VIEW_MODE;
    }

    if (!isValidZoneViewMode(raw)) {
      console.warn(
        "[zone-settings] Invalid zone view mode in localStorage, falling back to default.",
      );
      return DEFAULT_ZONE_VIEW_MODE;
    }

    return raw;
  } catch {
    console.warn(
      "[zone-settings] Failed to load zone view mode from localStorage, falling back to default.",
    );
    return DEFAULT_ZONE_VIEW_MODE;
  }
}

/**
 * Saves the zone view mode to localStorage.
 */
export function saveZoneViewMode(mode: ZoneViewMode): void {
  try {
    if (typeof window === "undefined") {
      return;
    }
    localStorage.setItem(ZONE_VIEW_MODE_KEY, mode);
  } catch {
    console.warn("[zone-settings] Failed to save zone view mode to localStorage.");
  }
}
