"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes } from "lucide-react";
import { toast } from "sonner";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { filterBySearchText } from "@/lib/search-filter";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  salesChannelLabels,
  type CampaignStatus,
  type CampaignRow,
  type DashboardData,
  type SalesChannel,
  type SnsType,
} from "@/lib/crm-types";
import { EntityLinkSelectField } from "./entity-link-select-field";
import { LinkSearchDialog } from "./link-search-dialog";
import { SellerIdentityInfo } from "./seller-identity-info";

/**
 * CG-1 표면 ⓐ — 조합 캠페인 일괄 생성 다이얼로그.
 *
 * "셀러 1명 × 딜 N개(≥2)"를 공통 기간·채널로 한 번에 만들고 그룹으로 묶는다.
 * 기존 브로드캐스트 bulk(1딜×N셀러)와 의미가 역방향이므로 진입점·제목·구조로 분리한다.
 *
 * 원자성: POST /api/campaigns/bulk-combo는 전부-아니면-전무 트랜잭션이라 부분성공 뷰가 없다.
 * 차수(N차)는 서버 소유값이라 클라이언트가 위조하지 않는다(미리보기는 "차수 자동" 메타만).
 */

type BulkComboCampaignDialogProps = {
  data: DashboardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: CampaignRow[]) => void;
  defaultStatus?: CampaignStatus;
};

type DealOption = {
  id: string;
  dealName: string;
  contextLabel: string | null;
};

type SellerOption = {
  id: string;
  name: string;
  alias: string | null;
  snsType: SnsType;
  snsHandle: string;
};

function today(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function toDealOption(deal: DashboardData["deals"][number]): DealOption {
  return {
    id: deal.id,
    dealName: deal.dealName,
    contextLabel:
      deal.brandName || deal.partner?.name || deal.partnerCompanyName || null,
  };
}

const BIG_COMBO_THRESHOLD = 8;
const DEAL_FILTER_THRESHOLD = 6;

export function BulkComboCampaignDialog({
  data,
  open,
  onOpenChange,
  onCreated,
  defaultStatus,
}: BulkComboCampaignDialogProps) {
  const [sellerId, setSellerId] = useState("");
  const [selectedDealIds, setSelectedDealIds] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today(7));
  const [salesChannel, setSalesChannel] = useState<SalesChannel>("UNSPECIFIED");
  const [dealFilter, setDealFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSellerSearchOpen, setIsSellerSearchOpen] = useState(false);
  const [localSellers, setLocalSellers] = useState<SellerOption[]>(() =>
    data.sellers.map((seller) => ({
      id: seller.id,
      name: seller.name,
      alias: seller.alias ?? null,
      snsType: seller.snsType,
      snsHandle: seller.snsHandle,
    })),
  );

  useEffect(() => {
    if (!open) return;
    // 다이얼로그 재오픈 시 초기화(단건 시트 선례와 동일 관행).
    setSellerId("");
    setSelectedDealIds(new Set());
    setStartDate(today());
    setEndDate(today(7));
    setSalesChannel("UNSPECIFIED");
    setDealFilter("");
    setSaving(false);
    setError(null);
    setIsSellerSearchOpen(false);
    setLocalSellers(
      data.sellers.map((seller) => ({
        id: seller.id,
        name: seller.name,
        alias: seller.alias ?? null,
        snsType: seller.snsType,
        snsHandle: seller.snsHandle,
      })),
    );
  }, [open, data.sellers]);

  const dealOptions = useMemo<DealOption[]>(
    () => data.deals.map(toDealOption),
    [data.deals],
  );

  const selectedSeller = useMemo(
    () => localSellers.find((seller) => seller.id === sellerId) ?? null,
    [localSellers, sellerId],
  );
  const sellerLabel = selectedSeller
    ? selectedSeller.alias || selectedSeller.name
    : "";

  const showDealFilter = dealOptions.length > DEAL_FILTER_THRESHOLD;
  const filteredDealOptions = useMemo(
    () =>
      filterBySearchText(dealOptions, dealFilter, (deal) => [
        deal.dealName,
        deal.contextLabel ?? "",
      ]),
    [dealOptions, dealFilter],
  );

  const selectedDeals = useMemo(
    () => dealOptions.filter((deal) => selectedDealIds.has(deal.id)),
    [dealOptions, selectedDealIds],
  );

  const selectedCount = selectedDealIds.size;
  const sellerSelected = Boolean(sellerId);
  const hasEnoughDeals = selectedCount >= 2;
  const isBigCombo = selectedCount >= BIG_COMBO_THRESHOLD;
  const isSubmitDisabled = saving || !sellerSelected || !hasEnoughDeals;

  function toggleDeal(dealId: string) {
    setSelectedDealIds((prev) => {
      const next = new Set(prev);
      if (next.has(dealId)) {
        next.delete(dealId);
      } else {
        next.add(dealId);
      }
      return next;
    });
  }

  async function submit() {
    if (isSubmitDisabled) return;
    setSaving(true);
    setError(null);
    await withMutationFeedback(
      (async () => {
        const response = await fetch("/api/campaigns/bulk-combo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sellerId,
            dealIds: Array.from(selectedDealIds),
            startDate,
            endDate,
            salesChannel,
            status: defaultStatus ?? "PROPOSAL",
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message =
            (payload && typeof payload.error === "string" && payload.error) ||
            "조합 캠페인 생성에 실패했습니다.";
          throw new Error(message);
        }
        const created = (payload?.created ?? []) as CampaignRow[];
        onCreated(created);
        toast.success(`조합 캠페인 ${created.length}건을 그룹으로 만들었습니다.`, {
          icon: <Boxes className="size-4 text-primary" />,
        });
        onOpenChange(false);
      })(),
    ).catch((err: unknown) => {
      const message =
        err instanceof Error && err.message ? err.message : "조합 캠페인 생성에 실패했습니다.";
      const isNetwork = message === "Failed to fetch" || message === "Network error";
      setError(isNetwork ? "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." : message);
    });
    setSaving(false);
  }

  const previewSummary = hasEnoughDeals
    ? `현재 ${selectedCount}개 딜, 예상 캠페인 ${selectedCount}건`
    : "딜을 2개 이상 선택하세요";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* 높이는 내용이 아니라 뷰포트에만 반응한다(고정 높이) — 딜 검색·선택으로
            내부 행 수가 바뀌어도 다이얼로그 프레임은 움직이지 않는다(흔들림 방지).
            90dvh 하한 덕에 낮은 노트북 해상도에서도 푸터가 항상 화면 안에 있다.
            54rem 은 실측 최소 구성(섹션 합 858px)이 바깥 스크롤 없이 들어가는 값. */}
        <DialogContent className="sm:max-w-xl bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0 overflow-hidden flex flex-col gap-0 h-[min(54rem,90dvh)]">
          <DialogHeader className="shrink-0 border-b border-border/70 px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <Boxes className="size-4 text-primary" aria-hidden="true" />
              조합 캠페인 만들기
            </DialogTitle>
            <DialogDescription>
              한 셀러에게 여러 딜을 같은 기간으로 한 번에 올립니다.
            </DialogDescription>
          </DialogHeader>

          {/* Radix ScrollArea 대신 네이티브 스크롤 — Radix 는 네이티브 스크롤바를 숨기고
              hover 시에만 자체 바를 그려, Windows(비오버레이 스크롤바)에서 "잘렸는데
              스크롤바가 없는" 상태가 된다. 평상시엔 딜 목록(flex-1)이 남는 높이를 모두
              흡수해 이 바깥 스크롤은 등장하지 않고, 최소 높이가 안 나오는 아주 작은
              창에서만 폴백으로 나타난다. scrollbar-gutter 는 등장 시 폭 흔들림 방지. */}
          <FieldGroup className="min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
              {/* [S1] 셀러(단일) */}
              <div className="flex shrink-0 flex-col gap-2">
                <EntityLinkSelectField
                  label="셀러"
                  selected={!!selectedSeller}
                  emptyText="선택된 셀러가 없습니다."
                  actionLabel="셀러 검색 선택"
                  changeLabel="셀러 변경"
                  onOpen={() => setIsSellerSearchOpen(true)}
                  selectedContent={
                    <SellerIdentityInfo
                      sellerName={sellerLabel || "로딩 중..."}
                      snsHandle={selectedSeller?.snsHandle ?? null}
                      snsType={selectedSeller?.snsType ?? null}
                      variant="heading"
                    />
                  }
                />
                <FieldDescription className="text-xs">
                  이 셀러의 딜만 아래에서 고를 수 있습니다.
                </FieldDescription>
              </div>

              {/* [S2] 딜 조합(다중 N≥2) */}
              {/* 딜 목록이 유일한 신축 구간(flex-1) — 고정 높이 다이얼로그에서 남는
                  높이를 전부 받아 내부 스크롤로 소화한다. min-h-48 은 작은 창 폴백
                  스크롤이 켜질 때도 목록이 3~4행은 보이게 하는 바닥이다. */}
              <fieldset
                className={
                  sellerSelected
                    ? "flex min-h-48 flex-1 flex-col gap-2"
                    : "flex min-h-48 flex-1 flex-col gap-2 opacity-50 pointer-events-none"
                }
                disabled={!sellerSelected}
                aria-describedby="combo-deal-hint"
              >
                <div className="flex items-center justify-between gap-3">
                  <legend className="flex items-center gap-2 text-sm font-medium">
                    딜 조합
                    <Badge variant="secondary">{selectedCount}개</Badge>
                  </legend>
                  {showDealFilter ? (
                    <Input
                      value={dealFilter}
                      onChange={(event) => setDealFilter(event.target.value)}
                      placeholder="딜 검색"
                      aria-label="딜 검색 필터"
                      className="h-8 w-36 text-xs"
                    />
                  ) : null}
                </div>
                <div
                  role="group"
                  aria-label="딜 조합 선택"
                  className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2 [scrollbar-gutter:stable]"
                >
                  {!sellerSelected ? (
                    <FieldDescription className="my-auto py-2 text-center text-xs">
                      먼저 셀러를 선택하세요
                    </FieldDescription>
                  ) : dealOptions.length === 0 ? (
                    <FieldDescription className="my-auto py-2 text-center text-xs">
                      이 셀러로 만들 수 있는 딜이 없습니다
                    </FieldDescription>
                  ) : filteredDealOptions.length === 0 ? (
                    <FieldDescription className="my-auto py-2 text-center text-xs">
                      검색 결과가 없습니다
                    </FieldDescription>
                  ) : (
                    filteredDealOptions.map((deal) => (
                      <label
                        key={deal.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          checked={selectedDealIds.has(deal.id)}
                          onChange={() => toggleDeal(deal.id)}
                          className="size-4 rounded border-input accent-primary"
                        />
                        <span className="flex-1 truncate" title={deal.dealName}>
                          {deal.dealName}
                        </span>
                        {deal.contextLabel ? (
                          <span
                            className="shrink-0 truncate text-xs text-muted-foreground"
                            title={deal.contextLabel}
                          >
                            {deal.contextLabel}
                          </span>
                        ) : null}
                      </label>
                    ))
                  )}
                </div>
                <FieldDescription id="combo-deal-hint" className="text-xs">
                  {hasEnoughDeals
                    ? "선택한 딜마다 캠페인 1건이 만들어집니다."
                    : "조합은 딜 2개 이상이 필요합니다"}
                </FieldDescription>
              </fieldset>

              {/* [S3] 공통 기간·채널 */}
              <div className="shrink-0 rounded-xl border border-border bg-card p-4 shadow-soft-sm flex flex-col gap-3">
                <div className="text-sm font-semibold text-foreground">
                  공통 운영 기간 · 채널 (선택한 딜 전체에 적용)
                </div>
                {/* 한 줄 3열 — 세로 공간을 아껴 고정 높이 안에서 딜 목록 몫을 키운다.
                    채널 열은 최소 8.5rem 보장 — "자사몰(네이버)/자사몰(카카오)"가 닫힌
                    트리거에서 잘리면 구분 지점이 사라진다(ss-ux 검토 필수 지적). 날짜
                    열은 minmax(0,1fr)로 date input 고유 최소폭의 그리드 지배를 끊는다. */}
                <div className="grid gap-3 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(8.5rem,1.3fr)]">
                  <Field>
                    <FieldLabel>시작일</FieldLabel>
                    <Input
                      type="date"
                      value={startDate}
                      disabled={saving}
                      onChange={(event) => setStartDate(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>마감일</FieldLabel>
                    <Input
                      type="date"
                      value={endDate}
                      disabled={saving}
                      onChange={(event) => setEndDate(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>판매 채널</FieldLabel>
                    <Select
                      value={salesChannel}
                      onValueChange={(value) => setSalesChannel(value as SalesChannel)}
                      disabled={saving}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {(Object.keys(salesChannelLabels) as SalesChannel[]).map((ch) => (
                            <SelectItem key={ch} value={ch}>
                              {salesChannelLabels[ch]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              </div>

              {/* 큰 조합 경고(차단 아님) */}
              {isBigCombo ? (
                <div
                  className="shrink-0 rounded-lg border p-3 text-xs"
                  style={{
                    borderColor: "var(--status-caution)",
                    background: "var(--status-caution-bg)",
                    color: "var(--status-caution)",
                  }}
                >
                  조합이 큽니다. 같은 셀러·같은 기간이 맞는지 확인하세요
                </div>
              ) : null}

              {/* [S4] 미리보기 — 선택 딜이 많아도 캡(max-h) 안에서 내부 스크롤.
                  미리보기가 자라며 딜 목록을 무한정 밀어내지 않게 한다. */}
              <div className="flex shrink-0 flex-col gap-2">
                <div className="text-sm font-medium">미리보기</div>
                <div
                  className="max-h-36 overflow-y-auto rounded-lg border border-border bg-slate-50/60 p-3 [scrollbar-gutter:stable]"
                  aria-live="polite"
                >
                  <span className="sr-only">{previewSummary}</span>
                  {selectedDeals.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      딜을 선택하면 캠페인 이름이 여기에 표시됩니다.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {selectedDeals.map((deal) => {
                        const generated = [deal.dealName, sellerLabel]
                          .filter(Boolean)
                          .join(" - ");
                        return (
                          <li
                            key={deal.id}
                            className="flex min-w-0 items-center gap-2 text-xs"
                          >
                            <span
                              className="min-w-0 max-w-[35%] truncate text-muted-foreground"
                              title={deal.dealName}
                            >
                              {deal.dealName}
                            </span>
                            <span className="shrink-0 text-muted-foreground">→</span>
                            <span
                              className="min-w-0 flex-1 truncate font-medium text-foreground"
                              title={generated}
                            >
                              {generated}
                            </span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              · 차수 자동
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>

          </FieldGroup>

          {/* 오류는 스크롤 영역 밖 고정 스트립 — 본문이 길어도 실패 사유가 항상 보인다. */}
          {error ? (
            <Alert variant="destructive" className="mx-6 mb-4 shrink-0">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className="shrink-0 border-t border-border/70 p-6 bg-slate-50/50 mx-0 mb-0">
            <div className="flex w-full items-center justify-end gap-3">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                취소
              </Button>
              <Button
                size="sm"
                onClick={submit}
                disabled={isSubmitDisabled}
                aria-describedby="combo-deal-hint"
              >
                {saving ? "생성 중…" : `${selectedCount}개 캠페인 만들기`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LinkSearchDialog
        open={isSellerSearchOpen}
        onOpenChange={setIsSellerSearchOpen}
        entityType="seller"
        searchEndpoint="/api/search/sellers"
        onSelect={(seller) => {
          setSellerId(seller.id);
          setSelectedDealIds(new Set());
          if (!localSellers.some((item) => item.id === seller.id)) {
            setLocalSellers((prev) => [
              ...prev,
              {
                id: seller.id,
                name: seller.label,
                alias: seller.metadata?.alias ?? null,
                snsType: (seller.metadata?.snsType || "INSTAGRAM") as SnsType,
                snsHandle: seller.metadata?.snsHandle ?? "",
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
