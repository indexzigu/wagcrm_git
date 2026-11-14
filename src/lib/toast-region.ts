/**
 * 알림 영역과 모달의 경계 — `@/lib/toast`(알림을 띄우는 창구)와 일부러 분리한 파일이다.
 * 여러 테스트가 `vi.mock("@/lib/toast")` 로 알림 창구를 통째로 갈아 끼우는데, 공용 시트·대화상자가
 * 거기서 이 가드를 가져오면 그 테스트들의 모달 렌더가 전부 깨진다.
 */
/** 알림 영역(sonner `<Toaster>` 루트)을 찾는 선택자. */
export const TOASTER_SELECTOR = "[data-sonner-toaster]";

type OutsideEvent = { target: EventTarget | null; preventDefault: () => void };

/**
 * 모달(시트·대화상자·드로어)의 `onInteractOutside` 에 끼우는 가드 — 알림을 누른 것을 「바깥 클릭」으로
 * 읽지 않게 한다. 알림은 모달 밖(body 직속)에 뜨므로, 가드가 없으면 알림의 닫기 버튼을 누르는 순간
 * 열려 있던 창이 닫혀 입력 중이던 폼이 사라진다. 호출부가 넘긴 핸들러는 그대로 먼저 부른다.
 *
 * 짝: `ui/sonner.tsx` 가 알림 영역에 `pointer-events: auto` 를 건다 — 모달이 열리면 Radix 가 body 에
 * `pointer-events: none` 을 걸고 알림도 그것을 물려받아 닫기 버튼이 눌리지 않았다(2026-11-14).
 */
export function keepModalOpenOnToast<E extends OutsideEvent>(handler?: (event: E) => void) {
  return (event: E) => {
    handler?.(event);
    const target = event.target;
    if (target instanceof Element && target.closest(TOASTER_SELECTOR)) event.preventDefault();
  };
}
