"use client";

import * as React from "react";
import Link from "next/link";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileIcon,
  FileSpreadsheetIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchableDropdown } from "@/components/crm/searchable-dropdown";
import { formatBytes } from "@/lib/format";
import {
  applyPriceSheetRows,
  ingestPriceSheetFile,
  mapAndCategorize,
  validatePriceSheetFile,
  type PriceSheetIngestPhase,
  type PriceSheetReview,
} from "./price-sheet-ingest";

/** 슬롯 종료 결과 — 채팅에서 반영 완료(applied) 또는 업로드/추출 실패. */
export type PriceSheetDoneResult =
  | { ok: true; priceSheetId: string; appliedRowCount: number; dealCount: number }
  | { ok: false; error: string; priceSheetId: string | null };

// 미리보기 리스트에 펼치는 최대 행 수 — 초과분은 "외 N개"로 접는다.
const PREVIEW_ROW_LIMIT = 5;

const NONE_PARTNER_OPTION = { id: "__none__", name: "지정 안 함" };

type PartnerOption = { id: string; name: string };

export type PriceSheetIngestState =
  | { kind: "idle" }
  | { kind: "pending"; file: File }
  | { kind: "running"; file: File; phase: PriceSheetIngestPhase }
  | { kind: "reviewing"; review: PriceSheetReview }
  | { kind: "applying"; review: PriceSheetReview }
  | { kind: "done"; result: PriceSheetDoneResult };

/**
 * 어시스턴트 입력줄 위 슬롯의 상태기계. 드롭/클립 → 대기(거래처 확인) → 업로드·추출·매핑
 * 진행 → 검토 카드(깨끗한 건 채팅 적용 / 애매한 건 검토 화면으로) → 반영 완료. 결과는 채팅
 * 메시지 배열에 넣지 않는다 — 이 흐름은 /api/assistant 영속화 경로 밖이라 말풍선으로 만들면
 * 대화 재수화 때 사라진다(ss-ux P0 #2).
 */
export function usePriceSheetIngest() {
  const [state, setState] = React.useState<PriceSheetIngestState>({ kind: "idle" });

  const stageFile = React.useCallback((file: File) => {
    setState((prev) => {
      // 진행 중 재드롭은 무시한다 — 한 번에 한 파일만(대기 중 재드롭은 교체).
      if (prev.kind === "running" || prev.kind === "applying") return prev;
      const validationError = validatePriceSheetFile(file);
      if (validationError) {
        return { kind: "done", result: { ok: false, error: validationError, priceSheetId: null } };
      }
      return { kind: "pending", file };
    });
  }, []);

  const confirmUpload = React.useCallback(
    async (partnerId: string | null) => {
      if (state.kind !== "pending") return;
      const file = state.file;
      setState({ kind: "running", file, phase: "uploading" });

      const result = await ingestPriceSheetFile(file, partnerId, (phase) => {
        setState((prev) => (prev.kind === "running" ? { ...prev, phase } : prev));
      });
      if (!result.ok) {
        setState({
          kind: "done",
          result: { ok: false, error: result.error, priceSheetId: result.priceSheetId },
        });
        return;
      }
      // 추출 성공 → 매핑 계산까지 이어붙인다(2단계). 실패해도 mapAndCategorize가 전량 애매로 저하.
      setState((prev) => (prev.kind === "running" ? { ...prev, phase: "mapping" } : prev));
      const review = await mapAndCategorize(result.priceSheetId, result.rowCount);
      setState({ kind: "reviewing", review });
    },
    [state],
  );

  const applyClean = React.useCallback(async () => {
    if (state.kind !== "reviewing") return;
    const review = state.review;
    setState({ kind: "applying", review });
    const result = await applyPriceSheetRows(review.priceSheetId);
    setState({
      kind: "done",
      result: result.ok
        ? {
            ok: true,
            priceSheetId: review.priceSheetId,
            appliedRowCount: result.appliedRowCount,
            dealCount: result.dealCount,
          }
        : { ok: false, error: result.error, priceSheetId: review.priceSheetId },
    });
  }, [state]);

  const cancel = React.useCallback(() => {
    setState((prev) => (prev.kind === "pending" ? { kind: "idle" } : prev));
  }, []);

  const dismiss = React.useCallback(() => {
    // 검토 카드(reviewing)는 사용자가 적용도 검토화면 이동도 안 하고 닫을 수 있어야 한다.
    setState((prev) =>
      prev.kind === "done" || prev.kind === "reviewing" ? { kind: "idle" } : prev,
    );
  }, []);

  return {
    state,
    /** 슬롯 점유 여부 — 빈 대화 제안 칩과 상호 배타(ss-ux P0 #4). */
    isOccupied: state.kind !== "idle",
    /** 네트워크 진행 중(업로드·추출·매핑·반영) — 클립/전송 버튼 비활성화용. */
    isRunning: state.kind === "running" || state.kind === "applying",
    stageFile,
    confirmUpload,
    applyClean,
    cancel,
    dismiss,
  };
}

const PHASE_LABEL: Record<PriceSheetIngestPhase, string> = {
  uploading: "업로드 중...",
  extracting: "추출 중...",
  mapping: "매핑 분석 중...",
};

function rowLabel(row: { productName: string | null; optionName: string | null }): string {
  return [row.productName, row.optionName].filter(Boolean).join(" · ") || "이름 없음";
}

/**
 * 슬롯 렌더링 — 대기 바 / 진행 바 / 성공·실패 카드. 스크린리더 공지를 위해 래퍼가
 * role="status" aria-live="polite"를 가진다(partners-management 선례, ss-ux a11y P0).
 */
export function PriceSheetIngestSlot({
  state,
  onConfirm,
  onApply,
  onCancel,
  onDismiss,
}: {
  state: PriceSheetIngestState;
  onConfirm: (partnerId: string | null) => void;
  onApply: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const [partners, setPartners] = React.useState<PartnerOption[]>([]);
  const [selectedPartnerId, setSelectedPartnerId] = React.useState<string>(NONE_PARTNER_OPTION.id);
  const isPending = state.kind === "pending";

  // 거래처 목록은 파일이 대기 상태로 올라온 뒤에만 지연 로드한다 — 어시스턴트 페이지
  // 진입마다 /api/partners를 때리지 않기 위해서다.
  React.useEffect(() => {
    if (!isPending || partners.length > 0) return;
    fetch("/api/partners")
      .then((res) => res.json())
      .then((data) => setPartners(data.partners ?? []))
      .catch(() => setPartners([]));
  }, [isPending, partners.length]);

  if (state.kind === "idle") return null;

  return (
    <div role="status" aria-live="polite">
      {state.kind === "pending" && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-xs font-medium text-foreground">
            {state.file.name} · {formatBytes(state.file.size)}
          </span>
          <div className="w-48">
            <SearchableDropdown
              items={[NONE_PARTNER_OPTION, ...partners]}
              value={selectedPartnerId}
              onValueChange={setSelectedPartnerId}
              getSearchableText={(partner) => partner.name}
              getLabel={(partner) => partner.name}
              getValue={(partner) => partner.id}
              placeholder="거래처 선택 (미지정 가능)"
              emptyMessage="검색 결과 없음"
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              onConfirm(selectedPartnerId === NONE_PARTNER_OPTION.id ? null : selectedPartnerId)
            }
          >
            업로드
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            취소
          </Button>
        </div>
      )}

      {state.kind === "running" && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate">
            {state.file.name} · {PHASE_LABEL[state.phase]}
          </span>
        </div>
      )}

      {state.kind === "reviewing" && (
        <ReviewCard review={state.review} onApply={onApply} onDismiss={onDismiss} />
      )}

      {state.kind === "applying" && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate">딜에 반영 중...</span>
        </div>
      )}

      {state.kind === "done" && state.result.ok && (
        <div className="mx-3 mb-2.5 mt-2.5 flex items-start gap-2 rounded-lg border border-status-success/30 bg-status-success-bg px-3 py-2 shadow-soft-sm">
          <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-status-success" />
          <p className="flex-1 text-xs text-status-success">
            {/* 그룹핑 시 딜 수가 행 수보다 클 수 있다(/apply rowCount vs results.length) —
                자매 화면(price-sheet-detail 토스트)과 동일하게 다를 때만 병기(ss-ux P0). */}
            {state.result.dealCount === state.result.appliedRowCount
              ? `품목 ${state.result.appliedRowCount}개를 딜에 반영 완료`
              : `품목 ${state.result.appliedRowCount}개 반영 완료 (딜 ${state.result.dealCount}개 생성·수정)`}
          </p>
          <Link
            href={`/assets/price-sheets/${state.result.priceSheetId}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            반영 결과 보기
            <ExternalLinkIcon className="size-3" />
          </Link>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="닫기" onClick={onDismiss}>
            <XIcon className="size-3" />
          </Button>
        </div>
      )}

      {state.kind === "done" && !state.result.ok && (
        <div className="mx-3 mb-2.5 mt-2.5 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive shadow-soft-sm">
          <p className="flex-1">{state.result.error}</p>
          {state.result.priceSheetId ? (
            <Link
              href={`/assets/price-sheets/${state.result.priceSheetId}`}
              className="shrink-0 font-medium underline"
            >
              상세에서 재시도
            </Link>
          ) : (
            <Link href="/assets/price-sheets" className="shrink-0 font-medium underline">
              가격표 목록에서 보기
            </Link>
          )}
          <Button type="button" size="icon-xs" variant="ghost" aria-label="닫기" onClick={onDismiss}>
            <XIcon className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * 매핑 분석 후 검토 카드. 깨끗한 행(새 딜)만 있으면 채팅에서 바로 적용 버튼을 열고, 애매한
 * 행이 하나라도 있으면 (부분 적용 = APPLIED 잠금 충돌이라) 채팅 적용을 열지 않고 검토 화면으로
 * 통째로 넘긴다. 깨끗+애매가 섞였어도 애매가 있으면 검토 화면 경로만 노출한다(1차 안전판).
 */
function ReviewCard({
  review,
  onApply,
  onDismiss,
}: {
  review: PriceSheetReview;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const detailHref = `/assets/price-sheets/${review.priceSheetId}`;
  const hasClean = review.clean.length > 0;
  const hasAmbiguous = review.ambiguousCount > 0;
  const canApplyInChat = hasClean && !hasAmbiguous;
  const previewRows = review.clean.slice(0, PREVIEW_ROW_LIMIT);
  const overflow = review.clean.length - previewRows.length;

  return (
    <div className="mx-3 mb-2.5 mt-2.5 rounded-lg border border-border bg-card px-3 py-2.5 shadow-soft-sm">
      <div className="flex items-start gap-2">
        <FileSpreadsheetIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="flex-1 text-xs font-medium text-foreground">
          가격표 분석 완료 · 품목 {review.total}개
        </p>
        <Button type="button" size="icon-xs" variant="ghost" aria-label="닫기" onClick={onDismiss}>
          <XIcon className="size-3" />
        </Button>
      </div>

      {hasClean && (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground">새 딜로 만들 품목 {review.clean.length}개</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {previewRows.map((row, index) => (
              <li key={index} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-foreground">{rowLabel(row)}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {row.sellingPrice != null
                    ? `₩${row.sellingPrice.toLocaleString("ko-KR")}`
                    : "가격 미상"}
                </span>
              </li>
            ))}
          </ul>
          {overflow > 0 && <p className="mt-0.5 text-xs text-muted-foreground">외 {overflow}개</p>}
        </div>
      )}

      {hasAmbiguous && (
        <p className="mt-2 text-xs text-status-caution-text">
          기존 딜과 비슷해 확인이 필요한 품목 {review.ambiguousCount}개
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-3">
        {canApplyInChat ? (
          <>
            <Button type="button" size="sm" onClick={onApply}>
              새 딜 {review.clean.length}개 반영
            </Button>
            <Link
              href={detailHref}
              className="text-xs font-medium text-primary hover:underline"
            >
              검토 화면에서 먼저 보기
            </Link>
          </>
        ) : (
          <Button asChild size="sm">
            <Link href={detailHref} className="inline-flex items-center gap-1">
              검토 화면에서 확인
              <ExternalLinkIcon className="size-3" />
            </Link>
          </Button>
        )}
      </div>

      {!canApplyInChat && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {hasClean
            ? "확인이 필요한 품목이 있어 검토 화면에서 확정 후 함께 반영하세요."
            : "검토 화면에서 확인 후 반영하세요."}
        </p>
      )}
    </div>
  );
}
