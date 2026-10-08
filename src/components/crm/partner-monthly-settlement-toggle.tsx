"use client";

/**
 * 거래처 「월정산」 스위치(T-240). 켜는 순간 그 거래처의 기존 캠페인(드랍 제외, 줄 없는 것)에 월별
 * 정산 줄 1개씩이 만들어진다 — 기존 데이터 이전의 **유일한 실행 지점**이라(배포 시 자동 이전 없음,
 * 명세 「사람 검수 없는 자동 실행 금지」) 확인 창에 서버가 센 건수를 먼저 보여준다.
 * 끄면 줄은 지우지 않고 보관한다(비파괴) — 패널이 숨고 완료 조건·물품대금 합계가 멈춘다.
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

type Pending = { enabled: boolean; backfillTargetCount: number | null } | null;

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

  const requestChange = async (next: boolean) => {
    if (!next) {
      setPending({ enabled: false, backfillTargetCount: null });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("이전 대상 건수를 확인하지 못했습니다.");
      const body = (await response.json()) as { backfillTargetCount: number };
      setPending({ enabled: true, backfillTargetCount: body.backfillTargetCount });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "이전 대상 건수를 확인하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: pending.enabled }),
      });
      const body = (await response.json().catch(() => null)) as { createdLines?: number; error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : "월정산 설정을 바꾸지 못했습니다.");
      }
      onChanged(pending.enabled);
      toast.success(
        pending.enabled
          ? `월정산을 켰습니다. 줄 ${body?.createdLines ?? 0}개를 만들었습니다.`
          : "월정산을 껐습니다. 월별 줄은 보관됩니다.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "월정산 설정을 바꾸지 못했습니다.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const count = pending?.backfillTargetCount ?? 0;

  return (
    <div className="space-y-1 rounded-lg border border-border/70 bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-foreground">월정산</h3>
        <Switch
          checked={enabled}
          disabled={busy}
          aria-label="월정산"
          onCheckedChange={(next) => void requestChange(next)}
        />
      </div>
      <p className="text-xs leading-normal text-muted-foreground">
        켜면 이 거래처 캠페인은 귀속 월마다 계산서와 지급을 줄로 기록합니다. 정산 완료는 줄마다 체크 4칸이 모두
        켜져야 가능합니다.
      </p>

      <AlertDialog open={pending != null} onOpenChange={(open) => !open && !busy && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.enabled ? "이 거래처를 월정산으로 바꿀까요?" : "월정산을 끌까요?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.enabled
                ? count > 0
                  ? `기존 캠페인 ${count}건에 월별 줄 1개씩 만듭니다. 현재 입력된 거래액, 수수료, 계산서, 지급 값이 그 줄로 복사되고 캠페인 값은 바뀌지 않습니다. 드랍된 캠페인과 이미 줄이 있는 캠페인은 제외합니다. 이미 완료된 캠페인의 상태도 바뀌지 않습니다.`
                  : "기존 캠페인이 없어 만들 줄이 없습니다. 앞으로 만드는 캠페인부터 적용됩니다."
                : "월별 줄은 지우지 않고 보관합니다. 월별 정산 패널이 숨고, 정산 완료 조건과 물품대금 자동 합계가 멈춥니다. 물품대금은 재무 카드에서 다시 직접 입력합니다."}
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
