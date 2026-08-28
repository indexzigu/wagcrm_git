import { isDemoMode } from "@/lib/demo-mode";

/**
 * 데모 배포 전용 플로팅 배지 — 외부 시연 중 "이 화면은 실데이터가 아니다"를 상시 고지한다.
 *
 * 형태 결정(P8): 사이드바가 fixed h-svh라 흐름(top strip) 배너는 레이아웃을 깨뜨린다 —
 * 상단 중앙 플로팅 필로 띄우고 pointer-events-none으로 어떤 클릭도 가로채지 않게 한다.
 * 색은 정본 토큰만 사용(navy primary + 골드 액센트 도트=장식, 가드레일 3 준수).
 * 실 프로덕션 빌드(DEMO_MODE 미설정)에서는 null — DOM에 아예 실리지 않는다.
 */
export function DemoModeBanner() {
  if (!isDemoMode()) return null;
  return (
    <div className="pointer-events-none fixed top-[calc(env(safe-area-inset-top,0px)+0.5rem)] left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground shadow-soft-md">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-gold" aria-hidden />
        데모 화면: 가상 데이터이며 변경은 저장되지 않습니다
      </div>
    </div>
  );
}
