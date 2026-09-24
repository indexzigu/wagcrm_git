"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "../confirm-action-dialog";

// 반려는 기안을 종결(PENDING→REJECTED)시켜 되돌릴 수 없으므로 한 번 더 묻는다.
// 확인 창은 결과를 말하는 「기안 반려」로 실행하고, 실패 표시·중복 방지는 호출부의 onReject 가 맡는다.
export function RejectConfirmButton({
  onReject,
  disabled,
}: {
  onReject: () => Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={disabled}>
        반려
      </Button>
      <ConfirmActionDialog
        open={open}
        onOpenChange={setOpen}
        title="기안 반려"
        description="반려하면 이 기안은 종결되어 다시 승인할 수 없습니다."
        confirmLabel="기안 반려"
        onConfirm={async () => {
          setOpen(false);
          await onReject();
        }}
      />
    </>
  );
}
