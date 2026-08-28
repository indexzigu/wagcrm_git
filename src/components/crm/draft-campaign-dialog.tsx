"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarPlus, CheckIcon, Loader2, Search, UserRound } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generateCampaignName } from "@/lib/campaign-name";
import type { DraftCampaignResult } from "@/lib/mobile-draft-campaign";

/**
 * 데스크톱 캘린더용 예비 일정(예비 캠페인) 경량 생성 다이얼로그.
 *
 * 모바일 MobileDraftCampaignSheet와 동일 계약(P5: 컴포넌트는 분리, 계약은 공유):
 * 필드 3개(셀러 검색선택 → 확정 딜 검색선택 → 기간[클릭일 프리필])만 받고,
 * 캠페인명 입력란은 없다 — generateCampaignName 실시간 미리보기만 하고 실제
 * 저장명·차수는 서버(recalculateCampaignRounds)가 확정한다.
 * 제출 = POST /api/mobile/campaigns/draft (PROPOSAL 생성·구글 캘린더 sync 포함).
 * 시각 문법은 데스크톱 선례 LinkSearchDialog(검색형 Dialog)를 따른다.
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

type DraftCampaignDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 캘린더에서 클릭한 날짜 프리필 (YYYY-MM-DD) — 시작일·종료일 기본값 */
  initialStartYmd: string;
  onCreated: (campaign: DraftCampaignResult) => void;
};

function sellerLabel(seller: SellerOption): string {
  // P2 Seller Alias Priority — 별칭 우선 표기
  return seller.alias || seller.name;
}

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function formatFullDateKo(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${WEEKDAY_LABELS[d.getDay()]})`;
}

export function DraftCampaignDialog({
  open,
  onOpenChange,
  initialStartYmd,
  onCreated,
}: DraftCampaignDialogProps) {
  const [sellerQuery, setSellerQuery] = useState("");
  const [sellerResults, setSellerResults] = useState<SellerOption[]>([]);
  const [selectedSeller, setSelectedSeller] = useState<SellerOption | null>(null);
  const [sellerFocused, setSellerFocused] = useState(false);

  const [dealQuery, setDealQuery] = useState("");
  const [dealResults, setDealResults] = useState<DealOption[]>([]);
  const [selectedDeal, setSelectedDeal] = useState<DealOption | null>(null);
  const [dealFocused, setDealFocused] = useState(false);

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
      // 예비 일정은 확정 딜에만 — 모바일과 동일 계약(status=CONFIRMED)
      const params = new URLSearchParams({ q: query, status: "CONFIRMED" });
      const res = await fetch(`/api/search/deals?${params.toString()}`);
      if (!res.ok) throw new Error(`deals ${res.status}`);
      const data = (await res.json()) as { results?: DealOption[] };
      setDealResults(data.results ?? []);
    } catch {
      setDealResults([]);
    }
  }, []);

  // 열릴 때마다 초기화: 클릭일 프리필 + 최근 목록 즉시 로드(빈 검색어)
  useEffect(() => {
    if (!open) return;
    setSellerQuery("");
    setSelectedSeller(null);
    setDealQuery("");
    setSelectedDeal(null);
    setStartDate(initialStartYmd);
    setEndDate(initialStartYmd);
    setError(null);
    setSellerFocused(false);
    setDealFocused(false);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>예비 일정 만들기</DialogTitle>
          <DialogDescription>
            셀러·딜·기간만 정하면 이름과 차수는 자동으로 붙습니다.
          </DialogDescription>
        </DialogHeader>

        {/* 클릭일 컨텍스트 — 정적 표기(편집은 아래 기간 필드가 소스) */}
        <div className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary/[0.08] px-2.5 py-1.5 text-xs font-medium text-primary">
          <CalendarPlus className="size-3.5 shrink-0" aria-hidden="true" />
          {formatFullDateKo(initialStartYmd)}에 추가합니다
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
          {/* ① 셀러 검색 선택 */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="desktop-draft-seller">셀러</Label>
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="desktop-draft-seller"
                type="text"
                autoComplete="off"
                placeholder="셀러 이름·별칭 검색"
                value={sellerQuery}
                onChange={(event) => handleSellerQueryChange(event.target.value)}
                onFocus={() => setSellerFocused(true)}
                onBlur={() => setSellerFocused(false)}
                className="pl-7"
              />
              {/* 결과는 떠 있는 오버레이(absolute) — 인라인이면 목록 길이만큼 다이얼로그
                  높이가 요동친다(오너 신고). focus 중 · 미선택 · 결과 있을 때만 아래로 띄운다.
                  onMouseDown preventDefault로 클릭 전 blur를 막아 선택이 소실되지 않게 한다. */}
              {sellerFocused && !selectedSeller && sellerResults.length > 0 ? (
                <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-overlay">
                  <div className="flex flex-col gap-0.5 p-1">
                    {sellerResults.map((seller) => (
                      <button
                        key={seller.id}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pickSeller(seller)}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                      >
                        <UserRound
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate text-sm font-medium text-foreground">
                          {sellerLabel(seller)}
                        </span>
                        {seller.alias ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {seller.name}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            {/* 선택 힌트 — 높이 고정 슬롯(선택 여부와 무관하게 다이얼로그 높이 안정) */}
            <p className="flex min-h-4 items-center gap-1 text-xs text-muted-foreground">
              {selectedSeller ? (
                <>
                  <CheckIcon aria-hidden="true" className="size-3 text-primary" />
                  {sellerLabel(selectedSeller)} 선택됨
                </>
              ) : null}
            </p>
          </div>

          {/* ② 딜 검색 선택 (확정 딜만) */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="desktop-draft-deal">
              딜 <span className="font-normal text-muted-foreground">(확정 딜만)</span>
            </Label>
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="desktop-draft-deal"
                type="text"
                autoComplete="off"
                placeholder="딜 이름·브랜드 검색"
                value={dealQuery}
                onChange={(event) => handleDealQueryChange(event.target.value)}
                onFocus={() => setDealFocused(true)}
                onBlur={() => setDealFocused(false)}
                className="pl-7"
              />
              {dealFocused && !selectedDeal && dealResults.length > 0 ? (
                <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-overlay">
                  <div className="flex flex-col gap-0.5 p-1">
                    {dealResults.map((deal) => (
                      <button
                        key={deal.id}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pickDeal(deal)}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                      >
                        <span className="truncate text-sm font-medium text-foreground">
                          {deal.dealName}
                        </span>
                        {deal.brandName ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {deal.brandName}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <p className="flex min-h-4 items-center gap-1 text-xs text-muted-foreground">
              {selectedDeal ? (
                <>
                  <CheckIcon aria-hidden="true" className="size-3 text-primary" />
                  {selectedDeal.dealName} 선택됨
                </>
              ) : null}
            </p>
          </div>

          {/* ③ 기간 — 클릭일 프리필, 종료 기본=시작일 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="desktop-draft-start">시작일</Label>
              <Input
                id="desktop-draft-start"
                type="date"
                value={startDate}
                onChange={(event) => {
                  const next = event.target.value;
                  setStartDate(next);
                  // 종료일이 새 시작일보다 앞서면 같이 끌어올린다
                  if (endDate && next && endDate < next) setEndDate(next);
                }}
                className="tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="desktop-draft-end">종료일</Label>
              <Input
                id="desktop-draft-end"
                type="date"
                min={startDate || undefined}
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="tabular-nums"
              />
            </div>
          </div>
          {invalidRange ? (
            <p className="text-xs text-destructive">
              종료일은 시작일보다 빠를 수 없습니다.
            </p>
          ) : null}

          {/* 자동 이름 미리보기 — 입력란 아님 */}
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">캠페인명 자동(차수 포함)</p>
            <p className="truncate text-sm font-medium text-foreground">
              {namePreview ?? "셀러와 딜을 선택하면 이름이 만들어집니다"}
            </p>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="gap-1.5 bg-primary text-white hover:bg-primary/90"
          >
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                만드는 중…
              </>
            ) : (
              "예비 일정 만들기"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
