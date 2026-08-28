"use client";

import { useMemo, useState, useCallback } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  parseBulkSellerLines,
  BULK_SELLER_MAX,
  type ParsedBulkEntry,
} from "@/lib/bulk-seller-parse";
import { snsTypeLabels } from "@/lib/crm-types";

type BulkResult = {
  created: Array<Record<string, unknown>>;
  duplicates: Array<{ raw: string; snsType?: string; snsHandle?: string; reason: string }>;
  invalid: Array<{ raw: string; reason: string }>;
  summary: { total: number; created: number; duplicates: number; invalid: number };
};

export type SellerBulkCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 서버가 반환한 created[] 원본 행 (목록 낙관적 반영용). */
  onBulkCreated: (created: Array<Record<string, unknown>>) => void;
  /** 백그라운드 보강분 반영을 위한 목록 재조회. */
  onRefetch?: () => void;
};

const STATUS_STYLE: Record<ParsedBulkEntry["status"], string> = {
  ok: "text-emerald-600",
  duplicate: "text-amber-600",
  invalid: "text-rose-600",
};

const STATUS_LABEL: Record<ParsedBulkEntry["status"], string> = {
  ok: "등록",
  duplicate: "중복",
  invalid: "무효",
};

export function SellerBulkCreateDialog({
  open,
  onOpenChange,
  onBulkCreated,
  onRefetch,
}: SellerBulkCreateDialogProps) {
  const [text, setText] = useState("");
  const [isMonitored, setIsMonitored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);

  const preview = useMemo(() => parseBulkSellerLines(text), [text]);
  const previewCounts = useMemo(() => {
    let ok = 0;
    let dup = 0;
    let invalid = 0;
    for (const e of preview) {
      if (e.status === "ok") ok += 1;
      else if (e.status === "duplicate") dup += 1;
      else invalid += 1;
    }
    return { ok, dup, invalid };
  }, [preview]);

  const overCap = previewCounts.ok > BULK_SELLER_MAX;

  const resetAndClose = useCallback(() => {
    // 성공 배치가 있었으면 보강분 반영을 위해 재조회.
    if (result && result.summary.created > 0) onRefetch?.();
    setText("");
    setIsMonitored(false);
    setResult(null);
    setSubmitting(false);
    onOpenChange(false);
  }, [result, onRefetch, onOpenChange]);

  const handleSubmit = useCallback(async () => {
    if (previewCounts.ok === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/sellers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, isMonitored }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(
          (err?.error && typeof err.error === "string" && err.error) ||
            "대량 등록에 실패했습니다."
        );
      }
      const data = (await res.json()) as BulkResult;
      setResult(data);
      onBulkCreated(data.created);

      // 생성된 각 셀러에 대해 백그라운드 지표 보강 스크래핑 트리거 (단건 등록과 동일 패턴).
      for (const c of data.created) {
        const id = c.id as string | undefined;
        const channelUrl = c.channelUrl as string | undefined;
        if (id && channelUrl) {
          void fetch(
            `/api/sellers/${id}/channel-info?force=true&url=${encodeURIComponent(channelUrl)}`
          ).catch((e) => console.error("발굴 대량 등록 백그라운드 스크래핑 트리거 실패:", e));
        }
      }

      const { summary } = data;
      toast.success(
        `발굴 셀러 ${summary.created}건 등록` +
          (summary.duplicates ? ` · 중복 ${summary.duplicates}건` : "") +
          (summary.invalid ? ` · 무효 ${summary.invalid}건` : "")
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "대량 등록에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }, [text, isMonitored, previewCounts.ok, onBulkCreated]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAndClose();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>발굴 셀러 대량 등록</DialogTitle>
          <DialogDescription>
            인스타그램·유튜브·X의 URL 또는 @핸들을 줄바꿈/공백/쉼표로 구분해 붙여넣으세요.
            핸들만 입력하면 인스타그램으로 인식합니다. 팔로워·프로필은 등록 후 자동 보강됩니다.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          // ---- 결과 뷰 ----
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-3 text-sm">
              <ResultBadge label="등록" value={result.summary.created} tone="ok" />
              <ResultBadge label="중복 건너뜀" value={result.summary.duplicates} tone="dup" />
              <ResultBadge label="무효" value={result.summary.invalid} tone="invalid" />
            </div>
            {result.summary.created > 0 && (
              <p className="text-xs text-muted-foreground">
                등록된 셀러의 팔로워·프로필 정보는 백그라운드에서 수집 중입니다. 잠시 후 목록에 반영됩니다.
              </p>
            )}
            {(result.duplicates.length > 0 || result.invalid.length > 0) && (
              <div className="max-h-52 overflow-y-auto rounded-lg border border-border/70 bg-muted/30 p-3 text-xs">
                {result.duplicates.map((d, i) => (
                  <div key={`d-${i}`} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="truncate font-mono text-slate-600">{d.raw}</span>
                    <span className="shrink-0 text-amber-600">{d.reason}</span>
                  </div>
                ))}
                {result.invalid.map((v, i) => (
                  <div key={`v-${i}`} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="truncate font-mono text-slate-600">{v.raw}</span>
                    <span className="shrink-0 text-rose-600">{v.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          // ---- 입력 뷰 ----
          <div className="flex flex-col gap-3">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                "https://instagram.com/handle_one\n@handle_two\nyoutube.com/@channel"
              }
              rows={7}
              className="font-mono text-xs"
            />

            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="text-emerald-600">등록 대상 {previewCounts.ok}</span>
                {previewCounts.dup > 0 && (
                  <span className="text-amber-600">중복 {previewCounts.dup}</span>
                )}
                {previewCounts.invalid > 0 && (
                  <span className="text-rose-600">무효 {previewCounts.invalid}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="bulk-monitored" className="text-xs text-muted-foreground">
                  수집 관리 대상 등록
                </Label>
                <Switch
                  id="bulk-monitored"
                  checked={isMonitored}
                  onCheckedChange={setIsMonitored}
                />
              </div>
            </div>

            {overCap && (
              <p className="text-xs text-rose-600">
                1회 최대 {BULK_SELLER_MAX}건까지 등록됩니다. 초과분은 건너뜁니다.
              </p>
            )}

            {preview.length > 0 && (
              <div className="max-h-44 overflow-y-auto rounded-lg border border-border/70 bg-muted/30 p-2 text-xs">
                {preview.map((e, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`w-8 shrink-0 font-semibold ${STATUS_STYLE[e.status]}`}>
                        {STATUS_LABEL[e.status]}
                      </span>
                      <span className="truncate font-mono text-slate-600">
                        {e.status === "ok" || e.status === "duplicate"
                          ? `${snsTypeLabels[e.snsType!]} · @${e.snsHandle}`
                          : e.raw}
                      </span>
                    </span>
                    {e.reason && (
                      <span className="shrink-0 text-muted-foreground">{e.reason}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button size="sm" onClick={resetAndClose}>
              닫기
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={resetAndClose} disabled={submitting}>
                취소
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSubmit()}
                disabled={submitting || previewCounts.ok === 0}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    등록 중...
                  </>
                ) : (
                  `${Math.min(previewCounts.ok, BULK_SELLER_MAX)}건 등록`
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultBadge({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "dup" | "invalid";
}) {
  const toneClass =
    tone === "ok"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : tone === "dup"
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-rose-50 text-rose-700 border-rose-200";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-medium ${toneClass}`}>
      {label}
      <span className="font-bold">{value}</span>
    </span>
  );
}
