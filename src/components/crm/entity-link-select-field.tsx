"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";

type EntityLinkSelectFieldProps = {
  label?: string;
  required?: boolean;
  selected: boolean;
  selectedContent?: ReactNode;
  emptyText: string;
  actionLabel: string;
  changeLabel?: string;
  description?: string;
  error?: string;
  disabled?: boolean;
  onOpen: () => void;
};

export function EntityLinkSelectField({
  label,
  required = false,
  selected,
  selectedContent,
  emptyText,
  actionLabel,
  changeLabel = "변경",
  description,
  error,
  disabled = false,
  onOpen,
}: EntityLinkSelectFieldProps) {
  return (
    <Field data-invalid={!!error}>
      {label && (
        <FieldLabel>
          {label}
          {required && <span className="text-destructive">*</span>}
        </FieldLabel>
      )}
      {selected ? (
        <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-card p-3.5 shadow-soft-sm">
          <div className="min-w-0 flex-1 pr-2">{selectedContent}</div>
          {!disabled && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 rounded-lg text-xs"
              onClick={onOpen}
            >
              {changeLabel}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-4">
          <span className="text-xs text-muted-foreground">{emptyText}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 rounded-lg text-xs"
            onClick={onOpen}
          >
            {actionLabel}
          </Button>
        </div>
      )}
      {description && <FieldDescription className="text-xs">{description}</FieldDescription>}
      <FieldError className="text-xs">{error}</FieldError>
    </Field>
  );
}
