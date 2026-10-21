// 선택 토글(필터 알약·세그먼트·단계 표시)의 선택/미선택 표기 — 한 곳에서만 정한다.
// 청록 채움(bg-primary)은 「누를 동작」 전용이라 선택 표시는 옅은 청록으로 둔다(화면당 청록 채움 하나).
// 옅은 바탕은 흰 바탕 대비 1.17:1 이라 색만으로는 약하다 — 굵기 차이가 색 외 단서다(WCAG 1.4.1).
export const SELECTED_TOGGLE = "bg-primary/10 font-bold text-primary";
export const UNSELECTED_TOGGLE = "font-medium text-slate-500";
