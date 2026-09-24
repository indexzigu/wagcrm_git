import type { Announcements, ScreenReaderInstructions } from "@dnd-kit/core";

/**
 * 칸반 드래그의 화면낭독기 문구 — 한국어·사실대로(interfaces 점검 묶음 G1, 2026-09-24).
 *
 * dnd-kit 기본값은 영어이고 「스페이스로 집어 화살표로 옮긴다」고 안내한다. 이 앱의 두 칸반은
 * `collisionDetection={pointerWithin}` 이라 포인터 좌표가 없는 키보드 드래그는 놓을 칸을 못 찾는다
 * (`pointerWithin` 은 좌표가 없으면 빈 배열 — @dnd-kit/core 원문 확인). 그래서 키보드 센서를 떼고
 * 키보드 경로를 따로 뒀다(판매 관리 = 카드 메뉴 「단계 이동」, 영업 = 상세 시트의 단계 버튼).
 * 기본 안내를 그대로 두면 없는 조작법을 읽어 준다 — 그 거짓을 여기서 갈아 끼운다.
 *
 * 드래그 공지(announcements)는 마우스로 끄는 화면낭독기 사용자를 위한 것이라 남기되 한국어로.
 */
export function buildKanbanDndAccessibility({
  instructions,
  itemLabel,
  columnLabel,
}: {
  /** 카드에 포커스했을 때 읽어 줄 실제 조작법. */
  instructions: string;
  itemLabel: (id: string) => string;
  columnLabel: (id: string) => string;
}): { screenReaderInstructions: ScreenReaderInstructions; announcements: Announcements } {
  return {
    screenReaderInstructions: { draggable: instructions },
    announcements: {
      onDragStart: ({ active }) => `${itemLabel(String(active.id))} 카드를 집었습니다.`,
      onDragOver: ({ active, over }) =>
        over
          ? `${itemLabel(String(active.id))} 카드가 ${columnLabel(String(over.id))} 위에 있습니다.`
          : `${itemLabel(String(active.id))} 카드가 놓을 수 있는 칸 밖에 있습니다.`,
      onDragEnd: ({ active, over }) =>
        over
          ? `${itemLabel(String(active.id))} 카드를 ${columnLabel(String(over.id))}에 놓았습니다.`
          : `${itemLabel(String(active.id))} 카드를 놓지 않았습니다.`,
      onDragCancel: ({ active }) => `${itemLabel(String(active.id))} 카드 이동을 취소했습니다.`,
    },
  };
}
