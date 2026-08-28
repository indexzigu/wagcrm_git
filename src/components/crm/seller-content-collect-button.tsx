"use client";

// 캠페인 상세 "셀러 게시물" 헤더의 셀러별 순차 수집 버튼 — ① 게시물(피드+릴스) =
// POST /api/campaign-posts/collect { sellerId } (경량 Tier0 새로고침, 수초 · Gemini 재분석 없음.
// 오너 2026-07-13: 발행 확인엔 analyze 전체가 과함 — AI 재분석은 셀러 상세 "재분석" 버튼 담당)
// → ② 스토리 = POST /api/stories/collect { sellerId } (서버 브라우저, 1~2분).
// 두 단계 모두 서버가 수집창 교집합을 재검증한다 — 창 밖이면 대상 0으로 건너뜀을 안내.
// 1단계 실패해도 2단계는 독립 시도한다(부분 수집이 0보다 낫다). 이 버튼이 자기 액션의 토스트를
// 단독 소유한다(P2 Toast Ownership).
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Step = "idle" | "feed" | "stories";

type SellerContentCollectButtonProps = {
  sellerId: string;
  snsType: string;
  /** 수집 종료(성공·부분실패 불문) 후 호출 — 호스트가 후보 피드·스토리 목록을 재조회한다. */
  onComplete?: () => void;
};

/** 스토리 수집 응답의 요약 필드(전역 StoryCollectButton과 동일 계약 — StoryCaptureResult 부분집합) */
type StoryCollectPayload = {
  activeSellers?: number;
  storiesNew?: number;
  errors?: unknown[];
  error?: string;
};

export function SellerContentCollectButton({
  sellerId,
  snsType,
  onComplete,
}: SellerContentCollectButtonProps) {
  const [step, setStep] = useState<Step>("idle");
  const isInstagram = (snsType || "").toUpperCase() === "INSTAGRAM";
  const busy = step !== "idle";

  async function run() {
    // 1단계: 게시물(피드+릴스) — 경량 Tier0 새로고침(Graph 1콜, 수초). 서버가 수집창 재검증.
    setStep("feed");
    let feedError: string | null = null;
    let feedTargets: number | null = null;
    try {
      const res = await fetch("/api/campaign-posts/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sellerId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        activeSellers?: number;
        errors?: unknown[];
        error?: string;
      };
      if (!res.ok) {
        feedError = data.error || `게시물 수집 실패 (${res.status})`;
      } else {
        feedTargets = data.activeSellers ?? 0;
        if (Array.isArray(data.errors) && data.errors.length > 0) {
          feedError = String(data.errors[0]);
        }
      }
    } catch {
      feedError = "게시물 수집 요청 중 오류가 발생했습니다.";
    }

    // 2단계: 스토리 — 서버가 캠페인 수집창 교집합을 재검증한다(창 밖이면 대상 0으로 종료).
    setStep("stories");
    let storyError: string | null = null;
    let storiesNew = 0;
    let storyTargets: number | null = null;
    try {
      const res = await fetch("/api/stories/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sellerId }),
      });
      const data = (await res.json().catch(() => ({}))) as StoryCollectPayload;
      if (!res.ok) {
        storyError = data.error || `스토리 수집 실패 (${res.status})`;
      } else {
        storiesNew = data.storiesNew ?? 0;
        storyTargets = data.activeSellers ?? 0;
        if (Array.isArray(data.errors) && data.errors.length > 0) {
          storyError = String(data.errors[0]);
        }
      }
    } catch {
      storyError = "스토리 수집 요청 중 오류가 발생했습니다.";
    }
    setStep("idle");
    onComplete?.();

    // 요약 토스트 — 무엇이 됐고 무엇이 안 됐는지 단계별로 명시. 스토리 서버 수집은
    // 실패할 수 있는 경로(브라우저 기반)라 로컬 수집기 폴백을 안내한다.
    const feedSummary =
      feedTargets === 0 ? "게시물: 수집창 밖이라 건너뜀" : "게시물 갱신";
    const storySummary =
      storyTargets === 0
        ? "스토리: 수집창(시작 7일 전~마감 1일 후) 밖이라 건너뜀"
        : `스토리 신규 ${storiesNew}건 저장`;
    if (!feedError && !storyError) {
      toast.success(`수집 완료. ${feedSummary} · ${storySummary}`);
    } else if (feedError && storyError) {
      toast.error(
        `수집 실패. 게시물: ${feedError} · 스토리: ${storyError}. 스토리는 로컬 수집기(capture-stories.command)로 보완할 수 있어요.`,
      );
    } else if (feedError) {
      toast.warning(`게시물 수집 실패(${feedError}). ${storySummary}.`);
    } else {
      toast.warning(
        `게시물은 갱신됐지만 스토리 수집이 실패했어요(${storyError}). 로컬 수집기(capture-stories.command)로 보완하세요.`,
      );
    }
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2.5 text-[11px]"
      disabled={busy || !isInstagram}
      title={
        busy
          ? "수집이 진행 중입니다"
          : isInstagram
            ? "게시물(피드+릴스) → 스토리 순서로 지금 수집"
            : "현재 인스타그램 계정만 수집할 수 있습니다"
      }
      onClick={() => {
        toast.info("셀러 콘텐츠 수집 중… 게시물은 수초, 스토리는 1~2분 걸릴 수 있어요.");
        void run();
      }}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
      {step === "feed" ? "게시물 수집 중… 1/2" : step === "stories" ? "스토리 수집 중… 2/2" : "지금 수집"}
    </Button>
  );
}
