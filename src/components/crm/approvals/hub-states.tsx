import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 결재함 본문의 세 가지 비-목록 상태 (Plan 2 Task 4).
 *
 * 탭이 6개라 상태 표현을 탭마다 쓰면 여섯 번 갈라진다 — 로딩은 스켈레톤(「불러오는
 * 중」 같은 스피너 문구를 쓰지 않는다: 레이아웃이 뛰지 않는 편이 읽기에 낫다),
 * 실패는 문구 + 다시 불러오기, 빈 목록은 탭별 한 문장이다.
 *
 * ⚠️ 빈 목록과 실패를 같은 얼굴로 그리지 말 것 — 운영자가 "없다"로 읽고 넘어간다.
 */

export const LOAD_ERROR_MESSAGE = "목록을 불러오지 못했습니다.";

/**
 * 로딩 표시의 공통 껍데기.
 *
 * 화면에는 스켈레톤만 보이고 「불러오는 중」 문구는 `sr-only` 로만 존재한다 —
 * 눈으로 읽는 사람에게는 레이아웃이 뛰지 않는 편이 낫고, 화면낭독기 사용자에게는
 * 모양이 아니라 **말**이 필요하기 때문이다(스켈레톤은 `aria-hidden` 이라 읽히지 않는다).
 */
function LoadingRegion({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">불러오는 중</span>
      <div className="flex flex-col gap-2" aria-hidden>
        {children}
      </div>
    </div>
  );
}

/** 카드 목록용 스켈레톤 — 카드 세 장 높이로 자리를 잡는다. */
export function CardListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <LoadingRegion>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-20 w-full rounded-lg" />
      ))}
    </LoadingRegion>
  );
}

/** 표(봇 활동)용 스켈레톤 — 행 다섯 줄. */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <LoadingRegion>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-8 w-full rounded-md" />
      ))}
    </LoadingRegion>
  );
}

export function LoadErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 py-6">
      <p className="text-sm text-muted-foreground">{LOAD_ERROR_MESSAGE}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        다시 불러오기
      </Button>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{message}</p>;
}

/**
 * 「더 보기」 — 커서 페이지네이션을 쓰는 기록 탭 두 곳이 공유한다.
 * 다음 장을 받아오는 동안 비활성이다(훅에도 같은 가드가 있다 — 버튼은 그 상태를
 * 눈에 보이게 할 뿐이고, 판정은 훅이 소유한다).
 */
export function LoadMoreButton({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-center pt-2">
      <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
        더 보기
      </Button>
    </div>
  );
}

/**
 * 허브 전체 스켈레톤 — `page.tsx` 의 Suspense fallback 과 `loading.tsx` 가 공유한다.
 * 탭바 자리(한 줄)와 본문 카드 세 장을 그대로 예약해 실제 렌더로 넘어갈 때 높이가
 * 뛰지 않게 한다(P8 Layout Stability).
 */
export function HubSkeleton() {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border/70 px-5 py-3">
        <Skeleton className="h-4 w-8" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-8" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="p-5">
        <CardListSkeleton />
      </div>
    </>
  );
}
