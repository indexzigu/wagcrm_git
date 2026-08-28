"use client";

import { useMemo, useState, useEffect } from "react";
import { ArrowUpDownIcon, ArrowUpIcon, ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate, formatRate } from "@/lib/format";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";



export type GridColumn<T extends { id: string }> = {
  key: keyof T & string;
  label: string;
  width: number;
  type?: "text" | "number" | "select" | "currency" | "percent" | "date";
  align?: "left" | "center" | "right";

  options?: Array<{ value: string; label: string }>;
  render?: (row: T) => React.ReactNode;
};

type InlineDataGridProps<T extends { id: string }> = {
  rows: T[];
  columns: GridColumn<T>[];
  onPatch: (id: string, patch: Partial<T>) => Promise<T | null>;
  onDelete?: (row: T) => Promise<boolean>;
  onRowClick?: (row: T) => void;
  globalFilter?: string;
  className?: string;
  disableInlineEdit?: boolean;
  /** Unique ID for persisting column widths to localStorage */
  persistId?: string;
  isLoading?: boolean;
};


export function InlineDataGrid<T extends { id: string }>({
  rows,
  columns,
  onPatch,
  onDelete,
  onRowClick,
  globalFilter = "",
  className,
  disableInlineEdit = false,
  persistId,
  isLoading = false,
}: InlineDataGridProps<T>) {
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(null);

  const totalWidth = useMemo(() => {
    let sum = columns.reduce((acc, col) => acc + col.width, 0);
    if (onDelete) sum += 80;
    return sum;
  }, [columns, onDelete]);

  const [draft, setDraft] = useState("");

  const [sort, setSort] = useState<{
    key: keyof T & string;
    direction: "asc" | "desc";
  } | null>(null);

  // Load persisted sort after mount to avoid hydration mismatch
  useEffect(() => {
    if (persistId) {
      const saved = localStorage.getItem(`${persistId}-sort`);
      if (saved) {
        try {
          setSort(JSON.parse(saved));
        } catch (e) {
          console.error("Failed to parse saved sort state:", e);
        }
      }
    }
  }, [persistId]);

  const visibleRows = useMemo(() => {
    const normalized = globalFilter.trim().toLowerCase();
    const filtered = normalized
      ? rows.filter((row) =>
          columns.some((column) =>
            String(row[column.key] ?? "").toLowerCase().includes(normalized),
          ),
        )
      : rows;

    if (!sort) return filtered;

    return [...filtered].sort((a, b) => {
      // 1. isMonitored 속성이 있는 경우 상단 고정 처리
      const hasMonitored = "isMonitored" in a && "isMonitored" in b;
      if (hasMonitored) {
        const aMonitored = (a as Record<string, any>).isMonitored ? 1 : 0;
        const bMonitored = (b as Record<string, any>).isMonitored ? 1 : 0;
        if (aMonitored !== bMonitored) {
          return bMonitored - aMonitored; // true가 위로 가도록
        }
      }

      const first = a[sort.key];
      const second = b[sort.key];
      if (first == null && second == null) return 0;
      if (first == null) return 1;
      if (second == null) return -1;
      const comparison =
        typeof first === "number" && typeof second === "number"
          ? first - second
          : String(first).localeCompare(String(second), "ko");
      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [columns, globalFilter, rows, sort]);

  async function save(row: T, key: keyof T & string, value: string) {
    setEditing(null);
    const column = columns.find((item) => item.key === key);
    const parsedValue = column?.type === "number" ? Number(value) : value;
    await onPatch(row.id, { [key]: parsedValue } as Partial<T>);
  }

  function toggleSort(key: keyof T & string) {
    setSort((current) => {
      let next: typeof current = null;
      if (current?.key !== key) {
        next = { key, direction: "asc" };
      } else if (current.direction === "asc") {
        next = { key, direction: "desc" };
      } else {
        next = null;
      }

      if (persistId) {
        if (next) {
          localStorage.setItem(`${persistId}-sort`, JSON.stringify(next));
        } else {
          localStorage.removeItem(`${persistId}-sort`);
        }
      }
      return next;
    });
  }

  return (
    <div className={cn("rounded-2xl border border-border/40 bg-white/70 backdrop-blur-md shadow-soft-sm overflow-hidden", className)}>
      <div className="overflow-x-auto">
        <table style={{ minWidth: totalWidth }} className="w-full table-fixed text-[13px]">
          <colgroup>
            {columns.map((column) => (
              <col
                key={`col-${column.key}`}
                style={{ width: column.width, minWidth: 60 }}
              />
            ))}
            {onDelete ? <col style={{ width: 80 }} /> : null}
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-white/85">
              {columns.map((column) => {
                const isSorted = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    className={cn(
                      "group relative h-11 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground",
                      column.align === "right" && "text-right",
                      column.align === "center" && "text-center",
                      (!column.align || column.align === "left") && "text-left"
                    )}
                    style={{ width: column.width, minWidth: 60 }}
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      className={cn(
                        "h-8 rounded-md px-2 text-[11px] font-semibold uppercase tracking-[0.08em] hover:bg-slate-100 hover:text-foreground transition-colors",
                        isSorted
                          ? "text-blue-600 dark:text-blue-400 font-bold bg-blue-50/50 dark:bg-blue-950/20"
                          : "text-muted-foreground",
                        column.align === "right" && "ml-auto -mr-1",
                        column.align === "center" && "mx-auto",
                        (!column.align || column.align === "left") && "-ml-1"
                      )}
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.label}
                      {isSorted ? (
                        sort.direction === "asc" ? (
                          <ArrowUpIcon className="ml-1 size-3 text-blue-600 dark:text-blue-400" />
                        ) : (
                          <ArrowDownIcon className="ml-1 size-3 text-blue-600 dark:text-blue-400" />
                        )
                      ) : (
                        <ArrowUpDownIcon className="ml-1 size-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </Button>
                  </th>
                );
              })}

              {onDelete ? <th className="w-20" /> : null}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, rowIndex) => (
                <tr key={`loading-row-${rowIndex}`} className="border-b border-slate-200/80 bg-white/60">
                  {columns.map((column) => (
                    <td key={`loading-cell-${rowIndex}-${column.key}`} className="h-11 px-3">
                      <div className="flex items-center">
                        <Skeleton className="h-4 w-3/4" />
                      </div>
                    </td>
                  ))}
                  {onDelete ? <td key={`loading-cell-delete-${rowIndex}`} className="h-11 px-3" /> : null}
                </tr>
              ))
            ) : visibleRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (onDelete ? 1 : 0)} className="h-64">
                  <Empty className="border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <span className="text-xs font-medium">0</span>
                      </EmptyMedia>
                      <EmptyTitle>데이터가 없습니다</EmptyTitle>
                      <EmptyDescription>
                        검색 조건을 변경하거나 새 데이터를 추가해보세요.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => (
              <tr 
                key={row.id} 
                className={cn(
                  "border-b border-slate-200/80 bg-white/60 transition-colors duration-150 hover:bg-neon-gold/5 hover:shadow-soft-sm",
                  onRowClick && "cursor-pointer"
                )}
                onClick={() => onRowClick?.(row)}
              >

                {columns.map((column) => {
                  const isEditing =
                    editing?.id === row.id && editing.key === column.key;
                  const rawValue = row[column.key] as string | number | null | undefined;
                  if (column.render && !isEditing) {
                    return (
                      <td
                        key={column.key}
                        className={cn(
                          "h-11 overflow-hidden px-3",
                          column.align === "right" && "text-right",
                          column.align === "center" && "text-center",
                          (!column.align || column.align === "left") && "text-left"
                        )}
                      >
                        <div
                          className={cn(
                            "overflow-hidden text-ellipsis whitespace-nowrap",
                            column.align === "right" && "flex justify-end",
                            column.align === "center" && "flex justify-center"
                          )}
                        >
                          {column.render(row)}
                        </div>
                      </td>
                    );
                  }
                  if (column.type === "select") {
                    return (
                      <td
                        key={column.key}
                        className={cn(
                          "h-11 overflow-hidden px-3",
                          column.align === "right" && "text-right",
                          column.align === "center" && "text-center",
                          (!column.align || column.align === "left") && "text-left"
                        )}
                      >
                        <Select
                          value={String(rawValue ?? "")}
                          onValueChange={(value) => save(row, column.key, value)}
                        >
                          <SelectTrigger className="h-8 w-full rounded-md border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-slate-100 focus:ring-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {column.options?.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={column.key}
                      className={cn(
                        "h-11 overflow-hidden px-3",
                        column.align === "right" && "text-right",
                        column.align === "center" && "text-center",
                        (!column.align || column.align === "left") && "text-left"
                      )}
                    >
                      {isEditing ? (
                        <Input
                          autoFocus
                          inputMode={
                            column.type === "number" ||
                            column.type === "currency" ||
                            column.type === "percent"
                              ? "numeric"
                              : "text"
                          }
                          value={draft}
                          className="h-8 rounded-md border-slate-200 bg-white px-2 text-xs shadow-none"
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => save(row, column.key, draft)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        <button
                          className={cn(
                            "block w-full truncate rounded-md px-2 py-1.5 text-foreground",
                            column.align === "right" && "text-right",
                            column.align === "center" && "text-center",
                            (!column.align || column.align === "left") && "text-left",
                            !disableInlineEdit && "hover:bg-slate-100",
                            (column.type === "number" || column.type === "currency" || column.type === "percent") && "tabular-nums"
                          )}
                          onClick={(e) => {
                            if (disableInlineEdit) return;
                            e.stopPropagation(); // Don't trigger row click when starting edit
                            setDraft(String(rawValue ?? ""));
                            setEditing({ id: row.id, key: column.key });
                          }}
                        >
                          {rawValue == null || rawValue === ""
                            ? "-"
                            : column.type === "currency"
                              ? `${formatCurrency(Number(rawValue))}원`
                              : column.type === "percent"
                                ? formatRate(Number(rawValue))
                                : column.type === "date"
                                  ? formatDate(String(rawValue))
                                  : String(rawValue)}
                        </button>
                      )}
                    </td>
                  );
                })}
                {onDelete ? (
                  <td className="h-11 px-3 text-right">
                    <button
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                      onClick={async (e) => {
                        e.stopPropagation(); // Don't trigger row click when deleting
                        await onDelete(row);
                      }}
                    >
                      삭제
                    </button>

                  </td>
                ) : null}
              </tr>
            ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
