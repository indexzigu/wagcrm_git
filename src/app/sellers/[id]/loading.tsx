import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      분석 리포트 불러오는 중…
    </div>
  );
}
