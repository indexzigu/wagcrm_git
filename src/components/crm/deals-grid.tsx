"use client";

import type { DealStatus } from "@/lib/crm-types";
import type { BaseMarginPolicy } from "@/lib/validations/deal";

import { PackageOpen } from "lucide-react";

import { DataEmpty } from "@/components/ui/empty";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineDataGrid } from "./inline-data-grid";
import { EntityTypeBadge } from "./entity-type-badge";

// --- Types ---

export type DealRow = {
  id: string;
  dealName: string;
  brandName?: string | null;
  partnerName: string;
  partnerId: string;
  costPrice: number;
  sellingPrice: number;
  listPrice?: number | null;
  floorPrice?: number | null;
  discountRate?: number | null;
  totalCommissionRate?: number | null;
  brokerageCommissionRate?: number | null;
  sourcingMemo?: string | null;
  candidateSellers?: string | null;
  sellerCount: number;
  status: DealStatus;
  campaignCount: number;
  taskCount: number;
  createdAt: string;
  baseMarginPolicy?: BaseMarginPolicy;
  /** 리뷰 소스 부재(오너 데이터 경로 ②) — 캠페인 상품 링크 입력으로 해소되는 데이터 갭 신호. */
  needsReviewSourceLink?: boolean;
};

export type DealsGridProps = {
  initialDeals: DealRow[];
  onSelect?: (deal: DealRow) => void;
};

// --- Component ---

export function DealsGrid({
  initialDeals,
  onSelect,
}: DealsGridProps) {
  if (initialDeals.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-64 items-center justify-center p-4">
          <DataEmpty
            icon={PackageOpen}
            title="등록된 딜이 없습니다"
            description="딜을 추가하여 상품을 관리하세요."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <InlineDataGrid
        rows={initialDeals}
        columns={[
          {
            key: "dealName",
            label: "딜 이름",
            width: 240,
            // 리뷰 소스 부재 도트 — 무채색 랭크 마커(ss-ux 판정: 22/30행에 경고색을 칠하면
            // 습관화로 신호가 죽는다). 리스크 카드의 slate 도트 어휘 재사용, 상태 축과 분리.
            render: (row) => (
              <div className="flex min-w-0 items-center gap-1.5">
                {row.needsReviewSourceLink && (
                  <>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {/* 도트는 순수 장식(aria-hidden) — 접근성 이름은 아래 sr-only가 상시 제공
                              (generic role + aria-label은 노출 미보장, hover 전용 툴팁은 키보드 도달 불가) */}
                          <span
                            className="size-2 shrink-0 rounded-full bg-slate-400"
                            aria-hidden="true"
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" align="start">
                          리뷰 소스 없음 · 캠페인 상품 링크 입력 필요
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <span className="sr-only">리뷰 소스 없음 · 캠페인 상품 링크 입력 필요</span>
                  </>
                )}
                {/* flex item은 min-width:auto라 min-w-0 없이는 truncate가 실동작하지 않는다(ss-ux P0-2) */}
                <span className="min-w-0 flex-1 truncate">{row.dealName}</span>
              </div>
            ),
          },
          {
            key: "brandName",
            label: "브랜드",
            width: 140,
            type: "text",
          },
          {
            key: "partnerName",
            label: "거래처",
            width: 160,
            type: "text",
          },
          {
            key: "status",
            label: "상태",
            width: 160,
            render: (row) => <EntityTypeBadge type="deal" value={row.status} />,
          },
          {
            key: "sellerCount",
            label: "셀러",
            width: 100,
            type: "number",
          },
          {
            key: "taskCount",
            label: "테스크",
            width: 100,
            type: "number",
          },
          {
            key: "campaignCount",
            label: "캠페인",
            width: 100,
            type: "number",
          },
          {
            key: "totalCommissionRate",
            label: "총수수료",
            width: 96,
            type: "percent",
          },
          {
            key: "createdAt",
            label: "등록일",
            width: 120,
            type: "date",
          },
        ]}
        onPatch={async () => null}
        onRowClick={(row) => onSelect?.(row)}
        disableInlineEdit
        persistId="deals-grid"
      />
    </div>
  );
}
