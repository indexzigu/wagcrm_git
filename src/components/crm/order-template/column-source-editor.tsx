"use client";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NAVER_ORDER_FIELDS, type NaverOrderField } from "@/lib/order-converter/excel-rules";
import type { EditableColumnSource } from "./types";

const SOURCE_TYPE_LABELS: Record<EditableColumnSource["type"], string> = {
  field: "네이버 필드",
  template: "셀러명 템플릿",
  const: "고정값",
  empty: "비움",
};

/**
 * 열 하나의 소스 편집기 — 타입 Select + 타입별 2번째 컨트롤의 2단 인라인(표 행 안 가로 밀도).
 * field의 guard/transform/fallback 등 고급 속성은 v1 검수 표면에 비노출 — 필드만 바꾸면
 * 기존 속성은 보존, 타입을 바꾸면 폐기(의도적 재정의)한다.
 */
export function ColumnSourceEditor({
  value,
  sellerName,
  onChange,
}: {
  value: EditableColumnSource;
  sellerName: string;
  onChange: (next: EditableColumnSource) => void;
}) {
  const handleTypeChange = (nextType: string) => {
    if (nextType === value.type) return;
    switch (nextType) {
      case "field":
        onChange({ type: "field", field: null });
        break;
      case "template":
        onChange({ type: "template", template: "와이그라운드({{sellerName}})", fallback: "와이그라운드" });
        break;
      case "const":
        onChange({ type: "const", value: "" });
        break;
      default:
        onChange({ type: "empty" });
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Select value={value.type} onValueChange={handleTypeChange}>
        <SelectTrigger size="sm" className="h-7 w-[110px] shrink-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(SOURCE_TYPE_LABELS).map(([type, label]) => (
            <SelectItem key={type} value={type} className="text-xs">
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value.type === "field" && (
        <Select
          value={value.field ?? ""}
          onValueChange={(field) =>
            onChange({ ...(value as Extract<EditableColumnSource, { type: "field" }>), type: "field", field: field as NaverOrderField })
          }
        >
          <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs">
            <SelectValue placeholder="필드 선택" />
          </SelectTrigger>
          <SelectContent>
            {NAVER_ORDER_FIELDS.map((field) => (
              <SelectItem key={field} value={field} className="text-xs">
                {field}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {value.type === "const" && (
        <Input
          className="h-7 flex-1 text-xs"
          value={value.value}
          onChange={(e) => onChange({ type: "const", value: e.target.value })}
          placeholder="고정값 입력"
        />
      )}

      {value.type === "template" && (
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-border/70 bg-muted/40 px-2 text-xs text-muted-foreground">
          <span className="truncate">와이그라운드({sellerName || "셀러명"})</span>
        </div>
      )}
    </div>
  );
}
