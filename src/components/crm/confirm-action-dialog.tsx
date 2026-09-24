"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** 확인 창 설명에 넣을 미리보기 — 잘랐으면 말줄임표로 잘렸다는 것을 보여준다. */
export function previewText(text: string, max = 30): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

type ConfirmActionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** 결과를 말하는 버튼 문구(「캠페인 삭제」·「반려」) — 「확인」 금지. */
  confirmLabel: string;
  pendingLabel?: string;
  onConfirm: () => Promise<void>;
  loading?: boolean;
};

// 되돌릴 수 없는 조작(삭제·반려)의 공용 확인 창. 확인 버튼은 destructive 변형으로 구분한다.
// 실패했을 때 창을 닫을지(오류가 창 밖에 뜨는 경우)·유지할지(재시도)는 호출부 재량이다 —
// 단 고른 쪽과 그 이유를 호출부 주석에 남길 것(같은 확인 창이 이유 없이 갈라지지 않도록).
export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel = "처리 중...",
  onConfirm,
  loading = false,
}: ConfirmActionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>취소</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={loading}
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
          >
            {loading ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
