"use client";

import * as React from "react";
import { toast } from "sonner";
import { CheckIcon, Trash2Icon } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MappingStatusBadge } from "./status-badge";

export type PriceSheetRowData = {
  id: string;
  priceSheetId: string;
  rowIndex: number;
  tableSegment: number;
  productName: string | null;
  optionName: string | null;
  sellingPrice: number | string | null;
  commissionRate: number | string | null;
  supplyPrice: number | string | null;
  listPrice: number | string | null;
  floorPrice: number | string | null;
  discountRate: number | string | null;
  note: string | null;
  flags: Record<string, unknown> | null;
  rawCells: Record<string, unknown>;
  mappingStatus: string;
  mappedDealId: string | null;
};

export type DealOption = {
  id: string;
  dealName: string;
  /** 하위품목딜이면 부모 id — 묶음 상위딜 후보에서 제외하는 데 쓴다. */
  parentDealId: string | null;
  brandName: string | null;
  partnerId: string | null;
};

type NumericFieldKey =
  | "sellingPrice"
  | "supplyPrice"
  | "listPrice"
  | "floorPrice"
  | "commissionRate"
  | "discountRate";

const NUMERIC_FIELD_LABELS: Array<{ key: NumericFieldKey; label: string }> = [
  { key: "sellingPrice", label: "판매가" },
  { key: "supplyPrice", label: "공급가" },
  { key: "listPrice", label: "정상가" },
  { key: "floorPrice", label: "최저가" },
  { key: "commissionRate", label: "수수료율" },
  { key: "discountRate", label: "할인율" },
];

// M3: commissionRate/discountRate는 DB/서버에 항상 0~1 소수로 저장된다(예: 0.3 = 30%).
// 검수자가 매번 0.3 같은 소수를 입력/암산하게 하면 실수로 "30"을 넣어 서버가 400을
// 던지거나(수정 전에는 그대로 30이 저장되는 사고) 하는 UX 함정이 생긴다. 그래서 이 두
// 필드만 화면에는 %(30)로 보여주고 입력도 %(30 입력)로 받되, 저장 시에는 /100 해서
// 0.3으로 PATCH 요청을 보낸다 — "화면에 보이는 것 = 사람이 이해하는 단위, 서버로 가는
// 것 = 계약된 0~1 소수" 원칙을 지킨다.
const RATE_FIELDS: ReadonlySet<NumericFieldKey> = new Set(["commissionRate", "discountRate"]);

function isRateField(key: NumericFieldKey): boolean {
  return RATE_FIELDS.has(key);
}

/** 저장된 0~1 소수 값을 편집기/뷰에 표시할 문자열로 변환한다. 비율 필드는 %로 환산한다. */
function toDisplayNumber(value: number | string | null, field: NumericFieldKey): string {
  if (value === null || value === undefined || value === "") return "";
  if (!isRateField(field)) return String(value);
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  // 0.3 -> "30" (소수점 오차 방지를 위해 반올림 후 불필요한 0 제거)
  return String(Math.round(num * 10000) / 100);
}

/** 사용자가 입력한 %(예: 30) 문자열을 서버 저장 단위인 0~1 소수로 변환한다. */
function parsePercentInputToRate(raw: string): number | null {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return num / 100;
}

// 플래그는 두 부류다 — 심각도(검토필요·음수마진)와 제품 속성(증정품·단독구매불가).
// 속성 쪽은 좋고 나쁨이 없고 아무것도 기다리지 않으므로 색을 주지 않는다(P8 §4 "범주는
// 색을 받지 않는다"). 종전에는 둘 다 status-pending(대기색)이라 "처리해야 할 것"으로
// 읽혔고, 색이 흔해져 진짜 주의가 필요한 두 플래그의 신호도 함께 약해졌다.
function FlagBadges({ flags }: { flags: Record<string, unknown> | null }) {
  if (!flags) return null;
  const badges: Array<{ key: string; label: string; variant: "status-urgent" | "outline" }> = [];
  if (flags.needsReview) badges.push({ key: "needsReview", label: "검토필요", variant: "status-urgent" });
  if (flags.negativeMargin) badges.push({ key: "negativeMargin", label: "음수마진", variant: "status-urgent" });
  if (flags.giftOrBundle) badges.push({ key: "giftOrBundle", label: "증정/사은품", variant: "outline" });
  if (flags.singlePurchaseBlocked) badges.push({ key: "singlePurchaseBlocked", label: "단독구매불가", variant: "outline" });
  if (badges.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <Badge key={b.key} variant={b.variant} className="text-[10px]">
          {b.label}
        </Badge>
      ))}
    </div>
  );
}

function RawCellsTooltip({ rawCells }: { rawCells: Record<string, unknown> }) {
  const entries = Object.entries(rawCells).filter(([k]) => k !== "__sheetName");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-xs text-muted-foreground underline decoration-dotted">
          원본 셀
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <div className="flex flex-col gap-0.5 text-xs">
          {entries.length === 0 ? (
            <span>원본 데이터 없음</span>
          ) : (
            entries.map(([key, value]) => (
              <span key={key}>
                [{key}] {value === null || value === undefined ? "∅" : String(value)}
              </span>
            ))
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function ReviewTable({
  priceSheetId,
  rows,
  deals,
  onRowUpdated,
  bundleMode,
  excludedRowIds,
  onToggleExclude,
}: {
  priceSheetId: string;
  rows: PriceSheetRowData[];
  /** 매핑 후보 딜 목록 — 상세 화면이 1회 조회해 검수표와 미리보기가 공유한다. */
  deals: DealOption[];
  onRowUpdated: () => void | Promise<void>;
  /** BUNDLE 모드일 때만 「묶음 제외」 열을 보여준다. */
  bundleMode?: boolean;
  excludedRowIds?: string[];
  onToggleExclude?: (rowId: string) => void;
}) {
  const [editingCell, setEditingCell] = React.useState<{ rowId: string; field: string } | null>(null);
  const [savingRowId, setSavingRowId] = React.useState<string | null>(null);

  const segments = React.useMemo(() => {
    const grouped = new Map<number, PriceSheetRowData[]>();
    for (const row of rows) {
      const list = grouped.get(row.tableSegment) ?? [];
      list.push(row);
      grouped.set(row.tableSegment, list);
    }
    return Array.from(grouped.entries()).sort((a, b) => a[0] - b[0]);
  }, [rows]);

  const patchRow = async (rowId: string, body: Record<string, unknown>) => {
    setSavingRowId(rowId);
    try {
      const res = await fetch(`/api/price-sheets/${priceSheetId}/rows/${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "행 저장에 실패했습니다.");
        return;
      }
      await onRowUpdated();
    } finally {
      setSavingRowId(null);
      setEditingCell(null);
    }
  };

  // 행 삭제 — LLM 중복 추출 행 정리용. 실수 삭제는 "재추출"로 복구된다(성공 무음 계약
  // 대상 아님 — 삭제는 인라인 저장이 아니라 파괴 액션이라 성공 토스트로 결과를 확정한다).
  const deleteRow = async (rowId: string) => {
    setSavingRowId(rowId);
    try {
      const res = await fetch(`/api/price-sheets/${priceSheetId}/rows/${rowId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "행 삭제에 실패했습니다.");
        return;
      }
      toast.success("행을 삭제했습니다. 잘못 지웠다면 \"재추출\"로 복구할 수 있습니다.");
      await onRowUpdated();
    } finally {
      setSavingRowId(null);
    }
  };

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">추출된 행이 없습니다. 상단의 &quot;추출 실행&quot;으로 다시 시도할 수 있습니다.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {segments.map(([segmentIndex, segmentRows]) => (
        <div key={segmentIndex} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            표 {segmentIndex + 1} ({segmentRows.length}행)
          </h3>
          <div className="overflow-x-auto rounded-lg border border-border/50">
            <Table>
              <TableHeader>
                <TableRow>
                  {bundleMode && <TableHead className="w-20">묶음 제외</TableHead>}
                  <TableHead>제품명</TableHead>
                  <TableHead>옵션</TableHead>
                  {/* 숫자 열은 헤더도 우측 정렬한다 — 셀이 `text-right tabular-nums`인데
                      헤더만 좌측이면 열마다 라벨과 숫자가 반대 끝에 붙어 어긋나 보인다.
                      min-w도 셀과 같은 값을 줘 폭 기준을 한쪽으로 모은다(스켈레톤도 동일). */}
                  {NUMERIC_FIELD_LABELS.map((f) => (
                    <TableHead key={f.key} className="min-w-[100px] text-right">
                      {isRateField(f.key) ? `${f.label} (%)` : f.label}
                    </TableHead>
                  ))}
                  <TableHead>플래그</TableHead>
                  <TableHead>매핑</TableHead>
                  <TableHead>원본</TableHead>
                  <TableHead>
                    <span className="sr-only">행 삭제</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {segmentRows.map((row) => (
                  <TableRow key={row.id} className={savingRowId === row.id ? "opacity-50" : undefined}>
                    {bundleMode && (
                      <TableCell className="w-20">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          aria-label={`${row.productName ?? "행"} 묶음에서 제외`}
                          checked={excludedRowIds?.includes(row.id) ?? false}
                          onChange={() => onToggleExclude?.(row.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell
                      className="min-w-[160px] cursor-text"
                      onClick={() => setEditingCell({ rowId: row.id, field: "productName" })}
                    >
                      {editingCell?.rowId === row.id && editingCell.field === "productName" ? (
                        <Input
                          autoFocus
                          defaultValue={row.productName ?? ""}
                          onBlur={(e) => patchRow(row.id, { productName: e.target.value || null })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                        />
                      ) : (
                        <span>{row.productName ?? <span className="text-muted-foreground">-</span>}</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="min-w-[140px] cursor-text"
                      onClick={() => setEditingCell({ rowId: row.id, field: "optionName" })}
                    >
                      {editingCell?.rowId === row.id && editingCell.field === "optionName" ? (
                        <Input
                          autoFocus
                          defaultValue={row.optionName ?? ""}
                          onBlur={(e) => patchRow(row.id, { optionName: e.target.value || null })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                        />
                      ) : (
                        <span>{row.optionName ?? <span className="text-muted-foreground">-</span>}</span>
                      )}
                    </TableCell>
                    {NUMERIC_FIELD_LABELS.map((f) => (
                      <TableCell
                        key={f.key}
                        className="min-w-[100px] cursor-text text-right tabular-nums"
                        onClick={() => setEditingCell({ rowId: row.id, field: f.key })}
                      >
                        {editingCell?.rowId === row.id && editingCell.field === f.key ? (
                          <Input
                            type="number"
                            autoFocus
                            defaultValue={toDisplayNumber(row[f.key], f.key)}
                            onBlur={(e) =>
                              patchRow(row.id, {
                                [f.key]:
                                  e.target.value === ""
                                    ? null
                                    : isRateField(f.key)
                                      ? parsePercentInputToRate(e.target.value)
                                      : Number(e.target.value),
                              })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                          />
                        ) : (
                          <span>
                            {toDisplayNumber(row[f.key], f.key) ? (
                              <>
                                {toDisplayNumber(row[f.key], f.key)}
                                {isRateField(f.key) ? "%" : ""}
                              </>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </span>
                        )}
                      </TableCell>
                    ))}
                    <TableCell className="min-w-[140px]">
                      <FlagBadges flags={row.flags} />
                    </TableCell>
                    <TableCell className="min-w-[180px]">
                      <div className="flex flex-col gap-1">
                        <MappingStatusBadge status={row.mappingStatus} />
                        {/* UNMAPPED(미확정)는 빈 값 → placeholder를 보여준다. 여기서
                            mappedDealId(null) 기준으로 "__new__"를 미리 표시하면 "신규 딜로
                            생성"을 골라도 Radix가 같은 값 재선택으로 보고 onValueChange를
                            안 쏴 행이 영원히 미확정으로 남는다(반영 버튼 무반응의 근본). */}
                        <Select
                          value={
                            row.mappingStatus === "UNMAPPED"
                              ? ""
                              : (row.mappedDealId ?? "__new__")
                          }
                          onValueChange={(value) => {
                            if (value === "__new__") {
                              patchRow(row.id, { mappingStatus: "NEW_DEAL", mappedDealId: null });
                            } else {
                              patchRow(row.id, { mappingStatus: "MAPPED", mappedDealId: value });
                            }
                          }}
                        >
                          <SelectTrigger className="h-7 w-full text-xs">
                            <SelectValue placeholder="매핑 선택" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__new__">신규 딜로 생성</SelectItem>
                            {deals.map((d) => (
                              <SelectItem key={d.id} value={d.id}>
                                {d.dealName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/* SUGGESTED 전용: Select는 이미 제안 딜을 표시 중이라 같은 값을 다시
                            선택해도 Radix가 onValueChange를 쏘지 않는다 — 제안을 그대로 확정하는
                            명시적 경로가 필요하다. */}
                        {row.mappingStatus === "SUGGESTED" && row.mappedDealId && (
                          <Button
                            variant="outline"
                            size="xs"
                            className="text-[11px]"
                            disabled={savingRowId === row.id}
                            onClick={() =>
                              patchRow(row.id, {
                                mappingStatus: "MAPPED",
                                mappedDealId: row.mappedDealId,
                              })
                            }
                          >
                            <CheckIcon className="size-3" />
                            제안 승인
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <RawCellsTooltip rawCells={row.rawCells} />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`${row.optionName ?? row.productName ?? "행"} 삭제`}
                        disabled={savingRowId === row.id || row.mappingStatus === "APPLIED"}
                        onClick={() => void deleteRow(row.id)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 추출 진행 중 스켈레톤 — 검수표의 최종 레이아웃(세그먼트 제목 + 테이블 셸 + 컬럼폭)을
 * 그대로 미러링해 추출 완료 시 레이아웃 시프트가 없게 한다(styleseed: 스피너 금지,
 * 최종 형태의 스켈레톤). 컬럼 순서·min-w 값은 위 ReviewTable과 동기 유지할 것.
 */
export function ReviewTableSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="가격표 추출 중">
      <Skeleton className="h-4 w-24" />
      <div className="overflow-x-auto rounded-lg border border-border/50">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[160px]">제품명</TableHead>
              <TableHead className="min-w-[140px]">옵션</TableHead>
              {NUMERIC_FIELD_LABELS.map((f) => (
                <TableHead key={f.key} className="min-w-[100px] text-right">
                  {isRateField(f.key) ? `${f.label} (%)` : f.label}
                </TableHead>
              ))}
              <TableHead className="min-w-[140px]">플래그</TableHead>
              <TableHead className="min-w-[180px]">매핑</TableHead>
              <TableHead>원본</TableHead>
              <TableHead>
                <span className="sr-only">행 삭제</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 7 }, (_, i) => (
              <TableRow key={i}>
                <TableCell className="min-w-[160px]">
                  <Skeleton className="h-4 w-32" />
                </TableCell>
                <TableCell className="min-w-[140px]">
                  <Skeleton className="h-4 w-24" />
                </TableCell>
                {NUMERIC_FIELD_LABELS.map((f) => (
                  <TableCell key={f.key} className="min-w-[100px]">
                    <Skeleton className="ml-auto h-4 w-14" />
                  </TableCell>
                ))}
                <TableCell className="min-w-[140px]">
                  <Skeleton className="h-4 w-16" />
                </TableCell>
                <TableCell className="min-w-[180px]">
                  <Skeleton className="h-4 w-20" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-3 w-10" />
                </TableCell>
                <TableCell>
                  <Skeleton className="size-7 rounded-md" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
