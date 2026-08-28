"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  stripPreviousSlot,
  type NaverOrderField,
  type OrderExcelRules,
  type OrderExcelRulesCore,
} from "@/lib/order-converter/excel-rules";
import { ColumnMappingTable, type MappingRowMeta } from "./column-mapping-table";
import { LivePreviewPanel } from "./live-preview-panel";
import { WarningsBanner } from "./warnings-banner";
import { isIncompleteSource, toConfirmedSource, type EditableColumnRule } from "./types";

type AnalyzeColumnMeta = {
  col: number;
  header: string;
  suggestedField: NaverOrderField | null;
  source: "heuristic" | "llm" | null;
  confidence: number;
};

type AnalyzeResponse = {
  asset: { id: string; fileName: string };
  columns: AnalyzeColumnMeta[];
  draftRules: OrderExcelRulesCore;
  warnings: string[];
  error?: string;
};

type Phase = "loading" | "error" | "ready";

/**
 * 발주서 열 매핑 검수 다이얼로그 (F4 Phase 2 §4단계).
 * - 확정 규칙이 있으면 그 규칙을 편집 상태로 로드(LLM 재호출 없음), 없으면 열림과 동시에 분석.
 * - 드래프트는 DB에 저장하지 않는다(설계 D2) — '매핑 확정'에서만 서버로 전송.
 * - 미리보기는 서버 생성기와 동일한 순수 함수로 계산되는 실질 드라이런.
 */
export function OrderTemplateReviewDialog({
  open,
  onOpenChange,
  partnerId,
  partnerName,
  activeRules,
  onRulesSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partnerId: string;
  partnerName: string;
  activeRules: OrderExcelRules | null;
  onRulesSaved: (rules: unknown) => void;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState<string>("");
  const [baseRules, setBaseRules] = useState<OrderExcelRulesCore | null>(null);
  const [rows, setRows] = useState<EditableColumnRule[]>([]);
  const [metaByCol, setMetaByCol] = useState<Map<number, MappingRowMeta>>(new Map());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmAlertOpen, setConfirmAlertOpen] = useState(false);
  const [reanalyzeAlertOpen, setReanalyzeAlertOpen] = useState(false);
  const analyzeSeq = useRef(0);

  const loadFromRules = useCallback((rules: OrderExcelRules | OrderExcelRulesCore) => {
    const core = stripPreviousSlot(rules);
    setBaseRules(core);
    setRows(core.columns.map((c) => ({ col: c.col, header: c.header, source: c.source })));
    setMetaByCol(new Map());
    setWarnings([]);
    setDirty(false);
    setPhase("ready");
    setError("");
  }, []);

  const runAnalyze = useCallback(async () => {
    const seq = ++analyzeSeq.current;
    setPhase("loading");
    setError("");
    try {
      const res = await fetch(`/api/partners/${partnerId}/order-rules/analyze`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as AnalyzeResponse | null;
      if (seq !== analyzeSeq.current) return; // 닫힘/재실행으로 무효화된 응답
      if (!res.ok || !data) {
        setPhase("error");
        setError(data?.error ?? "발주서 양식 분석에 실패했습니다.");
        return;
      }
      setBaseRules(data.draftRules);
      setRows(data.draftRules.columns.map((c) => ({ col: c.col, header: c.header, source: c.source })));
      setMetaByCol(
        new Map(
          data.columns.map((c) => [
            c.col,
            { suggestedField: c.suggestedField, source: c.source, confidence: c.confidence },
          ])
        )
      );
      setWarnings(data.warnings);
      setDirty(false);
      setPhase("ready");
    } catch (err: any) {
      if (seq !== analyzeSeq.current) return;
      setPhase("error");
      setError(err?.message ?? "발주서 양식 분석에 실패했습니다.");
    }
  }, [partnerId]);

  // 열릴 때 초기화: 확정 규칙이 있으면 그것부터(LLM 비용 없이 재검수), 없으면 분석 실행
  useEffect(() => {
    if (!open) return;
    if (activeRules) {
      loadFromRules(activeRules);
    } else {
      void runAnalyze();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleChangeSource = useCallback((col: number, next: EditableColumnRule["source"]) => {
    setRows((prev) => prev.map((row) => (row.col === col ? { ...row, source: next } : row)));
    setDirty(true);
  }, []);

  const duplicatedFields = useMemo(() => {
    const counts = new Map<NaverOrderField, number>();
    rows.forEach((row) => {
      if (row.source.type === "field" && row.source.field) {
        counts.set(row.source.field, (counts.get(row.source.field) ?? 0) + 1);
      }
    });
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([field]) => field));
  }, [rows]);

  const incompleteCount = useMemo(() => rows.filter((row) => isIncompleteSource(row.source)).length, [rows]);
  const unmappedCount = useMemo(() => rows.filter((row) => row.source.type === "empty").length, [rows]);

  const buildConfirmRules = useCallback((): OrderExcelRulesCore | null => {
    if (!baseRules) return null;
    const columns = [] as OrderExcelRulesCore["columns"];
    for (const row of rows) {
      const source = toConfirmedSource(row.source);
      if (!source) return null;
      columns.push({ col: row.col, header: row.header, source });
    }
    return { ...baseRules, columns };
  }, [baseRules, rows]);

  const handleConfirm = useCallback(async () => {
    const rules = buildConfirmRules();
    if (!rules) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/partners/${partnerId}/order-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "매핑 확정에 실패했습니다.");
      }
      onRulesSaved(data.orderExcelRules);
      toast.success("발주서 매핑을 확정했습니다.");
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message ?? "매핑 확정에 실패했습니다.");
    } finally {
      setSaving(false);
      setConfirmAlertOpen(false);
    }
  }, [buildConfirmRules, onOpenChange, onRulesSaved, partnerId]);

  const handleRestorePrevious = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/partners/${partnerId}/order-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restorePrevious: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "되돌리기에 실패했습니다.");
      }
      onRulesSaved(data.orderExcelRules);
      toast.success("이전 매핑 규칙으로 되돌렸습니다.");
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message ?? "되돌리기에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }, [onOpenChange, onRulesSaved, partnerId]);

  const handleOpenChange = (next: boolean) => {
    if (saving) return; // 저장 중 닫힘 방지
    if (!next) analyzeSeq.current++; // 진행 중 분석 응답 무효화
    onOpenChange(next);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex h-[90vh] max-h-[900px] w-[96vw] !max-w-[1200px] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border/70 px-6 py-4">
            <DialogTitle className="flex items-center gap-2 text-base">
              발주서 열 매핑 검수
              <span className="text-sm font-normal text-muted-foreground">· {partnerName}</span>
            </DialogTitle>
            <DialogDescription>
              네이버 주문 필드를 발주서의 각 열에 어떻게 채울지 확인하고 수정한 뒤 확정하세요.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {phase === "loading" && (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                <Loader2 aria-hidden className="size-6 animate-spin" />
                <p className="text-sm">발주서 양식을 분석하고 있습니다 (AI 매핑 추천, 최대 1분 소요)</p>
              </div>
            )}

            {phase === "error" && (
              <div className="flex flex-1 items-center justify-center px-6">
                <div className="w-full max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm font-medium text-foreground">분석에 실패했습니다</p>
                  <p className="mt-1 text-xs leading-normal text-muted-foreground">{error}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => void runAnalyze()}>
                    다시 분석
                  </Button>
                </div>
              </div>
            )}

            {phase === "ready" && (
              <>
                <WarningsBanner warnings={warnings} />
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <div className="min-w-0 flex-[65] overflow-y-auto border-r border-border/70 px-6 py-4">
                    <ColumnMappingTable
                      rows={rows}
                      metaByCol={metaByCol}
                      duplicatedFields={duplicatedFields}
                      sellerName={partnerName}
                      onChangeSource={handleChangeSource}
                    />
                  </div>
                  <div className="min-w-0 flex-[35] overflow-y-auto bg-muted/20 px-4 py-4">
                    <LivePreviewPanel rows={rows} sellerName={partnerName} />
                  </div>
                </div>
              </>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t border-border/70 px-6 py-4">
            {activeRules?.previous && (
              <Button
                variant="ghost"
                size="sm"
                className="mr-auto"
                onClick={() => void handleRestorePrevious()}
                disabled={saving}
              >
                이전 규칙으로 되돌리기
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => (dirty ? setReanalyzeAlertOpen(true) : void runAnalyze())}
              disabled={phase === "loading" || saving}
            >
              재분석
            </Button>
            <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} disabled={saving}>
              취소
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmAlertOpen(true)}
              disabled={phase !== "ready" || saving || incompleteCount > 0}
            >
              {saving ? "확정하는 중..." : "매핑 확정"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmAlertOpen} onOpenChange={setConfirmAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>발주서 매핑을 확정할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              확정하면 이 거래처로 발송되는 모든 발주서가 이 매핑을 따릅니다.
              {activeRules ? " 기존 매핑 규칙은 대체됩니다(이전 규칙으로 되돌리기 가능)." : ""}
              {unmappedCount > 0 ? ` 미매핑(비움) 열 ${unmappedCount}개는 빈 칸으로 발주서에 기입됩니다.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirm()} disabled={saving}>
              확정
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={reanalyzeAlertOpen} onOpenChange={setReanalyzeAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>다시 분석할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              재분석하면 지금까지 수정한 매핑이 추천값으로 덮어써집니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setReanalyzeAlertOpen(false);
                void runAnalyze();
              }}
            >
              재분석
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
