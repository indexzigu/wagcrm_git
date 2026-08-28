"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { filterBySearchText } from "@/lib/search-filter";

// --- Types ---

export type CategoryTag = {
  id: string;
  name: string;
};

export type CategoryTagInputProps = {
  selectedTags: CategoryTag[];
  maxTags?: number; // default 5
  sellerId: string;
  onTagsChange: (tags: CategoryTag[]) => void;
  onError?: (message: string) => void;
};

// --- Pure utility functions (exported for testing) ---

/**
 * Filter categories by query string (case-insensitive contains).
 * Excludes already-selected tags from results.
 */
export function filterCategories(
  query: string,
  options: CategoryTag[],
  selectedIds: Set<string>,
): CategoryTag[] {
  const available = options.filter((opt) => !selectedIds.has(opt.id));
  return filterBySearchText(available, query, (opt) => [opt.name]);
}

/**
 * Find an existing category option that matches the given name (case-insensitive).
 */
export function findExistingByName(
  name: string,
  options: CategoryTag[],
): CategoryTag | undefined {
  const lowerName = name.toLowerCase();
  return options.find((opt) => opt.name.toLowerCase() === lowerName);
}

// --- Component ---

export function CategoryTagInput({
  selectedTags,
  maxTags = 5,
  sellerId,
  onTagsChange,
  onError,
}: CategoryTagInputProps) {
  const [query, setQuery] = useState("");
  const [allOptions, setAllOptions] = useState<CategoryTag[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [tempTags, setTempTags] = useState<CategoryTag[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch all available categories on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchCategories() {
      try {
        const res = await fetch("/api/categories");
        if (res.ok && !cancelled) {
          const data = await res.json();
          setAllOptions(data.categories ?? []);
        }
      } catch {
        // Silently fail — options will be empty
      }
    }
    void fetchCategories();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const selectedIds = useMemo(
    () => new Set(tempTags.map((tag) => tag.id)),
    [tempTags],
  );

  const filteredOptions = query.trim()
    ? filterCategories(query, allOptions, selectedIds)
    : [];

  const hasExactMatch = query.trim()
    ? allOptions.some(
        (opt) => opt.name.toLowerCase() === query.trim().toLowerCase(),
      )
    : false;

  const startEditing = () => {
    setTempTags(selectedTags);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setQuery("");
    setDropdownOpen(false);
    setIsEditing(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/sellers/${sellerId}/categories`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryIds: tempTags.map((t) => t.id) }),
      });
      if (!res.ok) {
        throw new Error("저장 실패");
      }
      const data = await res.json();
      onTagsChange(data.categories ?? tempTags);
      setIsEditing(false);
      toast.success("카테고리가 저장되었습니다");
    } catch {
      onError?.("카테고리 저장에 실패했습니다. 다시 시도해주세요.");
    } finally {
      setIsSaving(false);
    }
  };

  // Add a tag to temporary list
  const addTag = useCallback(
    (tag: CategoryTag) => {
      if (tempTags.length >= maxTags) return;
      if (selectedIds.has(tag.id)) return;

      setTempTags((prev) => [...prev, tag]);
      setQuery("");
      setDropdownOpen(false);
    },
    [tempTags.length, maxTags, selectedIds],
  );

  // Remove a tag from temporary list
  const removeTag = useCallback(
    (tagId: string) => {
      setTempTags((prev) => prev.filter((t) => t.id !== tagId));
    },
    [],
  );

  // Handle Enter key — create new option or select existing in tempTags
  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.preventDefault();

      const trimmed = query.trim();
      if (!trimmed) return;
      if (tempTags.length >= maxTags) return;

      if (trimmed.length > 30) {
        onError?.("카테고리 이름은 최대 30자까지 가능합니다.");
        return;
      }

      setLoading(true);
      try {
        const existing = findExistingByName(trimmed, allOptions);
        if (existing) {
          if (!selectedIds.has(existing.id)) {
            setTempTags((prev) => [...prev, existing]);
          }
          setQuery("");
          setDropdownOpen(false);
          setLoading(false);
          return;
        }

        const res = await fetch("/api/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });

        if (!res.ok) {
          throw new Error("카테고리 생성 실패");
        }

        const newCategory: CategoryTag = await res.json();

        setAllOptions((prev) => {
          if (prev.some((o) => o.id === newCategory.id)) return prev;
          return [...prev, newCategory];
        });

        if (!selectedIds.has(newCategory.id)) {
          setTempTags((prev) => [...prev, newCategory]);
        }
        setQuery("");
        setDropdownOpen(false);
      } catch {
        onError?.("카테고리 생성에 실패했습니다. 다시 시도해주세요.");
      } finally {
        setLoading(false);
      }
    },
    [query, tempTags.length, maxTags, allOptions, selectedIds, onError],
  );

  // Display Mode
  if (!isEditing) {
    return (
      <div
        className={cn(
          "group/field flex w-full items-center justify-end gap-1.5 rounded-md px-0 py-0 transition-colors min-h-[30px] cursor-pointer",
          "bg-transparent hover:bg-transparent border border-transparent hover:border-transparent",
        )}
        onClick={startEditing}
      >
        <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/field:opacity-100 transition-opacity" />
        <div className="flex flex-wrap gap-1 min-w-0 justify-end">
          {selectedTags.length > 0 ? (
            selectedTags.map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="max-w-[85px] truncate text-[11px] px-2 py-0 h-5.5 bg-slate-50 text-slate-600 rounded-sm font-medium border-0 shadow-none"
              >
                {tag.name}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground h-5.5 flex items-center justify-end font-medium px-1">-</span>
          )}
        </div>
      </div>
    );
  }

  // Edit Mode
  return (
    <div
      ref={containerRef}
      className="relative rounded-md border border-slate-200 bg-white p-3 space-y-3 shadow-soft-sm animate-fade-in"
    >
      {/* Selected tags */}
      <div className="flex flex-wrap gap-1.5 min-h-[24px]">
        {tempTags.length > 0 ? (
          tempTags.map((tag) => (
            <Badge
              key={tag.id}
              variant="secondary"
              className="gap-1 pr-1"
            >
              <span className="max-w-[120px] truncate text-xs">{tag.name}</span>
              <button
                type="button"
                onClick={() => removeTag(tag.id)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20 transition-colors"
                aria-label={`${tag.name} 제거`}
                disabled={isSaving}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">지정된 카테고리가 없습니다</span>
        )}
      </div>

      {/* Input field */}
      <div className="relative">
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim()) {
              setDropdownOpen(true);
            } else {
              setDropdownOpen(false);
            }
          }}
          onFocus={() => {
            if (query.trim()) setDropdownOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            tempTags.length >= maxTags
              ? `최대 ${maxTags}개 카테고리 도달`
              : "카테고리 검색 또는 새로 추가..."
          }
          disabled={tempTags.length >= maxTags || loading || isSaving}
          className="h-8 text-sm bg-white"
          aria-label="카테고리 입력"
        />

        {/* Dropdown */}
        {dropdownOpen && query.trim() && tempTags.length < maxTags && (
          <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-overlay max-h-[180px] overflow-y-auto p-1">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => addTag(opt)}
                  className={cn(
                    "w-full rounded-sm px-2 py-1.5 text-left text-sm",
                    "hover:bg-accent hover:text-accent-foreground",
                    "transition-colors cursor-pointer",
                  )}
                  disabled={isSaving}
                >
                  {opt.name}
                </button>
              ))
            ) : null}

            {/* Show "create new" option when no exact match exists */}
            {!hasExactMatch && query.trim().length <= 30 && (
              <button
                type="button"
                onClick={async () => {
                  const trimmed = query.trim();
                  if (!trimmed || tempTags.length >= maxTags || trimmed.length > 30) {
                    return;
                  }

                  setLoading(true);
                  try {
                    const existing = findExistingByName(trimmed, allOptions);
                    if (existing) {
                      if (!selectedIds.has(existing.id)) {
                        setTempTags((prev) => [...prev, existing]);
                      }
                      setQuery("");
                      setDropdownOpen(false);
                      return;
                    }

                    const res = await fetch("/api/categories", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: trimmed }),
                    });

                    if (!res.ok) {
                      throw new Error("카테고리 생성 실패");
                    }

                    const newCategory: CategoryTag = await res.json();
                    setAllOptions((prev) => {
                      if (prev.some((option) => option.id === newCategory.id)) return prev;
                      return [...prev, newCategory];
                    });

                    if (!selectedIds.has(newCategory.id)) {
                      setTempTags((prev) => [...prev, newCategory]);
                    }

                    setQuery("");
                    setDropdownOpen(false);
                  } catch {
                    onError?.("카테고리 생성에 실패했습니다. 다시 시도해주세요.");
                  } finally {
                    setLoading(false);
                  }
                }}
                className={cn(
                  "w-full rounded-sm px-2 py-1.5 text-left text-sm",
                  "hover:bg-accent hover:text-accent-foreground",
                  "transition-colors cursor-pointer text-muted-foreground",
                )}
                disabled={isSaving}
              >
                <span className="font-medium text-foreground">&quot;{query.trim()}&quot;</span>{" "}
                새 옵션 추가
              </button>
            )}

            {filteredOptions.length === 0 && hasExactMatch && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                이미 등록된 카테고리입니다.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-2 shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCancel}
          disabled={isSaving}
          className="h-7 text-xs px-2.5"
        >
          취소
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={isSaving}
          className="h-7 text-xs px-2.5"
        >
          {isSaving ? "저장 중..." : "저장"}
        </Button>
      </div>
    </div>
  );
}
