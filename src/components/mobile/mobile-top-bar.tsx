import { cn } from "@/lib/utils";

/**
 * 모바일 탭 공용 상단바 셸 — 일정탭의 글래스 카드 디자인이 정본(오너 피드백 2026-07-14).
 *
 * 탭 제목 + 우측 슬롯(새로고침·배지 등) + 본문 한 줄(children)로 구성한다.
 * 홈·캠페인·일정 세 탭이 이 셸을 공유해 탭 전환 시 헤더 인상이 튀지 않게 한다.
 * 훅 없는 순수 표현 컴포넌트라 서버 컴포넌트에서도 그대로 렌더된다.
 *
 * ⛔ **캡션 슬롯("WAG CRM")을 되살리지 말 것**(오너 지시 2026-08-26). 앱 안에서 앱
 * 이름을 다시 알려주는 자리라 판단 가치가 0이었고(P2 Decision-Value Priority),
 * 소비처 8곳 중 커스텀 값을 준 곳이 **한 번도 없었다는 사실 자체가** 그 슬롯이
 * 필요했던 적이 없다는 증거였다. 제거로 탭 6곳·시트 2곳의 상단이 한 줄씩 짧아진다 —
 * `src/app/pipeline/loading.tsx` 의 상단바 스켈레톤도 같은 줄을 뺐다(#192 높이 계약).
 */
export function MobileTopBar({
  title,
  right,
  children,
  className,
}: {
  title: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/60 bg-white/80 backdrop-blur-md shadow-soft-sm flex flex-col gap-2 px-4 py-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
          {children}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
    </div>
  );
}
