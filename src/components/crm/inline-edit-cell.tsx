"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type InlineEditCellProps = {
  value: string;
  onSave: (newValue: string) => Promise<{ success: boolean; error?: string }>;
  type?: "text" | "number" | "select";
  options?: { value: string; label: string }[];
  validate?: (value: string) => string | null; // null = valid
  className?: string;
};

export function InlineEditCell({
  value,
  onSave,
  type = "text",
  options,
  validate,
  className,
}: InlineEditCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [optimisticValue, setOptimisticValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flashError, setFlashError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayValue = optimisticValue ?? value;

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const triggerErrorFlash = useCallback(() => {
    setFlashError(true);
    const timer = setTimeout(() => setFlashError(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  const handleSave = useCallback(
    async (newValue: string) => {
      // Skip if value hasn't changed
      if (newValue === displayValue) {
        setIsEditing(false);
        setError(null);
        return;
      }

      // Client-side validation
      if (validate) {
        const validationError = validate(newValue);
        if (validationError) {
          setError(validationError);
          setDraft(displayValue);
          setIsEditing(false);
          triggerErrorFlash();
          return;
        }
      }

      setIsEditing(false);
      setError(null);

      // Optimistic update
      setOptimisticValue(newValue);

      const result = await onSave(newValue);

      if (!result.success) {
        // Revert on failure
        setOptimisticValue(null);
        setError(result.error || "Save failed");
        triggerErrorFlash();
        return;
      }

      setOptimisticValue(null);
    },
    [displayValue, onSave, validate, triggerErrorFlash]
  );

  const handleCancel = useCallback(() => {
    setDraft(displayValue);
    setIsEditing(false);
    setError(null);
  }, [displayValue]);

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

  const handleSelectChange = useCallback(
    async (newValue: string) => {
      if (newValue === displayValue) return;

      // Client-side validation
      if (validate) {
        const validationError = validate(newValue);
        if (validationError) {
          setError(validationError);
          triggerErrorFlash();
          return;
        }
      }

      setError(null);

      // Optimistic update
      setOptimisticValue(newValue);

      const result = await onSave(newValue);

      if (!result.success) {
        setOptimisticValue(null);
        setError(result.error || "Save failed");
        triggerErrorFlash();
        return;
      }

      setOptimisticValue(null);
    },
    [displayValue, onSave, validate, triggerErrorFlash]
  );

  // Select type renders inline without explicit edit mode toggle
  if (type === "select" && options) {
    const selectedLabel =
      options.find((opt) => opt.value === displayValue)?.label ?? displayValue;

    return (
      <div className={cn("relative", className)}>
        <Select value={displayValue} onValueChange={handleSelectChange}>
          <SelectTrigger
            className={cn(
              "h-8 w-full rounded-md border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-slate-100 focus:ring-0 transition-colors",
              flashError && "border-red-400 bg-red-50 text-red-700"
            )}
          >
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {error && flashError && (
          <span className="absolute -bottom-4 left-2 text-[10px] text-red-500 whitespace-nowrap">
            {error}
          </span>
        )}
      </div>
    );
  }

  // Text/Number editing mode
  if (isEditing) {
    return (
      <div className={cn("relative", className)}>
        <input
          ref={inputRef}
          type={type === "number" ? "number" : "text"}
          inputMode={type === "number" ? "numeric" : "text"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => handleSave(draft)}
          onKeyDown={handleKeyDown}
          className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs shadow-none outline-none focus:border-slate-300 focus:ring-0"
        />
      </div>
    );
  }

  // Display mode (plain text, click to edit)
  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => {
          setDraft(displayValue);
          setError(null);
          setIsEditing(true);
        }}
        className={cn(
          "block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-slate-100",
          flashError && "border border-red-400 bg-red-50 text-red-700"
        )}
      >
        {displayValue || "-"}
      </button>
      {error && flashError && (
        <span className="absolute -bottom-4 left-2 text-[10px] text-red-500 whitespace-nowrap">
          {error}
        </span>
      )}
    </div>
  );
}
