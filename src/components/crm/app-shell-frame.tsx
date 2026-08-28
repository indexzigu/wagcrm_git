import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_ICON } from "@/components/ui/sidebar";

/**
 * 앱 전역 셸 프레임 — 사이드바 폭 변수와 flex 레이아웃만 소유한다.
 *
 * 🪤 **종전에 이 자리는 두 번째 `SidebarProvider` 였다(`SidebarPersistentProvider`).**
 * 상태는 아무도 안 읽었지만(`useSidebar` 소비자는 안쪽 provider 안의 `CrmSidebar` 뿐)
 * `SidebarProvider` 는 **Cmd+B 키보드 핸들러를 등록하고 그 핸들러가 쿠키를 쓴다.**
 * 그래서 provider 가 둘이면:
 *   - Cmd+B 한 번에 **쿠키가 두 번 쓰인다**(실측). 두 provider 의 초기 상태가 서로
 *     달라(바깥=리터럴 기본값 / 안쪽=쿠키값) 값이 **정반대**이고, 결과가 맞았던 것은
 *     안쪽 리스너가 뒤에 등록돼 나중에 덮어썼기 때문 — **등록 순서에 기댄 우연**이었다.
 *   - 사이드바가 없는 페이지(`/login` · `/auth` · `/privacy` · `/p/*` · 셀러 포털)에서는
 *     안쪽 provider 가 아예 없어 **바깥쪽 것만 쓴다** → 오너가 접어 둔 상태가 조용히
 *     뒤집힌다(2026-08-25 실측 재현: `/privacy` 에서 Cmd+B → `sidebar_state` false→true).
 *
 * 지속성이 들어오기 전에는 쿠키를 아무도 읽지 않아 이 오염이 **보이지 않았다.**
 * ⛔ **이 컴포넌트를 다시 `SidebarProvider` 로 되돌리지 말 것** — 계약
 * `sidebar-single-provider.contract.test.ts` 가 막는다.
 *
 * ⚠️ **그렇다고 통째로 지울 수도 없다.** 이 래퍼는 실제 레이아웃을 소유한다:
 *   ① `--sidebar-width`/`--sidebar-width-icon` — 정적 셸(`SidebarLayoutFallback`)이
 *      자리표시 폭을 여기서 상속받는다(그 시점엔 안쪽 provider 가 아직 없다).
 *   ② `flex min-h-svh w-full` — 사이드바 없는 페이지들이 이 flex 의 직계 자식이다
 *      (`coupang-partners` 가 `w-full` 을 명시하는 이유).
 */
export function AppShellFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="app-shell-frame"
      style={
        {
          "--sidebar-width": SIDEBAR_WIDTH,
          "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
        } as React.CSSProperties
      }
      className="flex min-h-svh w-full"
    >
      {children}
    </div>
  );
}
