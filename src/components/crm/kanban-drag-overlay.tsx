"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { DragOverlay } from "@dnd-kit/core";
import { snapCenterToCursor } from "@dnd-kit/modifiers";

/**
 * 칸반 공용 드래그 오버레이 — 반드시 DndContext 안에서 사용한다.
 *
 * 소재 이유(둘 다 계약):
 * 1. body 포털 — 칸반 보드는 유리 컨테이너(`backdrop-blur`) 안에 있는데,
 *    backdrop-filter는 자손 `position:fixed`의 containing block을 뷰포트에서
 *    자기 자신으로 바꾼다. DragOverlay(fixed)를 그 자리에서 렌더하면 컨테이너의
 *    뷰포트 오프셋만큼 카드가 커서 아래로 밀린다(영업/판매 관리에서 실측 —
 *    페이지마다 헤더 높이가 달라 밀림 정도도 달랐다). 포털로 좌표계를 복원한다.
 * 2. snapCenterToCursor — 잡는 순간 카드 중심이 커서에 오도록 스냅(오너 확정
 *    동작). 키보드 드래그는 좌표가 없어 모디파이어가 no-op으로 통과한다.
 */
const DROP_ANIMATION = {
  duration: 180,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
};

export function KanbanDragOverlay({ children }: { children: React.ReactNode }) {
  // SSR/하이드레이션 안전 — 마운트 전에는 document가 없어 포털을 만들 수 없다.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <DragOverlay modifiers={[snapCenterToCursor]} dropAnimation={DROP_ANIMATION}>
      {children}
    </DragOverlay>,
    document.body,
  );
}
