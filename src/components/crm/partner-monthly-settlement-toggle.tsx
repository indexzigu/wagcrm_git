"use client";

/**
 * 거래처 「월정산」 스위치(T-240). 켜면 이 거래처 캠페인의 공급사 계산서 칸이 달별 계산서 여러 장으로
 * 바뀐다(캠페인은 1단위 그대로). 플래그만 바꾸고 데이터를 만들거나 옮기지 않는다 — 이미 계산서 날짜가
 * 있는 캠페인은 그 날짜 칸을 그대로 보인다. 끄면 단일 날짜 칸으로 돌아가고 기록한 계산서는 보관된다.
 */
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Switch } from "@/components/ui/switch";
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

type Pending = { enabled: boolean } | null;

export function PartnerMonthlySettlementToggle({
  partnerId,
  enabled,
  onChanged,
}: {
  partnerId: string;
  enabled: boolean;
  onChanged: (enabled: boolean) => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/partners/${partnerId}/monthly-settlement`;

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: pending.enabled }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : "월정산 설정을 바꾸지 못했습니다.");
      }
      onChanged(pending.enabled);
      toast.success(pending.enabled ? "월정산을 켰습니다." : "월정산을 껐습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "월정산 설정을 바꾸지 못했습니다.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  };


  return (
    <div className="space-y-1 rounded-lg border border-border/70 bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-foreground">월정산</h3>
        <Switch
          checked={enabled}
          disabled={busy}
          aria-label="월정산"
          onCheckedChange={(next) => setPending({ enabled: next })}
        />
      </div>
      <p className="text-xs leading-normal text-muted-foreground">
        켜면 공급사 계산서를 달별로 기록합니다. 정산 완료는 기간에 걸친 달의 계산서가 모두 기록돼야 가능합니다.
      </p>

      <AlertDialog open={pending != null} onOpenChange={(open) => !open && !busy && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.enabled ? "이 거래처를 월정산으로 바꿀까요?" : "월정산을 끌까요?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.enabled
                ? "이 거래처 캠페인의 공급사 계산서 칸이 달별 줄로 바뀝니다. 캠페인은 나뉘지 않습니다. 이미 계산서 날짜가 있는 캠페인은 그 날짜를 그대로 보입니다."
                : "달별 계산서 칸이 숨고 하나의 날짜 칸으로 돌아갑니다. 기록한 계산서는 지우지 않고 보관합니다."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>취소</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              {pending?.enabled ? "월정산으로 바꾸기" : "월정산 끄기"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
