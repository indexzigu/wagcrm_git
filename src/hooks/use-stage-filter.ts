"use client";

import { useSyncExternalStore, useCallback, useMemo } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StageFilter = "ALL" | "SALES" | "PROGRESS" | "SETTLEMENT";

export type ViewMode = "kanban" | "table" | "report";

export type SavedView =
  | "DEFAULT"
  | "URGENT"
  | "STAGNANT"
  | "MISSING_SALES"
  | "MANUAL_MARGIN";

export interface PipelineUrlParams {
  stage?: StageFilter;
  team?: string;
  search?: string;
  savedView?: SavedView;
  viewMode?: ViewMode;
}

export interface UseStageFilterReturn {
  stageFilter: StageFilter;
  setStageFilter: (filter: StageFilter) => void;
  teamFilter: string | null;
  setTeamFilter: (teamId: string | null) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  savedView: SavedView;
  setSavedView: (view: SavedView) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_STAGE_FILTERS: StageFilter[] = ["ALL", "SALES", "PROGRESS", "SETTLEMENT"];
const VALID_VIEW_MODES: ViewMode[] = ["kanban", "table", "report"];
const VALID_SAVED_VIEWS: SavedView[] = [
  "DEFAULT",
  "URGENT",
  "STAGNANT",
  "MISSING_SALES",
  "MANUAL_MARGIN",
];

const VIEW_MODE_STORAGE_KEY = "wag-crm:pipeline:view-mode";
const VIEW_MODE_EVENT = "wag-crm:pipeline:view-mode-change";
const URL_STATE_EVENT = "wag-crm:pipeline:url-state-change";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidStageFilter(value: string | null): value is StageFilter {
  return value != null && VALID_STAGE_FILTERS.includes(value as StageFilter);
}

function isValidViewMode(value: string | null): value is ViewMode {
  return value != null && VALID_VIEW_MODES.includes(value as ViewMode);
}

function isValidSavedView(value: string | null): value is SavedView {
  return value != null && VALID_SAVED_VIEWS.includes(value as SavedView);
}

// ---------------------------------------------------------------------------
// URL serialization / parsing utilities (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Serializes pipeline filter params into a URL search string.
 * Only includes non-default values to keep URLs clean.
 */
export function serializePipelineParams(params: PipelineUrlParams): string {
  const searchParams = new URLSearchParams();

  if (params.stage && params.stage !== "ALL") {
    searchParams.set("stage", params.stage);
  }
  if (params.team) {
    searchParams.set("team", params.team);
  }
  if (params.search) {
    searchParams.set("search", params.search);
  }
  if (params.savedView && params.savedView !== "DEFAULT") {
    searchParams.set("savedView", params.savedView);
  }
  if (params.viewMode && params.viewMode !== "kanban") {
    searchParams.set("viewMode", params.viewMode);
  }

  const result = searchParams.toString();
  return result ? `?${result}` : "";
}

/**
 * Parses a URL search string into pipeline filter params.
 * Invalid values are ignored and defaults are applied.
 */
export function parsePipelineParams(searchString: string): PipelineUrlParams {
  const params = new URLSearchParams(searchString);
  const result: PipelineUrlParams = {};

  const stage = params.get("stage");
  if (isValidStageFilter(stage)) {
    result.stage = stage;
  }

  const team = params.get("team");
  if (team && team.trim().length > 0) {
    result.team = team;
  }

  const search = params.get("search");
  if (search && search.trim().length > 0) {
    result.search = search;
  }

  const savedView = params.get("savedView");
  if (isValidSavedView(savedView)) {
    result.savedView = savedView;
  }

  const viewMode = params.get("viewMode");
  if (isValidViewMode(viewMode)) {
    result.viewMode = viewMode;
  }

  return result;
}

// ---------------------------------------------------------------------------
// External store subscriptions (for useSyncExternalStore)
// ---------------------------------------------------------------------------

function subscribeUrlSearch(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener(URL_STATE_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(URL_STATE_EVENT, callback);
  };
}

function getUrlSearchSnapshot(): string {
  return window.location.search;
}

function getUrlSearchServerSnapshot(): string {
  return "";
}

function subscribeViewMode(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(VIEW_MODE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(VIEW_MODE_EVENT, callback);
  };
}

function getViewModeSnapshot(): ViewMode {
  const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  if (isValidViewMode(stored)) {
    return stored;
  }
  return "kanban";
}

function getViewModeServerSnapshot(): ViewMode {
  return "kanban";
}

function persistViewMode(value: ViewMode) {
  window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, value);
  window.dispatchEvent(new Event(VIEW_MODE_EVENT));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Custom hook that manages pipeline filter state synchronized with URL query params.
 *
 * - Reads initial state from URL query parameters on mount
 * - Updates URL via history.replaceState (no page reload)
 * - Persists viewMode to localStorage for cross-session retention
 * - Falls back to defaults for invalid parameter values
 */
export function useStageFilter(): UseStageFilterReturn {
  // Subscribe to URL search changes
  const urlSearch = useSyncExternalStore(
    subscribeUrlSearch,
    getUrlSearchSnapshot,
    getUrlSearchServerSnapshot,
  );

  // Subscribe to viewMode localStorage changes
  const storedViewMode = useSyncExternalStore(
    subscribeViewMode,
    getViewModeSnapshot,
    getViewModeServerSnapshot,
  );

  // Parse current URL params
  const urlParams = useMemo(() => parsePipelineParams(urlSearch), [urlSearch]);

  // Derive effective values (URL takes precedence, then localStorage/defaults)
  const stageFilter: StageFilter = urlParams.stage ?? "ALL";
  const teamFilter: string | null = urlParams.team ?? null;
  const searchQuery: string = urlParams.search ?? "";
  const savedView: SavedView = urlParams.savedView ?? "DEFAULT";
  const viewMode: ViewMode = urlParams.viewMode ?? storedViewMode;

  // Helper to update URL with new params
  const updateUrl = useCallback(
    (nextParams: PipelineUrlParams) => {
      const currentParams = parsePipelineParams(window.location.search);
      const merged: PipelineUrlParams = { ...currentParams, ...nextParams };
      const newSearch = serializePipelineParams(merged);
      const newUrl = `${window.location.pathname}${newSearch}`;
      window.history.replaceState(null, "", newUrl);
      window.dispatchEvent(new Event(URL_STATE_EVENT));
    },
    [],
  );

  const setStageFilter = useCallback(
    (filter: StageFilter) => {
      updateUrl({ stage: filter });
    },
    [updateUrl],
  );

  const setTeamFilter = useCallback(
    (teamId: string | null) => {
      updateUrl({ team: teamId ?? undefined });
    },
    [updateUrl],
  );

  const setSearchQuery = useCallback(
    (query: string) => {
      updateUrl({ search: query || undefined });
    },
    [updateUrl],
  );

  const setSavedView = useCallback(
    (view: SavedView) => {
      updateUrl({ savedView: view });
    },
    [updateUrl],
  );

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      persistViewMode(mode);
      updateUrl({ viewMode: mode });
    },
    [updateUrl],
  );

  return {
    stageFilter,
    setStageFilter,
    teamFilter,
    setTeamFilter,
    searchQuery,
    setSearchQuery,
    savedView,
    setSavedView,
    viewMode,
    setViewMode,
  };
}
