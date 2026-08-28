"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { PriceSheetRowData } from "./review-table";

function fmt(value: number | string | null): string {
  if (value === null || value === undefined || value === "") return "-";
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString("ko-KR") : String(value);
}

/** 0~1 소수로 저장된 비율 값을 "30%" 같은 사람이 읽는 형태로 환산한다(m2: diff에도 % 병기). */
function fmtRate(value: number | string | null): string {
  if (value === null || value === undefined || value === "") return "-";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${(Math.round(num * 10000) / 100).toLocaleString("ko-KR")}%`;
}

/**
 * 실행 시 실제로 반영되는 모든 필드를 한 줄로 요약한다 — apply-executor.buildApplyActionForRow가
 * 값이 null이 아닌 필드만 골라 Deal에 반영하므로, 여기서도 동일하게 null이 아닌 필드만 보여준다.
 * m2: 이전에는 판매가/공급가만 표시해 "diff가 보여주는 것 != 실행되는 것"이었다 — commissionRate/
 * discountRate(% 환산 병기)와 listPrice/floorPrice까지 전부 표시해 계약을 복원한다.
 */
function summarizeRowFields(row: PriceSheetRowData): string {
  const parts: string[] = [];
  if (row.sellingPrice !== null && row.sellingPrice !== undefined) parts.push(`판매가 ${fmt(row.sellingPrice)}`);
  if (row.supplyPrice !== null && row.supplyPrice !== undefined) parts.push(`공급가 ${fmt(row.supplyPrice)}`);
  if (row.listPrice !== null && row.listPrice !== undefined) parts.push(`정상가 ${fmt(row.listPrice)}`);
  if (row.floorPrice !== null && row.floorPrice !== undefined) parts.push(`최저가 ${fmt(row.floorPrice)}`);
  if (row.commissionRate !== null && row.commissionRate !== undefined)
    parts.push(`수수료율 ${fmtRate(row.commissionRate)}`);
  if (row.discountRate !== null && row.discountRate !== undefined) parts.push(`할인율 ${fmtRate(row.discountRate)}`);
  return parts.length > 0 ? parts.join(" / ") : "변경 필드 없음";
}

/**
 * 승인 직전 diff 확인 모달 — ActionProposal(WRITE)이 실제로 무엇을 바꿀지 검수자에게 보여준다.
 * MAPPED 행은 "기존 딜 갱신", NEW_DEAL 행은 "신규 딜 생성"으로 구분 표시한다.
 */
/** 미리보기에서 확정한 신규 딜 그룹 요약 — 이 모달이 진짜 마지막 체크포인트라 여기에도 보여준다. */
export type NewDealGroupSummary = {
  key: string;
  dealName: string;
  optionCount: number;
  brandName: string | null;
  partnerName: string | null;
  /** true면 이 그룹은 새 상위딜을 만들지 않고 기존 딜(dealName)에 하위품목만 추가한다. */
  attachToExisting: boolean;
};

export function ApplyDiffModal({
  open,
  onOpenChange,
  rows,
  newDealGroups = [],
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: PriceSheetRowData[];
  newDealGroups?: NewDealGroupSummary[];
  busy: boolean;
  onConfirm: () => void;
}) {
  const updates = rows.filter((r) => r.mappingStatus === "MAPPED");
  const creates = rows.filter((r) => r.mappingStatus === "NEW_DEAL");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>가격표 반영 확인</DialogTitle>
          <DialogDescription>
            승인 시 ActionProposal(WRITE)이 생성되어 즉시 실행됩니다. 아래 {rows.length}건이 딜에 반영됩니다.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-96 flex-col gap-4 overflow-y-auto">
          {creates.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                신규 딜 생성 ({creates.length}건)
              </h4>
              {creates.map((row) => (
                <div key={row.id} className="flex items-center justify-between rounded-md border border-border/50 p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant="status-info">신규</Badge>
                    <span className="font-medium">{row.productName ?? "(제품명 없음)"}</span>
                  </div>
                  <span className="tabular-nums text-muted-foreground">{summarizeRowFields(row)}</span>
                </div>
              ))}

              {/* 미리보기에서 확정한 딜 구조·브랜드·거래처가 여기(진짜 마지막 확인)에도 그대로
                  보여야 두 화면이 같은 말을 한다 — 값의 출처는 동일한 effectiveOverrides.
                  attachToExisting 그룹은 상위딜을 새로 만들지 않으므로 "생성"이 아니라
                  "추가"로 표시하고, 생성 목록과 분리해 보여준다(deal-group-preview.tsx의
                  "기존 딜에 추가" 어휘를 그대로 맞춘다). */}
              {newDealGroups.filter((g) => !g.attachToExisting).length > 0 && (
                <div className="flex flex-col gap-1 rounded-md border border-border/50 bg-muted/20 p-2">
                  <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                    생성될 딜 구조
                  </span>
                  {newDealGroups
                    .filter((group) => !group.attachToExisting)
                    .map((group) => (
                      <div key={group.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        <span className="font-medium text-foreground">{group.dealName}</span>
                        {group.optionCount > 0 && (
                          <span className="text-muted-foreground">하위 옵션 {group.optionCount}개</span>
                        )}
                        <span className="text-muted-foreground">
                          브랜드 {group.brandName ?? "없음"} · 거래처 {group.partnerName ?? "연결 안 함"}
                        </span>
                      </div>
                    ))}
                </div>
              )}

              {newDealGroups.filter((g) => g.attachToExisting).length > 0 && (
                <div className="flex flex-col gap-1 rounded-md border border-border/50 bg-muted/20 p-2">
                  <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                    기존 딜에 추가
                  </span>
                  {newDealGroups
                    .filter((group) => group.attachToExisting)
                    .map((group) => (
                      <div key={group.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        <span className="font-medium text-foreground">{group.dealName}</span>
                        {group.optionCount > 0 && (
                          <span className="text-muted-foreground">하위 옵션 {group.optionCount}개</span>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {updates.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                기존 딜 갱신 ({updates.length}건)
              </h4>
              {updates.map((row) => (
                <div key={row.id} className="flex items-center justify-between rounded-md border border-border/50 p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant="status-active">갱신</Badge>
                    <span className="font-medium">{row.productName ?? "(제품명 없음)"}</span>
                  </div>
                  <span className="tabular-nums text-muted-foreground">{summarizeRowFields(row)}</span>
                </div>
              ))}
            </div>
          )}

          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground">반영할 확정 행이 없습니다.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            취소
          </Button>
          <Button onClick={onConfirm} disabled={busy || rows.length === 0}>
            {busy ? "반영 중..." : "승인 및 반영"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
