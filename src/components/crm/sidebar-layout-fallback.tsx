/**
 * Build-time/PPR fallback for PersistentSidebarLayout's Suspense boundary.
 * Must stay free of dynamic APIs (usePathname, cookies etc.) so cacheComponents can
 * prerender it as the static shell. Approximates the sidebar-shown shape — the outcome
 * for every route except /login, /auth, /privacy — so the swap-in of the real,
 * pathname-aware layout doesn't shift layout for the common case.
 *
 * ⚠️ **자리표시 폭은 레일 하나다** — 사이드바는 저장된 상태를 갖지 않고 호버·포커스로만
 * 임시로 펼쳐지므로(peek 모드), 셸이 고를 상태 자체가 없다. 본문이 시작하는 자리는
 * 항상 레일 폭이고, 펼침은 그 위를 덮을 뿐이라 셸도 늘 레일이면 맞다.
 * ⛔ 여기에 펼침 폭(`--sidebar-width`)이나 상태별 변형을 되살리지 말 것 — 셸이 본문으로
 *    교체되는 순간 콘텐츠가 112px(10rem − 3rem) 옆으로 뛴다.
 * ⛔ 여기서 `--sidebar-width-icon` 대신 `3rem` 같은 값을 쓰지 말 것(폭의 정본은 그 변수다).
 *
 * **페이지 내용(children)을 받지 않는다 — 의도다.** 예전엔 `{children}` 을 받아
 * `<main>` 안에 렌더했는데, 그러면 같은 서브트리가 fallback 과 본문 양쪽에 동시에
 * 존재한다. React 가 스트리밍된 본문으로 fallback 을 교체할 때 insertBefore 가
 * "이미 DOM 에 있는 자기 조상"을 삽입하려다 HierarchyRequestError 를 던지고
 * **앱 전역이 화이트스크린**이 됐다(에러 위치는 React 의 $RV reveal). 빌드는 통과하고
 * 실기기에서만 터져서 오래 안 잡혔다.
 *
 * **prop 을 되살리지 말 것** — children 을 다시 넣는 순간 그 사고가 재발한다.
 * 대가는 이 fallback 이 뜨는 동안 본문이 잠깐 비는 것(깜빡임)이고, 화이트스크린과
 * 바꾼 값이다. 깜빡임을 없애려면 children 을 fallback 에 넣는 게 아니라 Suspense
 * 경계를 사이드바만 감싸도록 좁혀야 한다(후속 과제).
 */
export function SidebarLayoutFallback() {
  return (
    <>
      <div
        aria-hidden
        className="hidden h-svh w-(--sidebar-width-icon) shrink-0 border-r border-sidebar-border bg-sidebar md:block"
      />
      <main className="relative flex min-w-0 flex-1 flex-col bg-background pb-20 md:pb-0" />
    </>
  );
}
