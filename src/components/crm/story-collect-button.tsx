"use client";

// "지금 수집" 버튼 — /admin/stories 헤더. 서버의 브라우저 수집 경로(/api/stories/collect)를
// 관리자 세션으로 즉시 트리거한다. Vercel 자동 주기 외에 수동으로 돌리고 싶을 때. 서버에서
// 브라우저를 띄우므로 1~2분 걸릴 수 있어 진행 상태를 표시한다.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";

export function StoryCollectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function collect() {
    setBusy(true);
    toast.info("스토리 수집 중… 브라우저 수집이라 1~2분 걸릴 수 있어요.");
    try {
      const res = await fetch("/api/stories/collect", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `수집 실패 (${res.status})`);
      const errs = Array.isArray(data.errors) ? data.errors.length : 0;
      if (errs > 0) {
        // 부분 실패를 성공으로 뭉개지 않는다 — 서버(브라우저) 수집이 막히면 로컬 수집기가 보조 경로.
        toast.warning(
          `수집 종료. 셀러 ${data.activeSellers}명 · 신규 ${data.storiesNew}건 · 경고 ${errs}건. 계속 실패하면 로컬 수집기(capture-stories.command)로 보완하세요.`,
        );
      } else {
        toast.success(`수집 완료. 셀러 ${data.activeSellers}명 · 신규 ${data.storiesNew}건 저장`);
      }
      router.refresh();
    } catch (e) {
      toast.error(
        `${e instanceof Error ? e.message : "수집에 실패했습니다."} 로컬 수집기(capture-stories.command)로 보완할 수 있어요.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={collect}
      title="수집창 안 활성 셀러의 스토리만 서버에서 즉시 수집합니다 (게시물 미포함, 저비용)"
      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-bold text-white transition-colors hover:bg-slate-700 disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {busy ? "수집 중…" : "스토리만 수집"}
    </button>
  );
}
