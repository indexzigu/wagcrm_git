"use client";

import { useEffect, useMemo, useState } from "react";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type CampaignRow,
  type CampaignStatus,
  type DashboardData,
  type SalesChannel,
  type SnsType,
} from "@/lib/crm-types";
import { EntityIdentity } from "./entity-identity";
import { EntityLinkSelectField } from "./entity-link-select-field";
import { LinkSearchDialog } from "./link-search-dialog";
import { SellerIdentityInfo } from "./seller-identity-info";

type CampaignCreationSheetProps = {
  data: DashboardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (campaign: CampaignRow) => void;
  /** 사전 설정할 상태 (PROPOSAL 컬럼 + 버튼에서 열 때) */
  defaultStatus?: CampaignStatus;
  /** 사전 설정할 딜 (딜 패널에서 "캠페인 만들기" 시) */
  lockedDealId?: string;
  lockStatus?: boolean;
};



function today(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function buildDefaultCampaignName(
  deals: DashboardData["deals"],
  sellers: DashboardData["sellers"],
  dealId: string,
  sellerId: string,
) {
  const dealName = deals.find((deal) => deal.id === dealId)?.dealName ?? "";
  const seller = sellers.find((seller) => seller.id === sellerId);
  const sellerName = seller ? (seller.alias || seller.name) : "";
  return [dealName, sellerName].filter(Boolean).join(" - ").trim();
}

export function CampaignCreationSheet({
  data,
  open,
  onOpenChange,
  onCreated,
  defaultStatus,
  lockedDealId,
}: CampaignCreationSheetProps) {
  const firstDeal = lockedDealId ?? data.deals[0]?.id ?? "";
  const firstSeller = data.sellers[0]?.id ?? "";

  const [dealId, setDealId] = useState(firstDeal);
  const [sellerId, setSellerId] = useState(firstSeller);
  const [salesChannel, setSalesChannel] = useState<SalesChannel>("UNSPECIFIED");
  const [status, setStatus] = useState<CampaignStatus>(defaultStatus ?? "PROPOSAL");
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today(7));
  const [totalMarginRate, setTotalMarginRate] = useState(0);
  const [sellerMarginRate, setSellerMarginRate] = useState(0);
  const [netMarginRate, setNetMarginRate] = useState(0);
  const [isManualMargin, setIsManualMargin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDealSearchOpen, setIsDealSearchOpen] = useState(false);
  const [isSellerSearchOpen, setIsSellerSearchOpen] = useState(false);
  const [localDeals, setLocalDeals] = useState(data.deals);
  const [localSellers, setLocalSellers] = useState(data.sellers);

  // Reset form state when sheet opens
  useEffect(() => {
    if (open) {
      const initialDeal = lockedDealId ?? data.deals[0]?.id ?? "";
      const initialSeller = data.sellers[0]?.id ?? "";
      // Intentional reset when the sheet is reopened or preset inputs change.
      setDealId(initialDeal);
      setSellerId(initialSeller);
      setSalesChannel("UNSPECIFIED");
      setStatus(defaultStatus ?? "PROPOSAL");
      setStartDate(today());
      setEndDate(today(7));
      setTotalMarginRate(0);
      setSellerMarginRate(0);
      setNetMarginRate(0);
      setIsManualMargin(false);
      setError(null);
      setIsDealSearchOpen(false);
      setIsSellerSearchOpen(false);
      setLocalDeals(data.deals);
      setLocalSellers(data.sellers);
    }
  }, [open, defaultStatus, lockedDealId, data.deals, data.sellers]);

  const selectedDeal = useMemo(
    () => localDeals.find((deal) => deal.id === dealId) ?? null,
    [localDeals, dealId],
  );

  const selectedSeller = useMemo(
    () => localSellers.find((seller) => seller.id === sellerId) ?? null,
    [localSellers, sellerId],
  );

  // dealId/sellerId가 변경될 때 사용자 입력이 없으면 자동으로 캠페인 이름 업데이트
  // (prev가 빈 경우에만 변경 - 사용자 입력 우선)
  const defaultCampaignName = useMemo(
    () => buildDefaultCampaignName(localDeals, localSellers, dealId, sellerId),
    [localDeals, localSellers, dealId, sellerId],
  );


  const isSubmitDisabled = saving || !dealId || !sellerId || !defaultCampaignName.trim();

  async function createCampaign() {
    setSaving(true);
    setError(null);
    try {
      await withMutationFeedback(
        (async () => {
          const response = await fetch("/api/campaigns", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dealId,
              sellerId,
              campaignName: defaultCampaignName.trim(),
              salesChannel,
              status,
              startDate,
              endDate,
              totalMarginRate,
              sellerMarginRate,
              netMarginRate,
              isManualMargin,
              baseNaverLink: "https://smartstore.naver.com",
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error ? "입력값을 확인하세요." : "캠페인 생성 실패");
          }
          onCreated(payload as CampaignRow);
          onOpenChange(false);
        })()
      ).catch((err) => {
        const isNetworkError = err.message === "Network error" || err.message === "Failed to fetch";
        setError(isNetworkError ? "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요." : err.message);
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0 overflow-hidden flex flex-col max-h-[85vh]">
          <DialogHeader className="shrink-0 border-b border-border/70 px-6 py-5">
            <DialogTitle>새 캠페인 추가</DialogTitle>
            <DialogDescription>
              영업 테스크 승인 전 예외적으로 캠페인을 직접 생성합니다.
            </DialogDescription>
          </DialogHeader>

          {/* Radix ScrollArea 대신 네이티브 스크롤 — Radix 는 네이티브 스크롤바를 숨겨
              Windows(비오버레이 스크롤바)에서 "잘렸는데 스크롤바가 없는" 상태가 된다
              (PR #57 과 동일 원인). 내용이 정적 폼이라 고정 높이는 과잉 — max-h 를
              유지하고 스크롤 수단만 네이티브로 바꾼다. scrollbar-gutter 는 스크롤바
              등장 시 폭 흔들림 방지. */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
            <FieldGroup className="gap-4">
              <div className="rounded-xl border border-border bg-card p-5 shadow-soft-sm flex flex-col gap-4">
                <div className="text-sm font-semibold text-foreground">핵심 연결 정보</div>
                <div className="flex flex-col gap-3">
                  <EntityLinkSelectField
                    selected={!!selectedDeal}
                    emptyText="선택된 딜이 없습니다."
                    actionLabel="딜 선택"
                    changeLabel="딜 변경"
                    disabled={!!lockedDealId}
                    onOpen={() => setIsDealSearchOpen(true)}
                    selectedContent={
                      <EntityIdentity
                        variant="heading"
                        parts={[
                          { label: "딜", value: selectedDeal?.dealName ?? "로딩 중..." },
                          ...(selectedDeal?.partner?.name
                            ? [{ label: "거래처", value: selectedDeal.partner.name }]
                            : []),
                        ]}
                      />
                    }
                  />

                  <EntityLinkSelectField
                    selected={!!selectedSeller}
                    emptyText="선택된 셀러가 없습니다."
                    actionLabel="셀러 검색 선택"
                    changeLabel="셀러 변경"
                    onOpen={() => setIsSellerSearchOpen(true)}
                    selectedContent={
                      <SellerIdentityInfo
                        sellerName={selectedSeller?.alias || selectedSeller?.name || "로딩 중..."}
                        snsHandle={selectedSeller?.snsHandle ?? null}
                        snsType={selectedSeller?.snsType ?? null}
                        variant="heading"
                      />
                    }
                  />
                </div>

                <Field>
                  <div className="flex w-full items-center justify-between mb-1.5">
                    <FieldLabel className="mb-0">캠페인명</FieldLabel>
                    <Badge variant="secondary" className="h-5 px-1.5 py-0 font-medium text-[10px] bg-slate-100 text-slate-600">자동조합</Badge>
                  </div>
                  <Input
                    value={defaultCampaignName}
                    disabled
                    placeholder="딜과 셀러 선택 시 자동으로 조합됩니다."
                    className="cursor-not-allowed bg-slate-50"
                  />
                  <FieldDescription className="text-xs">
                    셀러 별칭이 있으면 캠페인명에도 별칭을 우선 사용합니다.
                  </FieldDescription>
                </Field>
              </div>

              <div className="rounded-xl border border-border bg-card p-5 shadow-soft-sm flex flex-col gap-4">
                <div className="text-sm font-semibold text-foreground">운영 기간</div>
                <div className="grid gap-3 grid-cols-2">
                  <Field>
                    <FieldLabel>시작일</FieldLabel>
                    <Input
                      type="date"
                      value={startDate}
                      onChange={(event) => setStartDate(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>마감일</FieldLabel>
                    <Input
                      type="date"
                      value={endDate}
                      onChange={(event) => setEndDate(event.target.value)}
                    />
                  </Field>
                </div>
              </div>
            </FieldGroup>

          </div>

          {/* 오류는 스크롤 영역 밖 고정 스트립 — 본문을 내려봐도 실패 사유가 항상 보인다(PR #57 관례). */}
          {error && (
            <Alert variant="destructive" className="mx-6 shrink-0">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="shrink-0 border-t border-border/70 p-6 bg-slate-50/50 mx-0 mb-0">
            <div className="flex w-full items-center justify-end gap-3">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                취소
              </Button>
              <Button size="sm" onClick={createCampaign} disabled={isSubmitDisabled}>
                {saving ? "저장 중..." : "캠페인 생성"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    <LinkSearchDialog
      open={isDealSearchOpen}
      onOpenChange={setIsDealSearchOpen}
      entityType="deal"
      searchEndpoint="/api/search/deals"
      simpleDealDisplay
      onSelect={(deal) => {
        setDealId(deal.id);
        if (!localDeals.some((item) => item.id === deal.id)) {
          const partnerName = deal.identityParts?.find((part) => part.label === "거래처")?.value ?? null;
          setLocalDeals((prev) => [
            ...prev,
            {
              id: deal.id,
              dealName: deal.label,
              costPrice: 0,
              sellingPrice: 0,
              status: "SOURCING" as const,
              partner: partnerName
                ? {
                    id: "",
                    name: partnerName,
                    type: "BRAND",
                  }
                : null,
              baseMarginPolicy: { byChannel: {} },
            },
          ]);
        }
      }}
      title="딜 선택"
      placeholder="검색할 딜 또는 거래처 이름을 입력하세요"
    />
    <LinkSearchDialog
      open={isSellerSearchOpen}
      onOpenChange={setIsSellerSearchOpen}
      entityType="seller"
      searchEndpoint="/api/search/sellers"
      onSelect={(seller) => {
        setSellerId(seller.id);
        if (!localSellers.some((item) => item.id === seller.id)) {
          setLocalSellers((prev) => [
            ...prev,
            {
              id: seller.id,
              name: seller.label,
              alias: seller.metadata?.alias ?? null,
              snsType: (seller.metadata?.snsType || "INSTAGRAM") as SnsType,
              snsHandle: seller.metadata?.snsHandle ?? "",
              currentFollowers: 0,
            },
          ]);
        }
      }}
      title="셀러 검색 선택"
      placeholder="검색할 셀러 이름을 입력하세요"
    />
    </>
  );
}
