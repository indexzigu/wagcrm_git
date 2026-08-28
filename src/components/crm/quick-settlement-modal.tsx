"use client";

import React, { useEffect, useRef, useState } from "react";
import { Loader2, Copy, Check, Banknote, ShieldAlert, UploadCloud, FileText, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { patchCampaignSettlementStatus } from "@/lib/campaign-patch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

interface QuickSettlementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  data: {
    id: string;
    title: string;
    sellerName: string;
    accountNumber: string | null;
    /**
     * 지연된 칸 — 어느 완료 플래그를 쓸지까지 **서버(`agenda-settlements.ts`)가 정한다**.
     * ⛔ `kind` 로 필드를 다시 유도하지 말 것: 자사몰은 두 칸이 모두 PAYOUT 이라
     * 「지급이면 isPayoutCompleted」가 공급사 레그를 셀러 레그로 덮어쓴다.
     */
    overdueSlot: {
      kind: "DEPOSIT" | "PAYOUT";
      verb: "입금" | "지급";
      counterpartLabel: string;
      flagField: "isDepositReceived" | "isPayoutCompleted" | "isSupplierPayoutCompleted";
    } | null;
    /** 대조 금액. **null = 모름**(자사몰 공급사 지급엔 금액 컬럼이 없다) — 0 으로 접지 말 것. */
    targetAmount: number | null;
  } | null;
}

export function QuickSettlementModal({
  isOpen,
  onClose,
  onSuccess,
  data,
}: QuickSettlementModalProps) {
  const [copied, setCopied] = useState(false);
  const [memo, setMemo] = useState("");
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setMemo("");
    setIsConfirmed(false);
    setCopied(false);
    setFile(null);
    setIsDragActive(false);
  }, [isOpen]);

  // 구 배포 응답(슬롯 없음)이면 어느 칸을 쓸지 알 수 없다 — 조용히 셀러 지급으로 찍는
  // 대신 아무것도 렌더하지 않는다(잘못된 칸에 완료를 찍는 것이 안 뜨는 것보다 나쁘다).
  if (!data || !data.overdueSlot) return null;

  const { id, title, sellerName, accountNumber, overdueSlot, targetAmount } = data;
  const actionLabel = `${overdueSlot.verb}(${overdueSlot.kind === "DEPOSIT" ? "수금" : "송금"})`;

  const handleCopyAccount = () => {
    if (!accountNumber) return;
    navigator.clipboard.writeText(accountNumber);
    setCopied(true);
    toast.success("계좌 정보가 클립보드에 복사되었습니다.");
    window.setTimeout(() => setCopied(false), 2000);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(e.type === "dragenter" || e.type === "dragover");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    const nextFile = e.dataTransfer.files?.[0];
    if (nextFile) {
      setFile(nextFile);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = e.target.files?.[0];
    if (nextFile) {
      setFile(nextFile);
    }
  };

  const handleRemoveFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async () => {
    if (!isConfirmed) {
      toast.error("체크리스트의 내용을 확인하고 최종 확인을 진행해 주세요.");
      return;
    }

    setSubmitting(true);
    try {
      if (file) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("entityType", "CAMPAIGN");
        formData.append("entityId", id);
        formData.append("section", "CONTRACT_SETTLEMENT");
        formData.append(
          "notes",
          memo.trim() !== "" ? `정산 증빙: ${memo.trim()}` : "정산 증빙 자료"
        );

        const uploadRes = await fetch("/api/assets", {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) {
          const errData = await uploadRes.json().catch(() => ({}));
          throw new Error(errData.error ?? "증빙 파일 업로드에 실패했습니다.");
        }
      }

      const payload: Record<string, unknown> = {
        memo: memo.trim(),
        // 쓰기 대상은 슬롯이 소유한다 — 자사몰의 공급사 레그는
        // `isSupplierPayoutCompleted` 로 나가고 라우트가 그룹 전파까지 처리한다.
        [overdueSlot.flagField]: true,
      };

      const result = await patchCampaignSettlementStatus(id, payload, {
        fallbackError: "정산 상태 업데이트에 실패했습니다.",
        networkError: "정산 상태 업데이트에 실패했습니다.",
      });

      if (!result.ok) {
        throw new Error(result.error);
      }

      // 자사몰은 두 칸이 모두 「지급」이라 상대를 병기해야 방금 처리한 칸이 구분된다
      // (정산 카드 체크박스 토스트의 선례와 같은 문법).
      toast.success(`정산 ${actionLabel} 처리가 완료되었습니다 (${overdueSlot.counterpartLabel}).`);
      onSuccess();
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="size-4 text-emerald-600" />
            <span>정산 확인 및 완료</span>
          </DialogTitle>
          <DialogDescription>
            금전 사고 예방을 위해 다음 수납/지급 내역과 계좌를 한 번 더 대조하십시오.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4 py-2">
          <Field>
            <FieldLabel>대상 정보</FieldLabel>
            <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm">
              <div className="flex items-start justify-between gap-4">
                <span className="text-muted-foreground">캠페인 / 딜</span>
                <span className="min-w-0 max-w-[220px] truncate font-medium">{title}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">셀러명</span>
                <span className="font-medium">{sellerName}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">유형</span>
                <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium">
                  {overdueSlot.counterpartLabel} {actionLabel} 대기
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-border pt-2">
                <span className="font-medium text-foreground">대상 금액</span>
                {/* 금액 컬럼이 없는 칸(자사몰 공급사 지급)은 「₩0」이 아니라 미입력으로
                    말한다 — 이 화면은 실제 이체 내역과 대조하라고 띄우는 자리라, 확인된
                    0 과 모르는 값을 같은 모양으로 그리면 그 자체가 금전 사고 경로다. */}
                <span
                  className={
                    targetAmount == null
                      ? "text-sm font-medium text-muted-foreground"
                      : "text-sm font-semibold text-foreground"
                  }
                >
                  {targetAmount == null ? "금액 미입력 · 이체 내역으로 확인" : `₩${targetAmount.toLocaleString()} 원`}
                </span>
              </div>
            </div>
          </Field>

          {accountNumber && (
            <Field>
              <FieldLabel>수취 계좌 정보</FieldLabel>
              <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
                <span className="min-w-0 truncate font-mono text-sm text-foreground">
                  {accountNumber}
                </span>
                <Button variant="ghost" onClick={handleCopyAccount}>
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
            </Field>
          )}

          <Field>
            <FieldLabel>이체/정산 증빙 파일 첨부 (선택)</FieldLabel>
            <FieldDescription>
              이체증, 세금계산서 PDF, 이미지 등 최대 20MB까지 첨부할 수 있습니다.
            </FieldDescription>

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.gif,.csv,.xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
            />

            {!file ? (
              <div
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed p-4 text-center transition-colors ${
                  isDragActive
                    ? "border-primary bg-primary/5"
                    : "border-border bg-muted/20 hover:bg-muted/40"
                }`}
              >
                <UploadCloud className="mb-1.5 size-5 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">
                  클릭하거나 파일을 여기로 드래그하세요
                </p>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {(file.size / 1024).toFixed(1)} KB
                    </p>
                  </div>
                </div>
                <Button variant="ghost" onClick={handleRemoveFile}>
                  <X />
                </Button>
              </div>
            )}
          </Field>

          <Field>
            <FieldLabel>정산 처리 메모 (선택)</FieldLabel>
            <Textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="증빙 정보, 수수료 차감 내역, 세금계산서 발행일 등 특이사항을 입력해 주세요."
              className="min-h-[72px] resize-none"
            />
          </Field>

          <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={isConfirmed}
                onChange={(e) => setIsConfirmed(e.target.checked)}
                className="mt-0.5 size-4 rounded border-amber-300 text-amber-600"
              />
              <div className="flex flex-col gap-0.5">
                <p className="flex items-center gap-1 text-sm font-medium text-amber-900">
                  <ShieldAlert className="size-3.5 shrink-0" />
                  정산 정보를 최종 확인하였습니다.
                </p>
                <p className="text-xs text-amber-800">
                  실제 은행 이체/입금 내역과 위의 금액 및 계좌 정보가 일치함을 확인하고 완료 처리를 진행합니다.
                </p>
              </div>
            </label>
          </div>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            취소
          </Button>
          <Button onClick={handleSubmit} disabled={!isConfirmed || submitting}>
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />
                처리 중...
              </>
            ) : (
              "정산 완료 처리"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
