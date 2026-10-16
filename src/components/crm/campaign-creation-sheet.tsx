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
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import {
  type CampaignRow,
  type CampaignStatus,
  type DashboardData,
  type SalesChannel,
  type SnsType,
} from "@/lib/crm-types";
import { EntityIdentity } from "./entity-identity";
import { EntityLinkSelectField } from "./entity-link-select-field";
import { FormDialogFrame } from "./form-dialog-frame";
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
  // ⛔ 목록 첫 항목(updatedAt 최신 = 수집 잡이 마지막에 건드린 셀러·딜)을 미리 고르지 말 것 —
  // 오너가 그것을 「추천」이나 「이전 기록」으로 읽었다(2026-10-16). 딜 화면에서 그 딜로 만들 때만 고정한다.
  const [dealId, setDealId] = useState(lockedDealId ?? "");
  const [sellerId, setSellerId] = useState("");
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
      // Intentional reset when the sheet is reopened or preset inputs change.
      setDealId(lockedDealId ?? "");
      setSellerId("");
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
        <FormDialogFrame
          title="신규 캠페인 등록"
          description="영업 테스크 승인 전 예외적으로 캠페인을 직접 생성합니다."
          error={
            error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null
          }
          footer={
            <>
              {!saving && (!dealId || !sellerId) ? (
                <span className="mr-auto text-xs text-muted-foreground">
                  딜과 셀러를 골라야 등록할 수 있습니다.
                </span>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                취소
              </Button>
              <Button size="sm" onClick={createCampaign} disabled={isSubmitDisabled}>
                {saving ? "등록 중..." : "등록"}
              </Button>
            </>
          }
        >
          <FieldGroup className="gap-7">
            <FieldSet>
              <FieldLegend>딜과 셀러</FieldLegend>
              <EntityLinkSelectField
                label="딜"
                required
                selected={!!selectedDeal}
                emptyText="선택된 딜 없음"
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
                label="셀러"
                required
                selected={!!selectedSeller}
                emptyText="선택된 셀러 없음"
                actionLabel="셀러 선택"
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

              <Field>
                <div className="flex w-full items-center justify-between">
                  <FieldLabel>캠페인명</FieldLabel>
                  <Badge variant="secondary" className="h-5 px-1.5 py-0 font-medium text-[10px] bg-slate-100 text-slate-600">자동 생성</Badge>
                </div>
                <Input
                  value={defaultCampaignName}
                  disabled
                  placeholder="딜과 셀러를 고르면 자동으로 조합됩니다."
                  className="cursor-not-allowed bg-slate-50"
                />
                <FieldDescription>
                  셀러 별칭이 있으면 캠페인명에도 별칭을 우선 사용합니다.
                </FieldDescription>
              </Field>
            </FieldSet>

            <FieldSet>
              <FieldLegend>운영 기간</FieldLegend>
              <div className="grid grid-cols-2 gap-3">
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
            </FieldSet>
          </FieldGroup>
        </FormDialogFrame>
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
      currentId={dealId || undefined}
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
      currentId={sellerId || undefined}
    />
    </>
  );
}
