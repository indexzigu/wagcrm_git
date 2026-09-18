import OrderDashboard from '@/components/crm/order-dashboard';

/**
 * 높이 사슬의 앵커는 `SidebarInset`(`persistent-sidebar-layout.tsx` 의 `md:h-svh`)이다 —
 * 이 화면은 그 높이를 `h-full` 로 `CrmShell` 까지 물려주기만 한다.
 *
 * ⛔ 바깥 래퍼에 `flex-1` 을 붙이지 말 것. 부모(`SidebarInset`)가 세로 flex 라 `flex-1` 이면
 * 크기를 `flex-basis` 가 정하고, 최소 높이가 내용 기준으로 풀려 래퍼가 내용만큼 자란다
 * (#84 실측: 높이가 900px 로 계산되는데도 문서가 197px 넘쳐 카드 폭 흔들림이 그대로였다).
 * `h-full` 은 지정 높이가 최소 높이의 상한이 돼 뷰포트에 묶인다.
 */
export default function OrderConverterPage() {
  return (
    <div className="h-full w-full bg-slate-50 font-sans text-slate-900">
      <div className="h-full w-full max-w-full">
        <OrderDashboard />
      </div>
    </div>
  );
}
