"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
  salesChannelLabels,
  type CampaignRow,
  type DealSummary,
  type SalesChannel,
  type SellerSummary,
} from "@/lib/crm-types";

type BulkCampaignDialogProps = {
  deals: DealSummary[];
  sellers: SellerSummary[];
  onCreated: (campaigns: CampaignRow[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type BulkResult = {
  created: CampaignRow[];
  failed: { sellerId: string; error: string }[];
};

function today(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function BulkCampaignDialog({
  deals,
  sellers,
  onCreated,
  open,
  onOpenChange,
}: BulkCampaignDialogProps) {
  const [dealId, setDealId] = useState("");
  const [selectedSellerIds, setSelectedSellerIds] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today(30));
  const [salesChannel, setSalesChannel] = useState<SalesChannel>("UNSPECIFIED");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggleSeller(sellerId: string) {
    setSelectedSellerIds((prev) => {
      const next = new Set(prev);
      if (next.has(sellerId)) {
        next.delete(sellerId);
      } else {
        next.add(sellerId);
      }
      return next;
    });
  }

  function toggleAll() {
    if (selectedSellerIds.size === sellers.length) {
      setSelectedSellerIds(new Set());
    } else {
      setSelectedSellerIds(new Set(sellers.map((s) => s.id)));
    }
  }

  function resetForm() {
    setDealId("");
    setSelectedSellerIds(new Set());
    setStartDate(today());
    setEndDate(today(30));
    setSalesChannel("UNSPECIFIED");
    setResult(null);
    setError(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      resetForm();
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit() {
    if (!dealId || selectedSellerIds.size === 0) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/campaigns/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId,
          sellerIds: Array.from(selectedSellerIds),
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          salesChannel: salesChannel || undefined,
        }),
      });

      const payload = await response.json();

      if (!response.ok && response.status !== 207) {
        setError(payload.error?.formErrors?.[0] || "벌크 캠페인 생성에 실패했습니다.");
        return;
      }

      const bulkResult: BulkResult = {
        created: payload.created ?? [],
        failed: payload.failed ?? [],
      };

      setResult(bulkResult);

      if (bulkResult.created.length > 0) {
        onCreated(bulkResult.created);
      }
    } catch {
      setError("네트워크 오류가 발생했습니다. 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = Boolean(dealId && selectedSellerIds.size > 0 && !loading);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>벌크 캠페인 생성</DialogTitle>
          <DialogDescription>
            딜을 선택하고 여러 셀러를 지정하여 한 번에 캠페인을 생성합니다.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <BulkResultView result={result} onClose={() => handleOpenChange(false)} />
        ) : (
          <>
            <FieldGroup>
              <Field>
                <FieldLabel>딜 선택</FieldLabel>
                <Select value={dealId} onValueChange={setDealId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="딜을 선택하세요" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {deals.map((deal) => (
                        <SelectItem key={deal.id} value={deal.id}>
                          {deal.dealName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel className="items-center">
                    셀러 선택
                    <Badge variant="secondary">{selectedSellerIds.size}명</Badge>
                  </FieldLabel>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={toggleAll}
                  >
                    {selectedSellerIds.size === sellers.length ? "전체 해제" : "전체 선택"}
                  </Button>
                </div>
                <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
                  {sellers.length === 0 ? (
                    <FieldDescription className="py-2 text-center text-xs">
                      등록된 셀러가 없습니다.
                    </FieldDescription>
                  ) : (
                    sellers.map((seller) => (
                      <label
                        key={seller.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          checked={selectedSellerIds.has(seller.id)}
                          onChange={() => toggleSeller(seller.id)}
                          className="size-4 rounded border-input accent-primary"
                        />
                        <span className="flex-1 truncate">{seller.name}</span>
                        <span className="text-xs text-muted-foreground">
                          @{seller.snsHandle}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </Field>

              <div className="grid gap-3 md:grid-cols-2">
                <Field>
                  <FieldLabel>시작일 (선택)</FieldLabel>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>마감일 (선택)</FieldLabel>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel>판매 채널 (선택)</FieldLabel>
                <Select
                  value={salesChannel}
                  onValueChange={(v) => setSalesChannel(v as SalesChannel)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="기본값 사용" />
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

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </FieldGroup>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                취소
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {loading ? "생성 중..." : `${selectedSellerIds.size}개 캠페인 생성`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BulkResultView({
  result,
  onClose,
}: {
  result: BulkResult;
  onClose: () => void;
}) {
  const total = result.created.length + result.failed.length;

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertTitle>생성 완료</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{result.created.length}/{total}건</Badge>
          <span>캠페인 생성 결과입니다.</span>
        </AlertDescription>
        {result.failed.length > 0 && (
          <AlertDescription>
            실패 {result.failed.length}건은 아래 목록에서 확인하세요.
          </AlertDescription>
        )}
      </Alert>

      {result.failed.length > 0 && (
        <Field>
          <FieldLabel className="text-destructive">실패 목록</FieldLabel>
          <div className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-destructive/20 p-2">
            {result.failed.map((f, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                셀러 ID: {f.sellerId} - {f.error}
              </p>
            ))}
          </div>
        </Field>
      )}

      <DialogFooter>
        <Button onClick={onClose}>닫기</Button>
      </DialogFooter>
    </div>
  );
}
