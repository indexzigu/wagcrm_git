"use client";

import { useMemo } from "react";
import { resolveColumnValue } from "@/lib/order-converter/excel-rules";
import { ORDER_RULES_PREVIEW_SAMPLES } from "@/lib/order-converter/preview-orders";
import { toConfirmedSource, type EditableColumnRule } from "./types";

/**
 * 라이브 미리보기 — 합성 엣지 주문 3건을 "지금 편집 중인 규칙"으로 즉시 계산(드라이런).
 * 서버 생성기와 동일한 resolveColumnValue를 그대로 import — 로직 재구현 금지(드리프트 방지).
 * guard 불충족(undefined)은 공란('')과 시각적으로 구분한다 — 검수자가 버그로 오인 방지.
 */
export function LivePreviewPanel({
  rows,
  sellerName,
}: {
  rows: EditableColumnRule[];
  sellerName: string;
}) {
  const previews = useMemo(() => {
    const ctx = { sellerName };
    return ORDER_RULES_PREVIEW_SAMPLES.map((sample) => ({
      ...sample,
      cells: rows.map((row) => {
        const source = toConfirmedSource(row.source);
        return {
          col: row.col,
          header: row.header,
          value: source ? resolveColumnValue(source, sample.order, ctx) : undefined,
          incomplete: !source,
        };
      }),
    }));
  }, [rows, sellerName]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs font-semibold text-foreground">라이브 미리보기</p>
        <p className="mt-0.5 text-[11px] leading-normal text-muted-foreground">
          실제 데이터가 아닌 가상 주문 3건으로 현재 매핑을 미리 계산한 결과입니다.
        </p>
      </div>
      {previews.map((sample) => (
        <div key={sample.id} className="rounded-lg border border-border/70 bg-card p-3">
          <p className="mb-2 text-[11px] font-medium text-foreground">{sample.label}</p>
          <dl className="flex flex-col gap-1">
            {sample.cells.map((cell) => (
              <div key={cell.col} className="flex items-baseline justify-between gap-2 text-[11px]">
                <dt className="shrink-0 text-muted-foreground">{cell.header || `열${cell.col}`}</dt>
                <dd className="min-w-0 truncate text-right font-medium text-foreground">
                  {cell.incomplete ? (
                    <span className="text-status-caution">(필드 미선택)</span>
                  ) : cell.value === undefined ? (
                    <span className="text-muted-foreground/60">(미기입: 조건 불충족)</span>
                  ) : cell.value === "" ? (
                    <span className="text-muted-foreground/60">(공란)</span>
                  ) : (
                    String(cell.value)
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
