"use client";

import { useDealPanelData } from "@/hooks/useDealPanelData";
import { DealAssetSection } from "./deal-asset-section";
import { DealOptionsSection } from "./deal-options-section";
import { SupplementaryInfoFields } from "./deal-supplementary-info";
import { useDealLinks } from "@/hooks/useDealLinks";
import {
  formatCurrency,
  formatBusinessNumber,
  normalizeDealPanelData,
  computeSupplyPrice,
} from "@/utils/deal-panel-helpers";
import type { DealPanelData } from "@/utils/deal-panel-helpers";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Trash2,
  X,
  ExternalLink,
  Building2,
  Link2,
} from "lucide-react";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  type DealStatus,
  type BaseMarginPolicy,
  partnerTypeLabels,
  type PartnerType,
} from "@/lib/crm-types";
import { getValidNextStatuses } from "@/lib/deal-status";
import { ActivityTimeline } from "./activity-timeline";
import { MarginPolicyForm } from "./margin-policy-form";
import { InlineEditField } from "./inline-edit-field";
import { computeDiscountRate, formatDiscountRate } from "@/lib/discount-rate";

import { LinkSearchDialog } from "./link-search-dialog";
import { useDeferredSave } from "@/hooks/use-deferred-save";
import { cn } from "@/lib/utils";
import { LinkedSellersList } from "./linked-sellers-list";
import { DealSellerCandidates } from "./deal-seller-candidates";
import { DealVocSection } from "./deal-voc-section";
import { DealClaimsSection } from "./deal-claims-section";
import { DealOfferDiagnosticSection } from "./deal-offer-diagnostic-section";
import { LinkedCampaignsList } from "./linked-campaigns-list";
import { LinkedTasksList } from "./linked-tasks-list";

import { withMutationFeedback } from "@/lib/use-mutation-feedback";

// --- Types ---

/**
 * ⛔ 여기서 다시 정의하지 말 것 — 정본은 `@/utils/deal-panel-helpers` 하나다.
 * 분할 당시 58줄이 이 파일에도 복사돼 있었고, 사본 쪽 `status` 만 `any` 로 풀려
 * 두 벌이 조용히 갈라져 있었다. 기존 소비처(useDeals·useDealLinks·테스트)가
 * 이 경로로 가져가므로 재수출만 남긴다.
 */
export type { DealPanelData };

type DealsPanelProps = {
  deal: DealPanelData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated?: (deal: DealPanelData) => void;
  onDeleted?: (dealId: string) => void;
  onCreateOutreach?: (dealId: string, dealName: string) => void;
};

// --- Hooks ---

function useDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}

// --- Helpers ---

export function DealsPanel(props: DealsPanelProps) {
  // 컴포넌트 이름 변경 방지
  return <DealsPanelContent {...props} />;
}



function DealsPanelContent({
  deal,
  open,
  onOpenChange,
  onUpdated,
  onDeleted,
  onCreateOutreach,
}: DealsPanelProps) {
  const router = useRouter();
  const isDesktop = useDesktop();

  const [deleting, setDeleting] = useState(false);
  const [campaignLinkSearchOpen, setCampaignLinkSearchOpen] = useState(false);
  const [partnerLinkSearchOpen, setPartnerLinkSearchOpen] = useState(false);

  const {
    linkedCampaigns,
    loadingCampaigns,
    campaignsError,
    linkedSellers,
    loadingSellers,
    linkedTasks,
    loadingTasks,
    fetchDealDetails,
    fetchLinkedCampaigns,
    fetchLinkedSellers,
    fetchLinkedTasks,
  } = useDealPanelData({ deal, onUpdated, open });


  // Deferred save hook — accumulates changes, saves after 5s idle or on button click
  const handleDeferredSave = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!deal) return;

      const promise = fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then(async (res) => {
        if (!res.ok) throw new Error("Save failed");
        const updated = await res.json();
        onUpdated?.(
          normalizeDealPanelData(
            { ...deal, ...patch, ...updated } as Record<string, unknown>,
            deal,
          ),
        );
        return updated;
      });

      // 필드 수정의 단일 피드백 지점(handleDealUpdated는 이제 무음 상태동기화).
      withMutationFeedback(promise, "딜 정보가 업데이트되었습니다.").catch(
        () => {},
      );

      await promise.catch(() => {});
    },
    [deal, onUpdated],
  );

  const {
    hasPendingChanges,
    isSaving: isDeferredSaving,
    pendingChanges,
    updateField,
    saveNow,
    resetChanges,
  } = useDeferredSave({ onSave: handleDeferredSave, autoSave: false });

  const getFieldValue = useCallback(
    <K extends keyof DealPanelData>(key: K) => {
      if (pendingChanges[key as string] !== undefined) {
        return pendingChanges[key as string] as DealPanelData[K];
      }
      return deal?.[key];
    },
    [pendingChanges, deal],
  );


  // Reset deferred changes when deal changes
  useEffect(() => {
    resetChanges();
  }, [deal?.id, resetChanges]);

  const handleDelete = useCallback(async () => {
    if (!deal) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/deals/${deal.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("딜이 삭제되었습니다");
        onDeleted?.(deal.id);
        onOpenChange(false);
      } else {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "딜 삭제에 실패했습니다");
      }
    } catch {
      toast.error("딜 삭제에 실패했습니다");
    } finally {
      setDeleting(false);
    }
  }, [deal, onDeleted, onOpenChange]);

  // ⛔ 조기 return **위**에서 부른다 — 아래로 내리지 말 것. 이 패널은
  // `deals-page-client.tsx` 에서 항상 마운트된 채 `deal` 만 null↔객체로 토글되므로,
  // 조기 return 뒤에서 부르면 렌더마다 훅 개수가 달라진다(rules-of-hooks 위반).
  // 지금은 `useDealLinks` 안에 훅이 없어 터지지 않지만, 이름이 `use*` 인 이상
  // 누군가 useState 를 하나 넣는 순간 딜을 여는 즉시 크래시한다.
  const {
    handleCampaignLinkSelection,
    handleCampaignUnlink,
    handleTaskUnlink,
    handleSellerUnlink,
    handleLinkPartner,
    handleSellerLinkSelection,
  } = useDealLinks({
    deal,
    linkedSellers,
    linkedTasks,
    fetchLinkedCampaigns,
    fetchLinkedSellers,
    fetchLinkedTasks,
    onUpdated,
  });

  if (!deal) return null;

  async function handleMarginPolicyUpdate(newPolicy: BaseMarginPolicy) {
    updateField("baseMarginPolicy", newPolicy);
  }

  // --- Inline field save handler (deferred — queues change for batch save) ---
  async function handleInlineFieldSave(field: string, value: string | number) {
    updateField(field, value === "" ? null : value);

    if (!deal) return;

    // 연관된 필드(판매가, 공급가, 수수료율) 자동 계산 연동
    if (field === "sellingPrice" || field === "totalCommissionRate") {
      const numValue = value === "" ? null : Number(value);
      const currentSellingPrice =
        field === "sellingPrice"
          ? numValue
          : Number(getFieldValue("sellingPrice") ?? 0);
      const currentFeeRate =
        field === "totalCommissionRate"
          ? numValue
          : getFieldValue("totalCommissionRate") == null
            ? null
            : Number(getFieldValue("totalCommissionRate"));
      const newSupplyPrice = computeSupplyPrice(
        currentSellingPrice,
        currentFeeRate,
      );
      if (newSupplyPrice != null) {
        if (newSupplyPrice !== deal.supplyPrice) {
          updateField("supplyPrice", newSupplyPrice);
        }
      }
    }
  }

  const liveDiscountRate = computeDiscountRate(
    deal.listPrice,
    deal.sellingPrice,
  );

  const isInternalMigrationNote = (memo: string) =>
    /autofill-safe-|reconciled-to-/.test(memo);

  const body = (
    /* Radix ScrollArea 대신 네이티브 스크롤 — Radix 는 네이티브 스크롤바를 숨겨
       비오버레이 스크롤바(Windows) 환경에서 "잘렸는데 스크롤바 없는" 상태가 된다
       (PR #57 근본원인). 상세 Sheet 는 side=right 라 h-full(확정 높이)이므로 이
       h-full 스크롤러가 정상 해소된다(seller-detail-content 의 검증된 패턴). */
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="space-y-6 overflow-hidden p-1 pr-3">
        {/* Deal Details */}
        <div className="space-y-3 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm relative">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">기본 정보</h3>
            {hasPendingChanges && (
              <Button
                size="sm"
                className="h-7 text-xs px-3 shadow-soft-sm bg-blue-600 hover:bg-blue-700 text-white"
                onClick={() => void saveNow()}
                disabled={isDeferredSaving}
              >
                {isDeferredSaving ? "저장 중..." : "변경사항 저장"}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <InlineEditField
              label="딜 이름"
              fieldType="text"
              value={(getFieldValue("dealName") as string) ?? ""}
              onSave={async (val) => {
                await handleInlineFieldSave("dealName", val);
              }}
              prioritizeEditorWidth
            />

            <InlineEditField
              label="브랜드"
              fieldType="text"
              value={(getFieldValue("brandName") as string) ?? ""}
              onSave={async (val) => {
                await handleInlineFieldSave("brandName", val);
              }}
            />

            <InlineEditField
              label="판매 단위"
              description="단품 구성일 경우 단위를 입력하세요 (예: 박스, 통)"
              descriptionAsTooltip
              fieldType="text"
              value={(getFieldValue("unit") as string) ?? ""}
              onSave={async (val) => {
                await handleInlineFieldSave("unit", val);
              }}
            />

            <InlineEditField
              label="기본 수량"
              description="상위 딜의 기본 수량입니다"
              descriptionAsTooltip
              fieldType="number"
              value={
                getFieldValue("unitQuantity") != null
                  ? String(getFieldValue("unitQuantity"))
                  : ""
              }
              onSave={async (val) => {
                await handleInlineFieldSave("unitQuantity", val);
              }}
            />

            <SupplementaryInfoFields
              supplementaryInfoStr={
                (getFieldValue("supplementaryInfo") as string) ?? ""
              }
              onSave={async (val) => {
                await handleInlineFieldSave("supplementaryInfo", val);
              }}
              onForceSave={async () => {
                await saveNow();
              }}
              dealName={(getFieldValue("dealName") as string) ?? ""}
              brandName={(getFieldValue("brandName") as string) ?? ""}
            />

            <InlineEditField
              label="정상가"
              description="소비자가격"
              descriptionAsTooltip
              fieldType="number"
              value={
                getFieldValue("listPrice") != null
                  ? String(getFieldValue("listPrice"))
                  : ""
              }
              displayValue={
                getFieldValue("listPrice") != null
                  ? formatCurrency(Number(getFieldValue("listPrice")))
                  : "-"
              }
              onSave={async (val) => {
                await handleInlineFieldSave("listPrice", val);
              }}
            />

            <InlineEditField
              label="판매가"
              description="공동구매 행사가격"
              descriptionAsTooltip
              fieldType="number"
              value={String(getFieldValue("sellingPrice") ?? 0)}
              displayValue={formatCurrency(
                Number(getFieldValue("sellingPrice") ?? 0),
              )}
              badgeText={
                liveDiscountRate && liveDiscountRate > 0
                  ? formatDiscountRate(liveDiscountRate)
                  : undefined
              }
              onSave={async (val) => {
                await handleInlineFieldSave("sellingPrice", val);
              }}
            />

            <InlineEditField
              label="최저가"
              description="행사가격 제외 모든 채널 기준 최저가격"
              descriptionAsTooltip
              fieldType="number"
              value={
                getFieldValue("floorPrice") != null
                  ? String(getFieldValue("floorPrice"))
                  : ""
              }
              displayValue={
                getFieldValue("floorPrice") != null
                  ? formatCurrency(Number(getFieldValue("floorPrice")))
                  : "-"
              }
              prioritizeEditorWidth
              onSave={async (val) => {
                await handleInlineFieldSave("floorPrice", val);
              }}
            />

            <InlineEditField
              label="총수수료율"
              description="판매가 대비 수수료율입니다. 공급가는 이 값으로 자동 계산됩니다"
              descriptionAsTooltip
              fieldType="number"
              value={
                getFieldValue("totalCommissionRate") != null
                  ? String(getFieldValue("totalCommissionRate"))
                  : ""
              }
              displayValue={
                getFieldValue("totalCommissionRate") != null
                  ? `${getFieldValue("totalCommissionRate")}%`
                  : "-"
              }
              prioritizeEditorWidth
              onSave={async (val) => {
                await handleInlineFieldSave("totalCommissionRate", val);
              }}
            />

            <InlineEditField
              label="공급가"
              description="판매가와 총수수료율로 자동 계산됩니다"
              descriptionAsTooltip
              fieldType="number"
              value={String(
                computeSupplyPrice(
                  Number(getFieldValue("sellingPrice") ?? 0),
                  getFieldValue("totalCommissionRate") == null
                    ? null
                    : Number(getFieldValue("totalCommissionRate")),
                ) ??
                  getFieldValue("supplyPrice") ??
                  "",
              )}
              displayValue={(() => {
                const computedSupplyPrice = computeSupplyPrice(
                  Number(getFieldValue("sellingPrice") ?? 0),
                  getFieldValue("totalCommissionRate") == null
                    ? null
                    : Number(getFieldValue("totalCommissionRate")),
                );
                const displaySupplyPrice =
                  computedSupplyPrice ?? getFieldValue("supplyPrice");
                return displaySupplyPrice != null
                  ? formatCurrency(Number(displaySupplyPrice))
                  : "-";
              })()}
              isComputed
              onSave={async () => {}}
            />

            {/* 진행 상태 오픈형 스텝 바 */}
            <div className="col-span-1 sm:col-span-2 flex flex-col gap-1.5 mt-2 pt-2 border-t border-slate-100">
              <span className="text-xs font-medium text-muted-foreground">
                진행 상태
              </span>
              <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-lg border border-slate-200/60 w-full overflow-x-auto">
                <div className="flex items-center gap-1 flex-1">
                  {[
                    { value: "SOURCING", label: "발굴" },
                    { value: "NEGOTIATING", label: "협의" },
                    { value: "SAMPLE_TESTING", label: "샘플 테스트" },
                    { value: "CONFIRMED", label: "확정" },
                  ].map((step) => {
                    const isCurrentStep = deal.status === step.value;
                    const canTransition = getValidNextStatuses(
                      deal.status,
                    ).includes(step.value as DealStatus);
                    const isSelected =
                      step.value === "CONFIRMED"
                        ? deal.status === "CONFIRMED" ||
                          deal.status === "ARCHIVED"
                        : deal.status === step.value;
                    return (
                      <button
                        key={step.value}
                        type="button"
                        onClick={async () => {
                          await handleInlineFieldSave("status", step.value);
                        }}
                        disabled={isDeferredSaving || isCurrentStep || !canTransition}
                        className={cn(
                          "flex-1 py-1.5 px-3 rounded-md text-xs font-semibold transition-colors text-center whitespace-nowrap",
                          isSelected
                            ? "bg-slate-900 text-white shadow-soft-sm"
                            : canTransition
                              ? "text-muted-foreground hover:text-foreground hover:bg-slate-200/50"
                              : "cursor-not-allowed text-slate-300",
                        )}
                      >
                        {step.label}
                      </button>
                    );
                  })}
                </div>

                <div className="h-6 w-px bg-slate-200 mx-1 shrink-0" />

                <button
                  type="button"
                  onClick={async () => {
                    await handleInlineFieldSave("status", "DROPPED");
                  }}
                  disabled={isDeferredSaving}
                  className={cn(
                    "py-1.5 px-3 rounded-md text-xs font-semibold transition-colors text-center whitespace-nowrap shrink-0",
                    deal.status === "DROPPED"
                      ? "bg-red-50 text-red-600 border border-red-200/60 font-semibold shadow-soft-sm"
                      : "text-muted-foreground hover:text-red-500 hover:bg-red-50/50",
                  )}
                >
                  보류
                </button>
              </div>
            </div>
          </div>
          {deal.sourcingMemo && !isInternalMigrationNote(deal.sourcingMemo) ? (
            <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-foreground">
              {deal.sourcingMemo}
            </div>
          ) : null}
        </div>

        <DealOptionsSection deal={deal} fetchDealDetails={fetchDealDetails} />

        <div className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">
              수수료 정책
            </h3>
          </div>

          <MarginPolicyForm
            value={deal.baseMarginPolicy || { byChannel: {} }}
            onChange={handleMarginPolicyUpdate}
            disabled={isDeferredSaving}
          />
        </div>

        {/* 연결된 거래처 섹션 */}
        <div className="space-y-3 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">
              연결된 거래처
            </h3>
            <Button
              variant="outline"
              onClick={() => setPartnerLinkSearchOpen(true)}
              className="h-5.5 text-[10px] px-2 py-0 gap-0.5 rounded-md border-slate-200 text-slate-600 inline-flex items-center"
            >
              <Link2 className="size-2.5" />
              <span>연결</span>
            </Button>
          </div>
          <Separator />

          {deal.partnerId && deal.partner ? (
            <div className="border border-border/60 bg-muted/10 rounded-lg p-3 h-[74px] flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Building2 className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-bold text-foreground truncate">
                    {deal.partner.name}
                  </span>
                  {deal.partner.type && (
                    <Badge
                      variant="outline"
                      className="border-blue-100 bg-blue-50/20 text-blue-600 font-semibold text-[9px] px-1 py-0.2 rounded hover:bg-blue-50/20 leading-none shrink-0"
                    >
                      {partnerTypeLabels[deal.partner.type as PartnerType] ??
                        deal.partner.type}
                    </Badge>
                  )}
                </div>
                <a
                  href={`/partners?selectedPartner=${deal.partnerId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  title="거래처 상세 페이지로 이동"
                >
                  <ExternalLink className="size-3" />
                </a>
              </div>

              <div className="flex items-center justify-between gap-2 text-[10px] w-full">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="border border-border/80 bg-muted/30 px-1 py-0.5 rounded text-[9px] text-muted-foreground font-medium shrink-0 leading-none">
                    대표
                  </span>
                  <span className="text-[10px] text-foreground font-medium truncate">
                    {deal.partner.ceoName || "—"}
                  </span>
                </div>
                <div className="flex items-center gap-1 min-w-0">
                  <span className="border border-border/80 bg-muted/30 px-1 py-0.5 rounded text-[9px] text-muted-foreground font-medium shrink-0 leading-none">
                    사업자번호
                  </span>
                  <span className="text-[10px] text-foreground font-mono truncate">
                    {deal.partner.businessNumber
                      ? formatBusinessNumber(deal.partner.businessNumber)
                      : "—"}
                  </span>
                </div>
                <div className="flex items-center gap-1 min-w-0">
                  <span className="border border-border/80 bg-muted/30 px-1 py-0.5 rounded text-[9px] text-muted-foreground font-medium shrink-0 leading-none">
                    연락처
                  </span>
                  <span className="text-[10px] text-foreground truncate">
                    {deal.partner.contactInfo || "—"}
                  </span>
                </div>
                <div className="flex items-center gap-1 min-w-0">
                  <span className="border border-border/80 bg-muted/30 px-1 py-0.5 rounded text-[9px] text-muted-foreground font-medium shrink-0 leading-none">
                    이메일
                  </span>
                  <span
                    className="text-[10px] text-foreground truncate"
                    title={deal.partner.representativeEmail || ""}
                  >
                    {deal.partner.representativeEmail || "—"}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="border border-border/60 bg-muted/5 rounded-lg p-3 h-[74px] flex items-center justify-center text-center">
              <p className="text-xs text-muted-foreground">
                연결된 거래처가 없습니다
              </p>
            </div>
          )}
        </div>

        {/* 연결된 캠페인 섹션 */}
        <div className="rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <LinkedCampaignsList
            campaigns={linkedCampaigns.map((c) => ({
              id: c.id,
              dealId: deal.id,
              sellerId: "",
              dealName: deal.dealName,
              sellerName: c.sellerName,
              brandName: deal.brandName,
              startDate: c.startDate,
              endDate: c.endDate,
              status: c.status,
            }))}
            loading={loadingCampaigns}
            error={campaignsError}
            emptyMessage="연결된 캠페인이 없습니다"
            onLinkClick={() => setCampaignLinkSearchOpen(true)}
            onUnlinkClick={handleCampaignUnlink}
            onEntityClick={(entityId) => {
              router.push(`/pipeline?campaignId=${entityId}`);
              onOpenChange(false);
            }}
            onRetry={() => void fetchLinkedCampaigns(deal)}
          />
        </div>

        {/* 영업 테스크 섹션 */}
        <div className="rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <LinkedTasksList
            tasks={linkedTasks.map((t) => ({
              id: t.id,
              title: t.sellerName,
              status: t.status,
              dueDate: t.proposedAt,
            }))}
            title={`영업 테스크 (${linkedTasks.length}건)`}
            loading={loadingTasks}
            emptyMessage="연결된 영업 테스크가 없습니다"
            linkButtonLabel="연결"
            onLinkClick={() => onCreateOutreach?.(deal.id, deal.dealName)}
            onUnlinkClick={handleTaskUnlink}
            onEntityClick={(taskId) => {
              router.push(`/outreach?outreachId=${taskId}`);
              onOpenChange(false);
            }}
          />
        </div>

        {/* 제안 후보 셀러 섹션 (D2① — 읽기 전용. 제안은 기존 아웃리치 생성 경로를 탄다) */}
        <div className="rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <DealSellerCandidates
            dealId={deal.id}
            dealName={deal.dealName}
            onPropose={(dealId, dealName) => onCreateOutreach?.(dealId, dealName)}
          />
        </div>

        {/* 연결된 셀러 섹션 */}
        <div className="rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
          <LinkedSellersList
            sellers={linkedSellers.map((s) => ({
              id: s.id,
              name: s.name,
              followerCount: s.followers,
              fitLevel: s.fitLevel,
              snsType: s.snsType,
              snsHandle: s.snsHandle,
              followers: s.followers ?? undefined,
              socialNetworks: [
                { network: s.snsType, handle: s.snsHandle, url: "" },
              ],
            }))}
            loading={loadingSellers}
            emptyMessage="연결된 셀러가 없습니다"
            onLinkSeller={handleSellerLinkSelection}
            onUnlinkClick={handleSellerUnlink}
            excludeIds={linkedSellers.map((s) => s.id)}
            onEntityClick={(sellerId) => {
              router.push(`/sellers?selectedSeller=${sellerId}`);
              onOpenChange(false);
            }}
          />
        </div>

        {/* 첨부 자료 */}
        <DealAssetSection dealId={deal.id} />

        {/* 고객 반응(VOC) — 상품 문의 + 리뷰 집계 (Phase 1b) */}
        {/* key=딜 — 딜 전환 시 리마운트로 갱신중·쿨다운·이전 딜 데이터 상태 누수 차단(코드리뷰 H2) */}
        <DealVocSection key={deal.id} dealId={deal.id} />

        {/* 표현 관리(클레임 레지스트리) — 표현 검사·자료 생성의 게이트 입력(C1 M2b).
            key=딜 — VOC 와 같은 이유로 딜 전환 시 이전 딜의 목록·입력 상태 누수를 막는다. */}
        <div className="rounded-[24px] border border-border/70 bg-white/90 px-4 py-3 shadow-soft-sm">
          <DealClaimsSection key={deal.id} dealId={deal.id} />
        </div>

        {/* 오퍼 진단 — 표현 관리 바로 아래에 둔다(C2 M2). 위가 "이 표현을 써도
            되는가"(합법성)면 여기는 "이 오퍼가 팔릴 구조인가"(설계 품질)로,
            같은 딜의 다른 축이다. 표현을 다듬기 전에 보는 것이 순서다. */}
        <div className="rounded-[24px] border border-border/70 bg-white/90 px-4 py-3 shadow-soft-sm">
          <DealOfferDiagnosticSection key={deal.id} dealId={deal.id} />
        </div>

        {/* Activity Timeline */}
        <div className="rounded-[24px] border border-border/70 bg-white/90 px-4 py-3 shadow-soft-sm">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="activity" className="border-b-0">
              <AccordionTrigger className="py-4 text-xs font-semibold text-foreground hover:no-underline">
                활동 기록
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <ActivityTimeline entityType="DEAL" entityId={deal.id} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        {/* Delete Deal */}
        <div className="pb-4">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                disabled={deleting}
              >
                <Trash2 className="mr-1.5 size-4" />딜 삭제
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>딜을 삭제하시겠습니까?</AlertDialogTitle>
                <AlertDialogDescription>
                  이 작업은 되돌릴 수 없습니다. 딜 &quot;{deal.dealName}
                  &quot;이(가) 영구적으로 삭제됩니다.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>취소</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? "삭제 중..." : "삭제"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Sticky save button */}
      {hasPendingChanges && (
        <div className="sticky bottom-0 border-t border-border/70 bg-white/95 px-4 py-3 backdrop-blur">
          <Button
            onClick={() => void saveNow()}
            disabled={isDeferredSaving}
            className="w-full"
          >
            {isDeferredSaving ? "저장 중..." : "저장하기"}
          </Button>
        </div>
      )}
    </div>
  );

  const panel = isDesktop ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        style={{ width: "min(640px, 96vw)", maxWidth: "min(640px, 96vw)" }}
        className="flex flex-col overflow-hidden border-l border-border/70 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0"
      >
        <SheetHeader className="shrink-0 border-b border-border/70 px-6 py-5">
          <SheetTitle>딜 상세</SheetTitle>
          <SheetDescription>
            딜 정보 및 수수료 정책을 확인하고 수정합니다.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">{body}</div>
      </SheetContent>
    </Sheet>
  ) : (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[88vh] px-5 pb-5 duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]">
        <DrawerHeader className="flex-row items-center justify-between px-0">
          <div>
            <DrawerTitle>딜 상세</DrawerTitle>
            <DrawerDescription>
              딜 정보 및 수수료 정책을 관리합니다.
            </DrawerDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </DrawerHeader>
        {body}
      </DrawerContent>
    </Drawer>
  );

  return (
    <>
      {panel}
      <LinkSearchDialog
        open={campaignLinkSearchOpen}
        onOpenChange={setCampaignLinkSearchOpen}
        entityType="campaign"
        searchEndpoint="/api/search/campaigns"
        searchParams={{ excludeDealId: deal.id }}
        title="연결할 캠페인 검색"
        placeholder="셀러명 또는 판매채널 검색"
        onSelect={(item) => {
          void handleCampaignLinkSelection(item);
        }}
      />
      <LinkSearchDialog
        open={partnerLinkSearchOpen}
        onOpenChange={setPartnerLinkSearchOpen}
        entityType="partner"
        searchEndpoint="/api/search/partners"
        title="연결할 거래처 검색"
        placeholder="거래처명 검색"
        onSelect={async (item) => {
          await handleLinkPartner(item.id);
          setPartnerLinkSearchOpen(false);
        }}
      />
    </>
  );
}



