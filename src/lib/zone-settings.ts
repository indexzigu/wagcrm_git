import type { PipelineZone } from "./zone-config";
import { ZONE_ORDER } from "./zone-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ZoneViewMode = "VIEW_B" | "VIEW_C";

export type ZoneCollapseState = Record<Exclude<PipelineZone, "DROPPED">, boolean> &
  Partial<Record<"DROPPED", boolean>>; // true = expanded

export type SalesZoneViewMode = "kanban" | "table";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZONE_VIEW_MODE_KEY = "wag-crm:zone-view-mode";
const ZONE_COLLAPSE_STATE_KEY = "wag-crm:zone-collapse-state";
const SALES_ZONE_VIEW_MODE_KEY = "wag-crm:sales-zone-view-mode";

/** Default collapse state: Settlement zone collapsed, others expanded. */
export const DEFAULT_ZONE_COLLAPSE_STATE: ZoneCollapseState = {
  SALES: true,
  DEAL_EXECUTION: true,
  SETTLEMENT: false,
  DROPPED: false,
};

const DEFAULT_ZONE_VIEW_MODE: ZoneViewMode = "VIEW_B";
const DEFAULT_SALES_ZONE_VIEW_MODE: SalesZoneViewMode = "kanban";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that a value is a valid ZoneViewMode ("VIEW_B" or "VIEW_C").
 */
export function isValidZoneViewMode(value: unknown): value is ZoneViewMode {
  return value === "VIEW_B" || value === "VIEW_C";
}

/**
 * Validates that a value is a valid ZoneCollapseState (Record<PipelineZone, boolean>).
 * Every zone in ZONE_ORDER must be present with a boolean value.
 */
export function isValidZoneCollapseState(value: unknown): value is ZoneCollapseState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  for (const zone of ZONE_ORDER) {
    if (zone === "DROPPED" && obj[zone] === undefined) {
      continue;
    }
    if (typeof obj[zone] !== "boolean") {
      return false;
    }
  }

  return true;
}

/**
 * Validates that a value is a valid SalesZoneViewMode ("kanban" or "table").
 */
function isValidSalesZoneViewMode(value: unknown): value is SalesZoneViewMode {
  return value === "kanban" || value === "table";
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

// ---------------------------------------------------------------------------
// Zone Collapse State — localStorage utilities
// ---------------------------------------------------------------------------

/**
 * Loads the zone collapse state from localStorage.
 * Falls back to DEFAULT_ZONE_COLLAPSE_STATE on any error (missing, corrupt, invalid).
 */
export function loadZoneCollapseState(): ZoneCollapseState {
  try {
    if (typeof window === "undefined") {
      return DEFAULT_ZONE_COLLAPSE_STATE;
    }

    const raw = localStorage.getItem(ZONE_COLLAPSE_STATE_KEY);
    if (raw === null) {
      return DEFAULT_ZONE_COLLAPSE_STATE;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isValidZoneCollapseState(parsed)) {
      console.warn(
        "[zone-settings] Corrupt zone collapse state in localStorage, falling back to defaults.",
      );
      return DEFAULT_ZONE_COLLAPSE_STATE;
    }

    return parsed;
  } catch {
    console.warn(
      "[zone-settings] Failed to load zone collapse state from localStorage, falling back to defaults.",
    );
    return DEFAULT_ZONE_COLLAPSE_STATE;
  }
}

/**
 * Saves the zone collapse state to localStorage as JSON.
 */
export function saveZoneCollapseState(state: ZoneCollapseState): void {
  try {
    if (typeof window === "undefined") {
      return;
    }
    localStorage.setItem(ZONE_COLLAPSE_STATE_KEY, JSON.stringify(state));
  } catch {
    console.warn("[zone-settings] Failed to save zone collapse state to localStorage.");
  }
}

// ---------------------------------------------------------------------------
// Zone Collapse Toggle Logic
// ---------------------------------------------------------------------------

/**
 * Toggles the collapse state of a zone while ensuring at least 1 zone remains expanded.
 * If the target zone is the last expanded zone, the toggle is blocked (returns current state unchanged).
 */
export function toggleZoneCollapse(
  current: ZoneCollapseState,
  zone: PipelineZone,
): ZoneCollapseState {
  const isCurrentlyExpanded = current[zone];

  // If trying to collapse a zone, check if it's the last expanded one
  if (isCurrentlyExpanded) {
    const expandedCount = ZONE_ORDER.filter((z) => current[z]).length;
    if (expandedCount <= 1) {
      // Block collapse — this is the last expanded zone
      return current;
    }
  }

  return {
    ...current,
    [zone]: !isCurrentlyExpanded,
  };
}

// ---------------------------------------------------------------------------
// Sales Zone View Mode — localStorage utilities
// ---------------------------------------------------------------------------

/**
 * Loads the Sales Zone view mode (kanban or table) from localStorage.
 * Falls back to "kanban" on any error (missing, corrupt, invalid).
 */
export function loadSalesZoneViewMode(): SalesZoneViewMode {
  try {
    if (typeof window === "undefined") {
      return DEFAULT_SALES_ZONE_VIEW_MODE;
    }

    const raw = localStorage.getItem(SALES_ZONE_VIEW_MODE_KEY);
    if (raw === null) {
      return DEFAULT_SALES_ZONE_VIEW_MODE;
    }

    if (!isValidSalesZoneViewMode(raw)) {
      console.warn(
        "[zone-settings] Invalid sales zone view mode in localStorage, falling back to default.",
      );
      return DEFAULT_SALES_ZONE_VIEW_MODE;
    }

    return raw;
  } catch {
    console.warn(
      "[zone-settings] Failed to load sales zone view mode from localStorage, falling back to default.",
    );
    return DEFAULT_SALES_ZONE_VIEW_MODE;
  }
}

/**
 * Saves the Sales Zone view mode to localStorage.
 */
export function saveSalesZoneViewMode(mode: SalesZoneViewMode): void {
  try {
    if (typeof window === "undefined") {
      return;
    }
    localStorage.setItem(SALES_ZONE_VIEW_MODE_KEY, mode);
  } catch {
    console.warn("[zone-settings] Failed to save sales zone view mode to localStorage.");
  }
}
