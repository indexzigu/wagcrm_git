"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, UserRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { generateCampaignName } from "@/lib/campaign-name";
import type { DraftCampaignResult } from "@/lib/mobile-draft-campaign";
import { MobileSheetCard } from "./mobile-sheet-card";
import { MobileSheetHeader } from "./mobile-sheet-header";
import { cn } from "@/lib/utils";

/**
 * 입력창 공통 필 — 미선택은 슬레이트 필(페이지와 같은 톤), 선택 완료는 흰 배경 +
 * 네이비 보더로 "값이 확정됐다"를 색으로 알린다(오너 목업 §3).
 * 포커스 링은 --focus-ring 토큰(3:1) — 구 outline-ring(약 1.4:1)에서 교정.
 */
const FIELD_CLASS =
  "min-h-11 rounded-xl border px-3 text-sm text-foreground placeholder:text-slate-400 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring";
const FIELD_IDLE = "border-slate-200 bg-slate-50";
const FIELD_SELECTED = "border-primary/25 bg-white font-semibold";

/**
 * 예비 캠페인 경량 생성 시트 (MOBILE_UX_PLAN §4 · Phase 4).
 *
 * 필드 3개(셀러·딜·기간)만 받는 완결형 풀스크린 시트 — 캠페인명 입력란은
 * 없다. 이름은 generateCampaignName 으로 실시간 미리보기만 하고, 실제
 * 저장명·차수는 서버(recalculateCampaignRounds)가 확정한다.
 * 딜 검색은 status=CONFIRMED 로 좁힌다(예비 일정은 확정 딜에만 선점).
 */

type SellerOption = {
  id: string;
  name: string;
  alias: string | null;
};

type DealOption = {
  id: string;
  dealName: string;
  brandName?: string | null;
};

type MobileDraftCampaignSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 캘린더 선택일 프리필 (YYYY-MM-DD) — 시작일·종료일 기본값 */
  initialStartYmd: string;
  onCreated: (campaign: DraftCampaignResult) => void;
};

function sellerLabel(seller: SellerOption): string {
  return seller.alias || seller.name;
}

export function MobileDraftCampaignSheet({
  open,
  onOpenChange,
  initialStartYmd,
  onCreated,
}: MobileDraftCampaignSheetProps) {
  const [sellerQuery, setSellerQuery] = useState("");
  const [sellerResults, setSellerResults] = useState<SellerOption[]>([]);
  const [selectedSeller, setSelectedSeller] = useState<SellerOption | null>(null);

  const [dealQuery, setDealQuery] = useState("");
  const [dealResults, setDealResults] = useState<DealOption[]>([]);
  const [selectedDeal, setSelectedDeal] = useState<DealOption | null>(null);

  const [startDate, setStartDate] = useState(initialStartYmd);
  const [endDate, setEndDate] = useState(initialStartYmd);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sellerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dealDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchSellers = useCallback(async (query: string) => {
    try {
      const params = new URLSearchParams({ q: query });
      const res = await fetch(`/api/search/sellers?${params.toString()}`);
      if (!res.ok) throw new Error(`sellers ${res.status}`);
      const data = (await res.json()) as { results?: SellerOption[] };
      setSellerResults(data.results ?? []);
    } catch {
      setSellerResults([]);
    }
  }, []);

  const searchDeals = useCallback(async (query: string) => {
    try {
      // 예비 일정은 확정 딜에만 — status=CONFIRMED (§4)
      const params = new URLSearchParams({ q: query, status: "CONFIRMED" });
      const res = await fetch(`/api/search/deals?${params.toString()}`);
      if (!res.ok) throw new Error(`deals ${res.status}`);
      const data = (await res.json()) as { results?: DealOption[] };
      setDealResults(data.results ?? []);
    } catch {
      setDealResults([]);
    }
  }, []);

  // 시트가 열릴 때마다 초기화: 선택일 프리필 + 최근 목록 즉시 로드(빈 검색어)
  useEffect(() => {
    if (!open) return;
    setSellerQuery("");
    setSelectedSeller(null);
    setDealQuery("");
    setSelectedDeal(null);
    setStartDate(initialStartYmd);
    setEndDate(initialStartYmd);
    setError(null);
    void searchSellers("");
    void searchDeals("");
  }, [open, initialStartYmd, searchSellers, searchDeals]);

  function handleSellerQueryChange(value: string) {
    setSellerQuery(value);
    setSelectedSeller(null);
    if (sellerDebounceRef.current) clearTimeout(sellerDebounceRef.current);
    sellerDebounceRef.current = setTimeout(() => void searchSellers(value), 300);
  }

  function handleDealQueryChange(value: string) {
    setDealQuery(value);
    setSelectedDeal(null);
    if (dealDebounceRef.current) clearTimeout(dealDebounceRef.current);
    dealDebounceRef.current = setTimeout(() => void searchDeals(value), 300);
  }

  function pickSeller(seller: SellerOption) {
    setSelectedSeller(seller);
    setSellerQuery(sellerLabel(seller));
  }

  function pickDeal(deal: DealOption) {
    setSelectedDeal(deal);
    setDealQuery(deal.dealName);
  }

  const namePreview = generateCampaignName(
    selectedDeal?.dealName ?? null,
    selectedSeller ? sellerLabel(selectedSeller) : null,
    null,
  );

  const invalidRange = Boolean(startDate && endDate && endDate < startDate);
  const canSubmit = Boolean(
    selectedSeller && selectedDeal && startDate && endDate && !invalidRange && !submitting,
  );

  async function handleSubmit() {
    if (!selectedSeller || !selectedDeal || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/mobile/campaigns/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId: selectedDeal.id,
          sellerId: selectedSeller.id,
          startDate,
          endDate,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: unknown }
          | null;
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : "예비 일정을 만들지 못했습니다. 다시 시도해주세요.";
        throw new Error(message);
      }
      const draft = (await res.json()) as DraftCampaignResult;
      toast.success(`예비 일정을 만들었습니다: ${draft.campaignName ?? draft.dealName}`);
      onCreated(draft);
      onOpenChange(false);
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : "예비 일정을 만들지 못했습니다. 다시 시도해주세요.";
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        // top-0: side=bottom 기본(inset-x-0 bottom-0)에 상단 고정을 더해 풀스크린으로 확장
        className="mobile-sheet-safe-bottom top-0 gap-0 overflow-y-auto rounded-none border-0 bg-slate-50 p-0"
      >
        <MobileSheetHeader
          title="예비 일정 만들기"
          description="셀러·딜·기간만 정하면 이름과 차수는 자동으로 붙습니다"
          closeLabel="예비 일정 만들기 닫기"
        />

        <div className="flex flex-col gap-2.5 px-3 py-3">
          <MobileSheetCard ariaLabel="예비 일정 입력" className="flex flex-col gap-4 p-3.5">
          {/* ① 셀러 검색 선택 */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="draft-seller-query" className="text-[11px] font-semibold text-muted-foreground">
              셀러
            </label>
            <input
              id="draft-seller-query"
              type="text"
              inputMode="search"
              autoComplete="off"
              placeholder="셀러 이름·별칭 검색"
              value={sellerQuery}
              onChange={(event) => handleSellerQueryChange(event.target.value)}
              className={cn(FIELD_CLASS, selectedSeller ? FIELD_SELECTED : FIELD_IDLE)}
            />
            {selectedSeller ? null : sellerResults.length > 0 ? (
              <ul className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white">
                {sellerResults.map((seller) => (
                  <li key={seller.id} className="border-b border-slate-100 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => pickSeller(seller)}
                      className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
                    >
                      <UserRoundIcon
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {sellerLabel(seller)}
                      </span>
                      {seller.alias ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {seller.name}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {selectedSeller ? (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <CheckIcon aria-hidden="true" className="size-3 text-primary" />
                {sellerLabel(selectedSeller)} 선택됨
              </p>
            ) : null}
          </div>

          {/* ② 딜 검색 선택 (확정 딜만) */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="draft-deal-query" className="text-[11px] font-semibold text-muted-foreground">
              딜 <span className="font-normal text-slate-500">(확정 딜만)</span>
            </label>
            <input
              id="draft-deal-query"
              type="text"
              inputMode="search"
              autoComplete="off"
              placeholder="딜 이름·브랜드 검색"
              value={dealQuery}
              onChange={(event) => handleDealQueryChange(event.target.value)}
              className={cn(FIELD_CLASS, selectedDeal ? FIELD_SELECTED : FIELD_IDLE)}
            />
            {selectedDeal ? null : dealResults.length > 0 ? (
              <ul className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white">
                {dealResults.map((deal) => (
                  <li key={deal.id} className="border-b border-slate-100 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => pickDeal(deal)}
                      className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left"
                    >
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {deal.dealName}
                      </span>
                      {deal.brandName ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {deal.brandName}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {selectedDeal ? (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <CheckIcon aria-hidden="true" className="size-3 text-primary" />
                {selectedDeal.dealName} 선택됨
              </p>
            ) : null}
          </div>

          {/* ③ 기간 — 선택일 프리필, 종료 기본=시작일 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="draft-start-date" className="text-[11px] font-semibold text-muted-foreground">
                시작일
              </label>
              <input
                id="draft-start-date"
                type="date"
                value={startDate}
                onChange={(event) => {
                  const next = event.target.value;
                  setStartDate(next);
                  // 종료일이 새 시작일보다 앞서면 같이 끌어올린다
                  if (endDate && next && endDate < next) setEndDate(next);
                }}
                // 날짜는 항상 프리필돼 있어 값이 빈 적이 없다 — 선택 완료 상태로 고정 표시
                className={cn(FIELD_CLASS, FIELD_SELECTED, "tabular-nums")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="draft-end-date" className="text-[11px] font-semibold text-muted-foreground">
                종료일
              </label>
              <input
                id="draft-end-date"
                type="date"
                min={startDate || undefined}
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className={cn(FIELD_CLASS, FIELD_SELECTED, "tabular-nums")}
              />
            </div>
          </div>
          {invalidRange ? (
            <p className="text-[11px] text-destructive">종료일은 시작일보다 빠를 수 없습니다.</p>
          ) : null}
          </MobileSheetCard>

          {/* 자동 이름 미리보기 — 입력란 아님. 점선 = 아직 서버가 확정하지 않은 값
              (P2 Unconfirmed Link Guard 와 같은 언어). */}
          <div className="rounded-xl border border-dashed border-primary/20 bg-primary/5 px-3 py-2.5">
            <p className="text-[10px] font-medium text-muted-foreground">캠페인명 미리보기</p>
            <p
              className={cn(
                "mt-0.5 truncate text-[13px]",
                // 이름이 만들어지기 전 안내문은 확정된 이름처럼 보이면 안 된다 — 톤으로 구분
                namePreview ? "font-semibold text-primary" : "text-muted-foreground",
              )}
            >
              {namePreview ?? "셀러와 딜을 선택하면 이름이 만들어집니다"}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">(차수는 자동 계산)</p>
          </div>

          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            // 글로우는 Tailwind 컬러 섀도우로 — raw rgba 대신 --primary 토큰을 참조한다.
            // 프레스 딤(계층 ①) — 이 화면의 1급 액션인데 프레스 상태가 아예 없었다
            // (ss-ux 판정, 딤 전환의 사각지대). 네이비 그라디언트 면이라 brightness 가 먹는다.
            className="min-h-12 w-full rounded-xl bg-gradient-to-br from-primary to-[var(--hero-navy)] text-sm font-bold tracking-tight text-primary-foreground shadow-lg shadow-primary/25 transition-[opacity,filter] duration-150 active:brightness-[0.93] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-50 disabled:shadow-none"
          >
            {submitting ? "만드는 중…" : "예비 일정 만들기"}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
