"use client";

/**
 * 세무 자료 도우미(세금계산서·원천징수) 공통 필드 행 — 라벨 + 값 + 행별 복사.
 *
 * 두 도우미(`tax-invoice-helper-dialog.tsx`·`withholding-helper-dialog.tsx`)가 각자
 * 이 행을 복제해 갖고 있다가 보조 문구 폰트 크기가 갈리는 드리프트가 실제로
 * 났다(design review 2026-08-05 — `text-[11px]` vs `text-xs`). 이 기능은 이미 여러
 * 차례 정정됐고 전부 "같은 사실이 두 곳에 살다가 갈렸다" 패턴이었다(원천징수
 * 세액 분리 공식이 `splitWithholdingTax`로 합쳐진 것과 동일한 사고). 행 하나를 공유
 * 컴포넌트로 빼서 다음 도우미가 또 갈라지는 것을 막는다 — 새 도우미를 만들 때도
 * 이 컴포넌트를 다시 복제하지 말 것.
 *
 * 값이 없으면 빈칸이 아니라 「미입력」으로 표시하고 복사를 막는다 — 빈칸은 "안
 * 채워도 된다"로 오인되어 신고가 누락된 채 접수되고, 홈택스는 그 상태로 반려한다.
 *
 * 빈 값의 낱말은 붙여 쓴 상태 명사다(상태 표시 기준 ①, 오너 확정 2026-10-08 — 지시문 「입력 필요」
 * 폐기). 오너가 직접 넣는 값이 비면 「미입력」(urgent), 정산·계산이 정하는 금액이 아직이면 호출부가
 * `emptyLabel="금액미확정"`·`emptyTone="caution"` 을 넘긴다 — 오너가 칸을 채워서 풀리는 일이 아니다.
 */
import { Copy } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { StatusDot, type StatusTone } from "@/components/crm/status-dot";

export function FieldRow({
  label,
  value,
  wrap = false,
  emptyLabel = "미입력",
  emptyTone = "urgent",
}: {
  label: string;
  value: string | null | undefined;
  /** 사업장주소처럼 오너가 화면에서 직접 대조·확인해야 하는 값은 잘리면 확인 자체가
   *  안 되므로 줄바꿈으로 전체를 보여준다(기본은 한 줄 말줄임 유지). */
  wrap?: boolean;
  /** 값이 없을 때의 상태 낱말(기본 「미입력」). 계산 금액이 아직이면 「금액미확정」. */
  emptyLabel?: string;
  emptyTone?: Extract<StatusTone, "urgent" | "caution">;
}) {
  const hasValue = value != null && value !== "";

  const handleCopy = async () => {
    if (!hasValue) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success("복사되었습니다");
    } catch {
      toast.error("복사에 실패했습니다");
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        {hasValue ? (
          <div className={`text-sm font-medium text-slate-800 ${wrap ? "break-words" : "truncate"}`}>
            {value}
          </div>
        ) : (
          <StatusDot tone={emptyTone} label={emptyLabel} className="flex text-sm font-semibold" />
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="복사"
        disabled={!hasValue}
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-40"
        onClick={() => void handleCopy()}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}
