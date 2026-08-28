"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";

const FILTER_KEYS = [
  "tab",
  "q",
  "status",
  "type",
  "snsType",
  "category",
  "partnerId",
  "sellerId",
  "selectedPartner",
  "selectedSeller",
  "assignedTo",
  "startDate",
  "endDate",
  "month",
  "sectionFilter",
  "entityTypeFilter",
  "viewType",
  "year",
] as const;

type FilterKey = (typeof FILTER_KEYS)[number];

interface Filters {
  tab?: string;
  q?: string;
  status?: string;
  type?: string;
  snsType?: string;
  category?: string;
  partnerId?: string;
  sellerId?: string;
  selectedPartner?: string;
  selectedSeller?: string;
  assignedTo?: string;
  startDate?: string;
  endDate?: string;
  month?: string;
  sectionFilter?: string;
  entityTypeFilter?: string;
  viewType?: string;
  year?: string;
}

interface Sort {
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

interface UseFilterParamsReturn {
  filters: Filters;
  sort: Sort;
  setFilter: (key: FilterKey, value: string) => void;
  removeFilter: (key: FilterKey) => void;
  clearFilters: () => void;
  toggleSort: (column: string) => void;
  activeFilterCount: number;
}

export function useFilterParams(): UseFilterParamsReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = useMemo<Filters>(() => {
    const result: Filters = {};
    for (const key of FILTER_KEYS) {
      const value = searchParams.get(key);
      if (value) {
        result[key] = value;
      }
    }
    return result;
  }, [searchParams]);

  const sort = useMemo<Sort>(() => {
    const sortBy = searchParams.get("sortBy") || undefined;
    const sortDir = searchParams.get("sortDir") as "asc" | "desc" | null;
    return {
      sortBy,
      sortDir: sortDir || undefined,
    };
  }, [searchParams]);

  const activeFilterCount = useMemo(() => {
    return FILTER_KEYS.filter((key) => searchParams.get(key)).length;
  }, [searchParams]);

  const updateParams = useCallback(
    (updater: (params: URLSearchParams) => URLSearchParams) => {
      const params = updater(new URLSearchParams(searchParams.toString()));
      router.replace(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname]
  );

  const setFilter = useCallback(
    (key: FilterKey, value: string) => {
      updateParams((params) => {
        params.set(key, value);
        return params;
      });
    },
    [updateParams]
  );

  const removeFilter = useCallback(
    (key: FilterKey) => {
      updateParams((params) => {
        params.delete(key);
        return params;
      });
    },
    [updateParams]
  );

  const clearFilters = useCallback(() => {
    updateParams((params) => {
      for (const key of FILTER_KEYS) {
        params.delete(key);
      }
      return params;
    });
  }, [updateParams]);

  const toggleSort = useCallback(
    (column: string) => {
      updateParams((params) => {
        const currentSortBy = params.get("sortBy");
        const currentSortDir = params.get("sortDir");

        if (currentSortBy !== column) {
          // New column: set to asc
          params.set("sortBy", column);
          params.set("sortDir", "asc");
        } else if (currentSortDir === "asc") {
          // Same column, asc → desc
          params.set("sortDir", "desc");
        } else {
          // Same column, desc → remove
          params.delete("sortBy");
          params.delete("sortDir");
        }
        return params;
      });
    },
    [updateParams]
  );

  return {
    filters,
    sort,
    setFilter,
    removeFilter,
    clearFilters,
    toggleSort,
    activeFilterCount,
  };
}
