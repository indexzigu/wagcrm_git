import OrderDashboard from '@/components/crm/order-dashboard';

/**
 * 주문 관리 화면의 **높이 사슬을 여기서 확정한다.**
 *
 * 앱 셸(`AppShellFrame` · `SidebarProvider`)은 `min-h-svh`(최소 높이)만 준다 — 높이가
 * `auto` 라는 뜻이다. 그러면 내용이 화면보다 길어질 때 셸이 **늘어나고**, `CrmShell` 의
 * `h-full`(= height:100%)이 기댈 확정 높이가 없어 안쪽 스크롤러가 스크롤하지 않는다.
 * 대신 **문서(브라우저 창)가 스크롤한다.**
 *
 * 그 결과가 오너가 지적한 흔들림이다: 캠페인 카드를 펼치면 내용이 길어져 창 스크롤바가
 * 나타나고, 그 순간 뷰포트 폭이 스크롤바 너비(실측 15px)만큼 줄어 **카드 너비가 함께 준다**
 * (실측 1263 → 1248px). 다시 접으면 되돌아온다.
 *
 * `h-svh` 로 높이를 확정하면 `CrmShell` 의 `h-full` 이 풀리고, 넘치는 분량은 셸 안쪽
 * 스크롤러(`[scrollbar-gutter:stable]` 를 이미 가진 그 div)가 받는다 — 그쪽은 자리를
 * 항상 예약하므로 스크롤바가 생겨도 폭이 흔들리지 않는다.
 *
 * ⛔ **`flex-1` 을 다시 붙이지 말 것 — `h-svh` 가 무시된다.** flex 아이템의 주축 크기는
 * `flex-basis`(`flex-1` = `0%`)가 정하므로 `height` 는 쓰이지 않고, 부모(`SidebarInset`)가
 * 높이 `auto` 라 아이템이 내용만큼 자란다. 실측: `flex-1 h-svh` 는 높이가 900px 로 계산돼
 * 고쳐진 것처럼 보이는데도 문서가 197px 넘쳐 흔들림이 그대로였다.
 *
 * ⛔ 전역 셸(`AppShellFrame` · `ui/sidebar.tsx`)의 `min-h-svh` 를 `h-svh` 로 바꿔 고치지
 * 말 것 — 그 래퍼는 문서 스크롤에 기대는 페이지(`/privacy` · 로그인 랜딩 등)도 함께 쓴다.
 * 높이를 전역에서 자르면 그런 화면의 아래쪽이 **스크롤 수단 없이 잘린다**(실측 확인).
 */
export default function OrderConverterPage() {
  return (
    <div className="h-svh w-full bg-slate-50 font-sans text-slate-900">
      <div className="h-full w-full max-w-full">
        <OrderDashboard />
      </div>
    </div>
  );
}
