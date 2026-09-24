import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * 주문 관리 모달들의 공용 틀 — `ui/dialog`(Radix) 위에 기존 모달의 모양만 얹는다
 * (interfaces 점검 묶음 G1, 2026-09-24).
 *
 * 종전 모달은 `createPortal` 로 직접 그린 div 라 대화상자 역할·Esc 닫기·포커스 가두기·닫은 뒤
 * 포커스 복귀가 전부 없었다 — 키보드로 열면 포커스가 뒤 화면으로 새고 Esc 로 닫을 수 없었다.
 * 그 동작은 Radix 가 맡고, 머리·본문·꼬리 배치는 각 모달이 그대로 가진다.
 *
 * - 모달은 부모가 조건부로 마운트한다(`{open && <Modal/>}`) — 그래서 `open` 은 항상 true 고
 *   닫기는 `onClose` 로 부모 상태를 지우는 것뿐이다.
 * - 닫은 뒤 포커스 복귀는 여기서 한다. Radix 는 `DialogTrigger` 로 연 경우에만 포커스를 되돌리는데
 *   (트리거 ref 로 복귀) 이 모달들은 트리거 없이 상태로 열려, 그대로 두면 포커스가 문서 맨 앞으로
 *   떨어진다(행위 테스트가 잡았다). 마운트 순간의 포커스 요소를 기억해 되돌린다.
 * - `canClose=false`(발송·등록 진행 중)면 Esc·바깥 클릭을 무시한다 — 종전 배경 클릭 가드와 같은
 *   조건이다. 진행 중에 창이 닫혀 결과를 못 보는 일을 막는다.
 * - 닫기 X 는 각 모달이 머리에 이미 갖고 있어 프리미티브의 X 는 끈다.
 * - 제목은 각 모달이 `DialogTitle` 로 둔다(대화상자의 접근 이름). 설명문은 없는 모달이 많아
 *   `aria-describedby` 를 비운다 — 비우지 않으면 Radix 가 콘솔 경고를 낸다.
 */
/**
 * 닫은 뒤 돌아갈 요소. 메뉴 항목에서 열었다면 그 항목은 메뉴와 함께 사라지므로, 메뉴를 연 버튼
 * (Radix 메뉴의 `aria-labelledby` 가 가리키는 트리거)으로 돌아간다.
 */
function resolveReturnFocusTarget(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const menu = active.closest('[role="menu"]');
  const triggerId = menu?.getAttribute('aria-labelledby');
  if (triggerId) return document.getElementById(triggerId);
  return active;
}

export function ShippingDialogFrame({
  onClose,
  canClose = true,
  className,
  children,
}: {
  onClose: () => void;
  canClose?: boolean;
  /** 폭·최대 높이 등 모달별 크기. */
  className?: string;
  children: React.ReactNode;
}) {
  const [returnFocusTarget] = React.useState(() =>
    typeof document === 'undefined' ? null : resolveReturnFocusTarget(document.activeElement),
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && canClose) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
        }}
        // 알림(sonner)은 대화상자 밖에 뜬다 — 알림을 누른 것을 「바깥 클릭」으로 읽어 창까지 닫으면
        // 발송·등록 결과를 보던 창이 사라진다. 종전 모달도 알림 클릭으로는 닫히지 않았다.
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('[data-sonner-toaster]')) {
            event.preventDefault();
          }
        }}
        className={cn(
          // 프리미티브 기본값(grid·gap-4·p-4·text-sm·ring) 중 종전 모달에 없던 것을 되돌린다 —
          // 모달 안의 글자·여백은 각 모달이 이미 정한 값 그대로 보여야 한다.
          'flex w-full flex-col gap-0 rounded-2xl bg-white p-0 text-base shadow-overlay ring-0',
          className,
        )}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
