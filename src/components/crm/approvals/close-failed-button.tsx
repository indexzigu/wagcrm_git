"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "../confirm-action-dialog";

/**
 * 실패 기안 「종결」 — 다른 경로로 이미 처리했거나 더 필요 없는 실패 기안을 실패 탭에서 뺀다
 * (`POST /api/action-proposals/[id]/close`). 되돌릴 수 없으므로 반려처럼 한 번 더 묻는다.
 * 「이미반영됨」 배지가 붙은 카드에서는 이 버튼이 주 버튼이 된다 — 그 카드의 할 일은 재시도가 아니라 정리다.
 * 실패 표시·중복 방지는 호출부의 onClose 가 맡는다.
 */
export function CloseFailedButton({
  onClose,
  disabled,
  primary,
}: {
  onClose: () => Promise<void>;
  disabled?: boolean;
  primary?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant={primary ? "default" : "outline"} onClick={() => setOpen(true)} disabled={disabled}>
        종결
      </Button>
      <ConfirmActionDialog
        open={open}
        onOpenChange={setOpen}
        title="실패 기안 종결"
        description="종결하면 실패 목록에서 빠지고 반려 탭에 종결됨으로 남습니다. 다시 실행할 수 없습니다."
        confirmLabel="기안 종결"
        onConfirm={async () => {
          setOpen(false);
          await onClose();
        }}
      />
    </>
  );
}
