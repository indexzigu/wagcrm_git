"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, CircleHelp, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { filterBySearchText } from "@/lib/search-filter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InlineEditFieldProps = {
  label: string;
  /** Helper description shown below the label */
  description?: string;
  /** Hide helper copy while editing and bias width toward the input. */
  prioritizeEditorWidth?: boolean;
  /** Render description as a tooltip beside the label instead of inline helper text. */
  descriptionAsTooltip?: boolean;
  value: string;
  /** Custom display text (e.g. formatted currency). Falls back to `value`. */
  displayValue?: string;
  fieldType: "text" | "number" | "select" | "searchable-select";
  /** Options for select / searchable-select field types */
  options?: { value: string; label: string }[];
  /** If true, renders as read-only with a "자동" badge (no edit icon) */
  isComputed?: boolean;
  /** Async save handler. Throw or reject to trigger revert + error toast. */
  onSave: (value: string | number) => Promise<void>;
  /** Client-side validation. Return error message string or null if valid. */
  validate?: (value: string) => string | null;
  className?: string;
  /** Optional badge text displayed next to value in display mode */
  badgeText?: string;
  /** Optional action button element shown on the right side of the value in display mode */
  actionButton?: React.ReactNode;
  /**
   * 라벨·값을 **둘 다** 말줄임 없이 보여준다(라벨이 필요한 폭을 먼저 확보하고 값이 나머지).
   *
   * 기본값(값 truncate)은 "값이 길면 잘라도 맥락으로 짐작된다"를 전제하는데, 주민등록번호처럼
   * **정확히 옮겨 적어야 하는 값**은 한 자리만 잘려도 못 쓴다. 이런 필드는 라벨도 길어서
   * (`주민등록번호`) 좁은 칸에서 함께 깨지므로, 호출부는 전체폭 레이아웃을 함께 써야 한다.
   */
  preserveValueText?: boolean;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InlineEditField({
  label,
  description,
  prioritizeEditorWidth = false,
  descriptionAsTooltip = false,
  value,
  displayValue,
  fieldType,
  options,
  isComputed = false,
  onSave,
  validate,
  className,
  badgeText,
  actionButton,
  preserveValueText = false,
}: InlineEditFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [optimisticValue, setOptimisticValue] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayVal = optimisticValue ?? value;
  const shownText = displayValue ?? getOptionLabel(displayVal, options) ?? (displayVal || "-");

  const labelBlock = (
    <div className="min-w-0">
      <div className="flex items-center gap-1">
        {/* whitespace-nowrap — 라벨이 두 줄로 줄바꿈되면 고정 높이(h-9) 행을 넘쳐
            옆 툴팁 아이콘과 겹치던 실사고가 있었다(긴 라벨을 좁은 칸에 넣은 경우).
            ⚠️ 말줄임(truncate)으로 처리하지 않는다 — 필드 제목은 그 칸이 무슨 값인지
            알려주는 유일한 단서라 "주민등록…"처럼 잘리면 식별이 안 된다. 폭이 모자라면
            줄이는 게 아니라 **레이아웃이 폭을 내줘야 한다**(호출부에서 전체폭 사용). */}
        <span className="whitespace-nowrap text-xs text-muted-foreground">{label}</span>
        {description && descriptionAsTooltip ? (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground"
                  aria-label={`${label} 설명`}
                >
                  <CircleHelp className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="start"
                className="max-w-[240px] rounded-lg border-0 bg-slate-900 px-2.5 py-1.5 text-[11px] leading-normal text-white shadow-overlay"
              >
                {description}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      {description && !descriptionAsTooltip && !(prioritizeEditorWidth && fieldType === "number") ? (
        <span className="text-[10px] text-muted-foreground/70">{description}</span>
      ) : null}
    </div>
  );

  // Sync draft when value changes externally
  useEffect(() => {
    if (!isEditing) {
      // Intentional sync so display-mode updates replace any stale draft.
       
      setDraft(value);
    }
  }, [value, isEditing]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // --- Save logic ---
  const handleSave = useCallback(
    async (newValue: string) => {
      setIsEditing(false);

      // No change — skip
      if (newValue === displayVal) return;

      // Client-side validation
      if (validate) {
        const error = validate(newValue);
        if (error) {
          toast.error(error);
          setDraft(displayVal);
          return;
        }
      }

      // Optimistic update
      setOptimisticValue(newValue);
      setIsSaving(true);

      const saveValue = fieldType === "number" ? Number(newValue) : newValue;
      const promise = onSave(saveValue);

      withMutationFeedback(promise, undefined, "저장 실패").catch(() => {});

      try {
        await promise;
        setOptimisticValue(null);
      } catch {
        // Revert on failure
        setOptimisticValue(null);
      } finally {
        setIsSaving(false);
      }
    },
    [displayVal, fieldType, onSave, validate]
  );

  // --- Cancel logic ---
  const handleCancel = useCallback(() => {
    setDraft(displayVal);
    setIsEditing(false);
  }, [displayVal]);

  // --- Key handlers ---
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        handleCancel();
      }
    },
    [handleCancel]
  );

  // --- Computed (read-only) field ---
  if (isComputed) {
    return (
      <div className={cn(
        "group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors w-full min-w-0 h-9",
        "bg-muted/50",
        className,
      )}>
        {labelBlock}
        <div className="flex items-center gap-1.5 min-w-0 max-w-[70%] justify-end" title={shownText}>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] shrink-0">
            자동
          </Badge>
          <span className="text-xs font-medium text-foreground truncate text-right">{shownText}</span>
        </div>
      </div>
    );
  }

  // --- Select field type ---
  if (fieldType === "select" && options) {
    return (
      <div className={cn(
        "group flex items-center justify-between gap-2 rounded-md px-2 py-1 transition-colors h-9",
        "bg-white hover:bg-accent/50 cursor-pointer",
        className,
      )}>
        <div className="flex flex-col shrink-0">
          <span className="text-xs text-muted-foreground">{label}</span>
          {description && <span className="text-[10px] text-muted-foreground/70">{description}</span>}
        </div>
        <Select
          value={displayVal}
          onValueChange={(newVal) => handleSave(newVal)}
          disabled={isSaving}
        >
          <SelectTrigger
            className="h-7 w-auto min-w-[80px] max-w-[160px] rounded-md border-transparent bg-transparent pl-2 pr-0 text-xs font-medium text-foreground shadow-none hover:bg-transparent focus:ring-0 transition-colors"
          >
            <SelectValue>
              {getOptionLabel(displayVal, options) ?? displayVal}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    );
  }

  // --- Searchable-select field type ---
  if (fieldType === "searchable-select" && options) {
    return (
      <SearchableSelectField
        label={label}
        value={displayVal}
        options={options}
        onSave={handleSave}
        isSaving={isSaving}
        className={className}
      />
    );
  }

  // --- Text / Number: Edit mode ---
  if (isEditing) {
    return (
      <div className={cn(
        "group grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(148px,44%)] items-center gap-3 rounded-md px-2 py-1 transition-colors h-9",
        "bg-white",
        className,
      )}>
        {labelBlock}
        <input
          ref={inputRef}
          type={fieldType === "number" ? "number" : "text"}
          inputMode={fieldType === "number" ? "numeric" : "text"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => handleSave(draft)}
          onKeyDown={handleKeyDown}
          className={cn(
            "h-7 w-full min-w-0 justify-self-end rounded-md border border-slate-200 bg-white px-2 text-xs text-right shadow-none outline-none focus:border-slate-300 focus:ring-0",
            prioritizeEditorWidth && fieldType === "number"
              ? "max-w-[220px]"
              : "max-w-[200px]",
          )}
        />
      </div>
    );
  }

  // --- Text / Number: Display mode ---
  return (
    <div className={cn(
      "group/field grid w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 transition-colors h-9",
      // preserveValueText: 라벨은 필요한 만큼(max-content) 먼저 확보하고 값이 나머지를
      // 우측 정렬로 채운다 — 라벨·값 **둘 다 잘리면 안 되는** 필드의 배치다(주민등록번호:
      // 제목이 잘리면 무슨 칸인지 모르고, 값이 잘리면 옮겨 적을 수 없다).
      // 기본값은 값 컬럼을 44%로 묶고 넘치면 값을 말줄임한다(대부분 필드는 그게 낫다).
      preserveValueText
        ? "grid-cols-[max-content_minmax(0,1fr)]"
        : "grid-cols-[minmax(0,1fr)_minmax(148px,44%)]",
      "bg-white hover:bg-accent/50 cursor-pointer",
      className,
    )}>
      {labelBlock}
      <div className="flex min-w-0 w-full items-center justify-end gap-1.5 justify-self-end">
        <button
          type="button"
          onClick={() => {
            setDraft(displayVal);
            setIsEditing(true);
          }}
          disabled={isSaving}
          aria-label={`${label} 수정`}
          title={shownText}
          className="flex w-full min-w-0 items-center justify-end gap-1.5 rounded px-0 py-0.5 text-xs text-foreground transition-colors hover:bg-transparent"
        >
          <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/field:opacity-100 transition-opacity" />
          {badgeText && (
            <Badge variant="secondary" className="px-1.5 py-0 h-4 text-[9px] bg-red-50 text-red-600 border border-red-100 font-semibold shrink-0">
              {badgeText}
            </Badge>
          )}
          <span
            className={cn(
              "font-medium text-right",
              // 옮겨 적어야 하는 값은 자르지 않는다 — 한 자리만 잘려도 못 쓴다.
              preserveValueText ? "whitespace-nowrap tabular-nums" : "truncate",
            )}
          >
            {shownText}
          </span>
        </button>
        {actionButton}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Searchable Select Sub-Component
// ---------------------------------------------------------------------------

type SearchableSelectFieldProps = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onSave: (value: string) => Promise<void>;
  isSaving: boolean;
  className?: string;
};

function SearchableSelectField({
  label,
  value,
  options,
  onSave,
  isSaving,
  className,
}: SearchableSelectFieldProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedLabel = getOptionLabel(value, options) ?? (value || "-");

  // Manual filtering for Korean IME support (shouldFilter={false}); the shared
  // util adds NFC normalization + choseong (초성) search.
  const filtered = filterBySearchText(options, search, (opt) => [opt.label]);

  const handleSelect = useCallback(
    (selectedValue: string) => {
      setOpen(false);
      setSearch("");
      if (selectedValue !== value) {
        onSave(selectedValue);
      }
    },
    [value, onSave]
  );

  return (
    <div className={cn(
      "group/field flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors h-9",
      "bg-white hover:bg-accent/50 cursor-pointer",
      className,
    )}>
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isSaving}
            className="flex items-center gap-1 min-w-0 max-w-[160px] rounded-md pl-2 pr-0 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-transparent"
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover/field:opacity-100 transition-opacity" />
          </button>
        </PopoverTrigger>
        {/* ⚠️ 포털 금지. 이 필드가 사는 곳은 상세 패널 **Sheet**(= Radix Dialog)이고,
            Dialog 는 내용을 RemoveScroll 로 감싸며 예외(shards)를 그 컨텐츠 하나로만
            준다. body 로 포털하면 목록이 shard 밖이라 wheel 이 preventDefault 되어
            **클릭은 되는데 스크롤만 죽는다** — 셀러가 몇십 명만 돼도 max-h-[300px]
            를 넘겨 소개자를 고를 수 없다. 근거는 ui/popover.tsx 의 portal 주석.
            비포털은 접근성상으로도 옳다: 포털본은 aria-modal 바깥이라 스크린리더가
            목록을 통째로 숨겼을 가능성이 높다. */}
        <PopoverContent className="w-[200px] p-0" align="end" portal={false}>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="검색..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>검색 결과 없음</CommandEmpty>
              <CommandGroup>
                {filtered.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.value}
                    onSelect={handleSelect}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-3",
                        value === opt.value ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {opt.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOptionLabel(
  value: string,
  options?: { value: string; label: string }[]
): string | undefined {
  if (!options) return undefined;
  return options.find((opt) => opt.value === value)?.label;
}
