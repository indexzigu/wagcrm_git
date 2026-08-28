"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Eraser, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 구글 캘린더 고아 이벤트 정리 — 2단계(목록 확인 → 삭제) UI.
 *
 * 왜 2단계인가: CRM 은 `primary`(개인 기본 캘린더)에 쓴다. "DB 장부에 없으면 삭제"를
 * 확인 없이 돌리면 CRM 이 만들지 않은 일정까지 지운다. 서버가 종일·비반복만 후보로
 * 좁히지만(1차 방어), **사람이 목록을 보고 그 id 를 되보내는 것**이 최종 방어선이다.
 */

type OrphanEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  /** 발견된 캘린더 — primary 또는 회계·정산 캘린더 ID. 삭제 시 되보낸다. */
  calendarId?: string;
};

type ScanResponse = {
  range: { from: string; to: string };
  scanned: number;
  referenced: number;
  orphanCount: number;
  orphans: OrphanEvent[];
};

export function CalendarOrphanCleanupDialog() {
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  // 기본 전체 선택 — 다만 개별 해제가 가능해야 "이건 남기고 싶다"를 표현할 수 있다.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function handleScan() {
    setScanning(true);
    setScan(null);
    try {
      const res = await fetch("/api/integrations/google-calendar/reconcile");
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "조회에 실패했습니다.");
        return;
      }
      setScan(data as ScanResponse);
      setSelected(new Set((data as ScanResponse).orphans.map((o) => o.id)));
      setOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "조회에 실패했습니다.");
    } finally {
      setScanning(false);
    }
  }

  async function handleDelete() {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/integrations/google-calendar/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // labels 동반 — 지우고 나면 구글에서 제목·기간을 확인할 수 없으므로
        // 감사 기록이 id 만 갖지 않게 화면이 알고 있는 라벨을 함께 보낸다.
        body: JSON.stringify({
          eventIds: [...selected],
          // 이벤트가 두 캘린더(primary·회계)에 나뉘어 살므로, 어느 캘린더에서
          // 지울지를 GET 이 알려준 대로 되보낸다(누락 시 서버가 primary 로 해석).
          calendarIds: Object.fromEntries(
            (scan?.orphans ?? [])
              .filter((o) => selected.has(o.id) && o.calendarId)
              .map((o) => [o.id, o.calendarId as string]),
          ),
          labels: (scan?.orphans ?? [])
            .filter((o) => selected.has(o.id))
            .map((o) => ({ id: o.id, label: `${o.summary} (${o.start}~${o.end})` })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "삭제에 실패했습니다.");
        return;
      }
      toast.success(data.message ?? "정리했습니다.");
      setOpen(false);
      setScan(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "삭제에 실패했습니다.");
    } finally {
      setDeleting(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={handleScan}
        disabled={scanning}
        className="h-8 gap-1 rounded-lg border-slate-200 px-3 text-xs hover:bg-slate-50"
      >
        {scanning ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <Eraser className="size-3 shrink-0" />
        )}
        {scanning ? "확인 중..." : "잔재 일정 정리"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>연결이 끊긴 캘린더 일정</DialogTitle>
            <DialogDescription>
              CRM 이 더는 추적하지 않는 종일 일정입니다. 재동기화로는 지워지지 않아 여기서
              정리합니다. 지울 항목만 남기고 체크를 해제하세요.
            </DialogDescription>
          </DialogHeader>

          {scan && (
            <>
              <p className="text-[11px] text-muted-foreground">
                {scan.range.from} ~ {scan.range.to} · 종일 일정 {scan.scanned}건 중 동기화 중{" "}
                {scan.referenced}건 · 연결 끊김 {scan.orphanCount}건
              </p>

              {scan.orphanCount === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  정리할 일정이 없습니다.
                </p>
              ) : (
                <div className="max-h-[320px] overflow-y-auto rounded-lg border border-border/70 [scrollbar-gutter:stable]">
                  {scan.orphans.map((o) => (
                    <label
                      key={o.id}
                      className="flex cursor-pointer items-center gap-2.5 border-b border-border/50 px-3 py-2 last:border-b-0 hover:bg-muted/40"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(o.id)}
                        onChange={() => toggle(o.id)}
                        className="size-3.5 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                        {o.summary}
                      </span>
                      {/* 캘린더 구분은 범주라 색을 받지 않는다(P8 §4) — 회계 캘린더의
                          항목만 중립 라벨로 표시(primary 는 무표기 기본). */}
                      {o.calendarId && o.calendarId !== "primary" && (
                        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          회계
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                        {o.start}
                        {o.end && o.end !== o.start ? ` ~ ${o.end}` : ""}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} className="text-xs">
              닫기
            </Button>
            {/* 삭제색은 Button 의 destructive variant 가 정본이다 — status-urgent-text 를
                bg 로 쓰지 않는다(그 토큰은 urgent 틴트 **위 텍스트** 대비용, P8). */}
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting || selected.size === 0}
              className="gap-1.5 text-xs"
            >
              {deleting && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
              {selected.size}건 삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
