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
 * 값이 없으면 빈칸이 아니라 「입력 필요」로 표시하고 복사를 막는다 — 빈칸은 "안
 * 채워도 된다"로 오인되어 신고가 누락된 채 접수되고, 홈택스는 그 상태로 반려한다.
 */
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function FieldRow({
  label,
  value,
  wrap = false,
}: {
  label: string;
  value: string | null | undefined;
  /** 사업장주소처럼 오너가 화면에서 직접 대조·확인해야 하는 값은 잘리면 확인 자체가
   *  안 되므로 줄바꿈으로 전체를 보여준다(기본은 한 줄 말줄임 유지). */
  wrap?: boolean;
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
          <div className="flex items-center gap-1.5 text-sm font-semibold text-status-urgent-text">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-urgent" />
            입력 필요
          </div>
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
