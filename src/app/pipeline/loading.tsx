import { Skeleton } from "@/components/ui/skeleton";

/**
 * 높이는 본문(`mobile-pipeline-view.tsx` 의 `min-h-[calc(100dvh+1px)]`)과 **같아야 한다.**
 *
 * `min-h-[60vh]` 였을 때, 캠페인 탭 진입 시 로딩→본문 사이 페이지 높이가 급변하면서
 * iOS 스탠드얼론 웹앱에서 하단 탭바가 위로 끌려 올라가 보였다(#192, 오너 실기기 보고).
 * `MobileBottomNav` 는 fixed 라 콘텐츠에 끌릴 수 없다 — 스크롤 가능한 페이지가 갑자기
 * 화면보다 짧아질 때 iOS 가 fixed 를 스테일한 스크롤 오프셋으로 그리는 문제다.
 * 60vh 로 되돌리지 말 것. 계약 테스트(`pipeline-loading-height-contract`)가 고정한다.
 * 플로팅 idle-reveal nav(2026-07-16)도 여전히 fixed 라 이 계약을 그대로 상속한다.
 *
 * 스피너 → 스켈레톤(오너 승인 2026-07-16, 추가개선 1): 주요 로딩 화면 중 이 파일만
 * 중앙 스피너였다. 스켈레톤은 최종 레이아웃의 모양을 흉내낸다(styleseed 안티슬롭 3) —
 * 상단바 카드 + 목록 카드, 모바일 탭 본문과 같은 리듬. 데스크톱(칸반)에서도 같은 카드
 * 스켈레톤이 스피너보다 정보가 많다. 상단 여백은 `.mobile-tab-safe-top`(#192 와 동일
 * 규칙 — 이 화면 위에도 스탠드얼론 상태바가 덮인다. 데스크톱은 env()=0 이라 pt-2 상당).
 */
export default function PipelineLoading() {
  return (
    <div className="mobile-tab-safe-top flex min-h-[calc(100dvh+1px)] flex-1 flex-col gap-4 bg-slate-50/50 px-5 pb-24">
      {/* 상단바 카드 자리 — 캡션 줄은 본문에서 사라졌으므로 여기서도 뺀다(오너 지시
          2026-08-26, `mobile-top-bar.tsx` 주석 참조). 로딩↔본문 높이가 어긋나면 위
          #192 회귀가 그대로 재발하므로 두 파일은 반드시 함께 움직인다. */}
      <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-3 shadow-soft-sm">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="mt-2 h-3 w-40" />
      </div>
      {/* 캠페인 카드 목록 자리 */}
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-white/60 bg-white/80 p-4 shadow-soft-sm">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-5 w-14 rounded-2xl" />
          </div>
          <Skeleton className="mt-3 h-3 w-24" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}
