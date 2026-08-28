"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { filterBySearchText } from "@/lib/search-filter";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * SearchableDropdown — shadcn/ui Popover + Command (cmdk) 기반 검색 가능 드롭다운.
 *
 * Korean IME 조합 중 premature filtering을 방지하기 위해
 * `shouldFilter={false}`로 설정하고 filterBySearchText로 자체 필터링한다.
 *
 * Requirements: 3.1, 3.3, 3.4, 3.5, 11.1, 11.3, 11.4, 11.5
 */

export type SearchableDropdownProps<T> = {
  items: T[];
  value: string | null;
  onValueChange: (value: string) => void;
  /** 검색 대상 텍스트 추출 함수 (filterBySearchText의 getSearchableFields로 사용) */
  getSearchableText: (item: T) => string;
  /** 표시 라벨 추출 함수 */
  getLabel: (item: T) => React.ReactNode;
  /** 값 추출 함수 */
  getValue: (item: T) => string;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  /**
   * 검색어 변경 콜백(선택) — 호출자가 서버 검색으로 items를 갱신할 때 사용.
   * 지정해도 클라이언트 필터링은 유지된다(서버 결과를 재필터해도 결과가 줄지 않는 관계).
   */
  onSearchChange?: (query: string) => void;
  /** 서버 검색 진행 중 표시(선택) — 빈 결과 문구를 "검색 중..."으로 대체. */
  searching?: boolean;
  /**
   * Dialog·AlertDialog 안에서 쓸 때 `false` 로 둔다(기본 `true`).
   *
   * Radix Dialog 의 `RemoveScroll` 이 DialogContent 밖에서 일어난 wheel 을
   * 막아버려, body 로 포털된 목록은 **클릭은 되는데 스크롤만 죽는다.**
   * 상세 근거는 `ui/popover.tsx` 의 `portal` prop 주석.
   */
  portal?: boolean;
};

export function SearchableDropdown<T>({
  items,
  value,
  onValueChange,
  getSearchableText,
  getLabel,
  getValue,
  placeholder = "선택하세요",
  emptyMessage = "검색 결과 없음",
  disabled = false,
  onSearchChange,
  searching = false,
  portal = true,
}: SearchableDropdownProps<T>) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  // Manual filtering using filterBySearchText for Korean IME support
  const filteredItems = React.useMemo(
    () =>
      filterBySearchText(items, search, (item) => [getSearchableText(item)]),
    [items, search, getSearchableText],
  );

  // Find the currently selected item's label for display
  const selectedLabel = React.useMemo(() => {
    if (!value) return null;
    const selected = items.find((item) => getValue(item) === value);
    return selected ? getLabel(selected) : null;
  }, [items, value, getValue, getLabel]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal h-auto py-2"
        >
          <div className="flex-1 text-left truncate min-w-0 flex items-center">
            {selectedLabel ?? placeholder}
          </div>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" portal={portal}>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={placeholder}
            value={search}
            onValueChange={(next) => {
              setSearch(next);
              onSearchChange?.(next);
            }}
          />
          <CommandList>
            <CommandEmpty>{searching ? "검색 중..." : emptyMessage}</CommandEmpty>
            <CommandGroup>
              {filteredItems.map((item) => {
                const itemValue = getValue(item);
                const itemLabel = getLabel(item);
                return (
                  <CommandItem
                    key={itemValue}
                    value={itemValue}
                    onSelect={(currentValue) => {
                      onValueChange(currentValue);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4 shrink-0",
                        value === itemValue ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {/* 라벨은 한 줄일 수도 두 줄일 수도 있다(호출자가 정한다) —
                        flex row 로 감싸면 두 번째 줄이 옆으로 눕는다. */}
                    <div className="min-w-0 flex-1">{itemLabel}</div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
