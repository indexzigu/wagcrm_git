"use client";

import { AlertTriangle } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { NaverOrderField } from "@/lib/order-converter/excel-rules";
import { ColumnSourceEditor } from "./column-source-editor";
import { SourceBadge } from "./source-badge";
import { isIncompleteSource, riskyFieldNote, type EditableColumnRule } from "./types";

export type MappingRowMeta = {
  suggestedField: NaverOrderField | null;
  source: "heuristic" | "llm" | null;
  confidence: number;
} | null;

/**
 * 열 매핑 검수 테이블 — 이 화면의 focal point. 행 15~25개를 다루므로 행 압축(py-1.5) +
 * sticky 헤더. 같은 필드가 여러 열에 걸리면(duplicatedFields) 해당 행 편집기에 주의색
 * 테두리 — 어느 필드가 중복인지는 상단 경고 배너가 말해주므로 행에선 색으로만 시선 유도.
 */
export function ColumnMappingTable({
  rows,
  metaByCol,
  duplicatedFields,
  sellerName,
  onChangeSource,
}: {
  rows: EditableColumnRule[];
  metaByCol: Map<number, MappingRowMeta>;
  duplicatedFields: Set<NaverOrderField>;
  sellerName: string;
  onChangeSource: (col: number, next: EditableColumnRule["source"]) => void;
}) {
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          <TableHead className="w-12 text-xs">열</TableHead>
          <TableHead className="min-w-[120px] text-xs">양식 헤더</TableHead>
          <TableHead className="w-[150px] text-xs">추천 소스</TableHead>
          <TableHead className="min-w-[250px] text-xs">매핑 편집</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const meta = metaByCol.get(row.col) ?? null;
          const note = riskyFieldNote(row.source);
          const isDuplicated =
            row.source.type === "field" && row.source.field ? duplicatedFields.has(row.source.field) : false;
          const incomplete = isIncompleteSource(row.source);
          return (
            <TableRow key={row.col}>
              <TableCell className="py-1.5 text-xs tabular-nums text-muted-foreground">{row.col}</TableCell>
              <TableCell className="py-1.5 text-xs font-medium text-foreground">
                {row.header || <span className="italic text-muted-foreground">(빈 헤더)</span>}
              </TableCell>
              <TableCell className="py-1.5">
                {meta ? (
                  <SourceBadge source={meta.source} confidence={meta.confidence} />
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="py-1.5">
                <div className={isDuplicated ? "rounded-md ring-1 ring-status-pending/50" : undefined}>
                  <ColumnSourceEditor
                    value={row.source}
                    sellerName={sellerName}
                    onChange={(next) => onChangeSource(row.col, next)}
                  />
                </div>
                {incomplete && (
                  <p className="mt-1 text-[11px] text-status-caution">필드를 선택해야 확정할 수 있습니다.</p>
                )}
                {note && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-status-caution">
                    <AlertTriangle aria-hidden className="size-3 shrink-0" />
                    {note}
                  </p>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
