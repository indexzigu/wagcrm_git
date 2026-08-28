"use client";

// /admin/stories 헤더의 "게시물+스토리 전체 수집" 버튼 — 수집창 안 활성 셀러 전원을 대상으로
// ① 게시물(피드+릴스) 일괄 새로고침 = POST /api/campaign-posts/collect (경량 Tier0, 셀러당
// Graph 1콜·수초 — Gemini 재분석 없음. 오너 2026-07-13: 발행 확인엔 analyze 전체가 과함) →
// ② 전역 스토리 수집 = POST /api/stories/collect (서버 브라우저, 1~2분) 2단계 순차 실행.
// 각 단계가 서버 단일 호출이라 중단 개념이 없다(이전 셀러별 analyze 순차 루프의 "중단" 제거).
// 이 버튼이 자기 액션의 토스트를 단독 소유한다(P2 Toast Ownership).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export type BulkCollectTarget = {
  id: string;
  /** 표시명 — 별칭 우선(P2 Seller Alias Priority은 호출부(서버)가 적용해 내려준다) */
  label: string;
};

type Phase = "posts" | "stories" | null;

export function BulkContentCollectButton({ targets }: { targets: BulkCollectTarget[] }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(null);
  const busy = phase !== null;

  async function run() {
    // 1단계: 게시물 일괄 새로고침(수집창 셀러 전원, 서버가 대상 재산정·force).
    setPhase("posts");
    let feedLine = "";
    let feedFailed = false;
    try {
      const res = await fetch("/api/campaign-posts/collect", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        activeSellers?: number;
        refreshed?: number;
        errors?: unknown[];
        error?: string;
      };
      if (!res.ok) {
        feedFailed = true;
        feedLine = `게시물 실패(${data.error || res.status})`;
      } else {
        const warn =
          Array.isArray(data.errors) && data.errors.length > 0 ? ` · 경고 ${data.errors.length}건` : "";
        feedLine = `게시물 ${data.refreshed ?? 0}/${data.activeSellers ?? 0}명 갱신${warn}`;
        feedFailed = (data.refreshed ?? 0) === 0 && (data.activeSellers ?? 0) > 0;
      }
    } catch {
      feedFailed = true;
      feedLine = "게시물 요청 오류";
    }

    // 2단계: 전역 스토리 수집 1회 — 1단계가 실패해도 독립 시도(부분 수집이 0보다 낫다).
    setPhase("stories");
    let storyLine = "";
    let storyFailed = false;
    try {
      const res = await fetch("/api/stories/collect", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        storiesNew?: number;
        errors?: unknown[];
        error?: string;
      };
      if (!res.ok) {
        storyFailed = true;
        storyLine = `스토리 실패(${data.error || res.status}). 로컬 수집기(capture-stories.command)로 보완하세요`;
      } else {
        const warn =
          Array.isArray(data.errors) && data.errors.length > 0 ? ` · 경고 ${data.errors.length}건` : "";
        storyLine = `스토리 신규 ${data.storiesNew ?? 0}건${warn}`;
      }
    } catch {
      storyFailed = true;
      storyLine = "스토리 요청 오류. 로컬 수집기(capture-stories.command)로 보완하세요";
    }

    setPhase(null);
    const summary = `${feedLine} · ${storyLine}`;
    // severity 위계: 두 단계 다 실패 = error > 한쪽 실패·경고 = warning > 전부 성공 = success
    if (feedFailed && storyFailed) {
      toast.error(`전체 수집 실패. ${summary}`);
    } else if (feedFailed || storyFailed || summary.includes("경고")) {
      toast.warning(`전체 수집 종료. ${summary}`);
    } else {
      toast.success(`전체 수집 완료. ${summary}`);
    }
    router.refresh();
  }

  if (targets.length === 0) {
    return (
      <button
        type="button"
        disabled
        title="수집창(시작 7일 전~마감 1일 후) 안 활성 셀러가 없습니다"
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-bold text-slate-400"
      >
        <Download className="h-3.5 w-3.5" />
        게시물+스토리 전체 수집
      </button>
    );
  }

  if (busy) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs font-bold text-slate-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {phase === "posts" ? "게시물 수집 중… 1/2" : "스토리 수집 중… 2/2"}
      </span>
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          title="수집창 안 활성 셀러 전원의 게시물(피드+릴스)을 새로 고치고 스토리를 일괄 수집합니다"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
        >
          <Download className="h-3.5 w-3.5" />
          게시물+스토리 전체 수집
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>활성 셀러 {targets.length}명 전체 수집</AlertDialogTitle>
          <AlertDialogDescription>
            수집창 안 셀러 {targets.length}명의 게시물(피드+릴스)을 새로 고친 뒤 스토리를 일괄
            수집합니다. 게시물은 수초, 스토리는 1~2분 정도 걸려요.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-xs text-muted-foreground">
          대상: {targets.map((t) => t.label).slice(0, 8).join(", ")}
          {targets.length > 8 ? ` 외 ${targets.length - 8}명` : ""}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>취소</AlertDialogCancel>
          <AlertDialogAction onClick={() => void run()}>수집 시작</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
