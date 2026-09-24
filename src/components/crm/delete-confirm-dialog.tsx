"use client";

import { ConfirmActionDialog } from "./confirm-action-dialog";

type DeleteConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityName: string;
  entityType: "거래처" | "셀러" | "캠페인" | "노트" | "표현" | "담당자";
  onConfirm: () => Promise<void>;
  loading?: boolean;
};

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  entityName,
  entityType,
  onConfirm,
  loading = false,
}: DeleteConfirmDialogProps) {
  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${entityType} 삭제`}
      description={`${entityType} '${entityName}'을(를) 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`}
      confirmLabel={`${entityType} 삭제`}
      pendingLabel="삭제 중..."
      onConfirm={onConfirm}
      loading={loading}
    />
  );
}
