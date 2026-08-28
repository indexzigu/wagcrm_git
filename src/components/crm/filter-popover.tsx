"use client";

import { FilterIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export interface FilterFieldConfig {
  key: string;
  label: string;
  type: "select" | "date";
  options?: { value: string; label: string }[];
}

interface FilterPopoverProps {
  filterConfig: FilterFieldConfig[];
  filters: Record<string, string | undefined>;
  onFilterChange: (key: string, value: string) => void;
  onClearAll: () => void;
}

export function FilterPopover({
  filterConfig,
  filters,
  onFilterChange,
  onClearAll,
}: FilterPopoverProps) {
  const activeCount = filterConfig.filter(
    (field) => filters[field.key]
  ).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <FilterIcon className="size-3.5" />
          <span>필터</span>
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-0.5 h-4 min-w-4 px-1 text-[10px]">
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3 p-4" align="start">
        <div className="space-y-3">
          {filterConfig.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {field.label}
              </Label>
              {field.type === "select" && field.options ? (
                <Select
                  value={filters[field.key] ?? ""}
                  onValueChange={(value) => onFilterChange(field.key, value)}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue placeholder={`${field.label} 선택`} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {field.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : field.type === "date" ? (
                <Input
                  type="date"
                  value={filters[field.key] ?? ""}
                  onChange={(e) => onFilterChange(field.key, e.target.value)}
                  className="h-7 text-sm"
                />
              ) : null}
            </div>
          ))}
        </div>
        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="w-full text-muted-foreground"
            onClick={onClearAll}
          >
            <XIcon className="size-3" />
            전체 초기화
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
