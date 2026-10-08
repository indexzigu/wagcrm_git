"use client";

import * as React from "react";
import Link from "next/link";
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
import { Button } from "@/components/ui/button";
import type { BulkApproveResponse } from "@/lib/action-proposal-bulk";
import { PendingCard } from "./approval-cards";
import type { ApprovalInboxItem } from "./approval-cards";
import type { BulkApproveFn } from "./approval-hub-types";
import { ACTION_LABELS } from "./proposal-card";
import { EmptyState, LoadErrorState, LoadMoreButton } from "./hub-states";

/**
 * 결재함 대기 탭 — 선택한 기안을 한 번에 승인한다.
 *
 * 이 화면이 돕는 판단: 봇이 하루 동안 올린 쓰기 기안을 운영자가 **하루 한 번 훑고 한 번에
 * 승인**한다(쓰기는 자동 실행하지 않는다 — 승인이 유일한 실행 경로다). 그래서 확인 창은
 * 「몇 건」이 아니라 **무엇이 몇 건**(메모 추가 3건, 거래처 등록 1건)을 보여 준다 — 종류를
 * 보고 나서야 「이걸 다 눌러도 되나」를 판단할 수 있다.
 *
 * 흐름은 확인 창 하나 안에서 세 단계로 이어진다: 확인 → 진행 → 결과. 진행 중에는 창이
 * 닫히지 않는다(화면 뒤의 단건 버튼도 그동안 눌리지 않는다 — 같은 기안을 두 경로로 누르는
 * 일은 서버 CAS 가 막지만, 결과 요약이 실제와 어긋나는 것을 화면에서도 막는다).
 *
 * 성공 토스트를 따로 띄우지 않는다 — 결과 요약이 이 액션의 유일한 피드백이다(P2 Toast
 * Ownership).
 */

const SETTLEMENT_ACTION = "confirm_settlement";

type Phase =
  | { kind: "idle" }
  | { kind: "confirm"; items: ApprovalInboxItem[] }
  | { kind: "running"; items: ApprovalInboxItem[]; done: number }
  | { kind: "done"; items: ApprovalInboxItem[]; response: BulkApproveResponse | null; error: string | null };

function actionLabel(item: ApprovalInboxItem): string {
  const action = item.payload?.action;
  if (!action) return "알 수 없는 액션";
  return ACTION_LABELS[action] ?? action;
}

/** 확인 창의 「무엇이 몇 건」 — 많은 순, 같으면 라벨 순. */
export function summarizeByAction(items: readonly ApprovalInboxItem[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = actionLabel(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ko"));
}

/** 「현재 페이지 전체 선택」 — 일부만 고르면 체크박스가 반쯤 찬 상태(indeterminate)가 된다. */
function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
  total,
  hasMore,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: (checked: boolean) => void;
  total: number;
  /** 아직 안 불러온 기안이 더 있다 — 「전체」가 대기 전부가 아님을 알린다. */
  hasMore: boolean;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="flex min-h-6 cursor-pointer items-center gap-2 text-xs text-foreground">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 cursor-pointer rounded border-slate-300 text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      />
      현재 페이지 전체 선택
      <span className="tabular-nums text-muted-foreground">
        ({total}건{hasMore ? " · 아래에 더 있음" : ""})
      </span>
    </label>
  );
}

function ResultList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; label: string; reason: string }>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{title}</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="text-xs">
            <span className="text-foreground">{row.label}</span>
            <span className="text-muted-foreground"> · {row.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BulkResultSummary({
  items,
  response,
  error,
  onNavigate,
}: {
  items: readonly ApprovalInboxItem[];
  response: BulkApproveResponse | null;
  error: string | null;
  onNavigate: () => void;
}) {
  if (!response) {
    return (
      <p role="alert" className="text-sm text-status-urgent-text">
        {error ?? "일괄 승인을 마치지 못했습니다."} 목록에서 각 기안의 상태를 확인해 주세요.
      </p>
    );
  }
  const titleById = new Map(items.map((item) => [item.id, item.title]));
  const rowsOf = (outcome: "failed" | "skipped") =>
    response.results
      .filter((result) => result.outcome === outcome)
      .map((result) => ({
        id: result.id,
        label: titleById.get(result.id) ?? result.id,
        reason: result.error ?? "사유 없음",
      }));
  const failedRows = rowsOf("failed");
  const skippedRows = rowsOf("skipped");
  // 실행은 됐지만 후속 처리(캐시·캘린더)가 어긋난 건 — 실패가 아니므로 따로 알린다.
  const warningRows = response.results
    .filter((result) => result.outcome === "executed" && result.error)
    .map((result) => ({
      id: result.id,
      label: titleById.get(result.id) ?? result.id,
      reason: result.error as string,
    }));
  const { executed, failed, skipped } = response.counts;

  return (
    <div className="space-y-3">
      <p role="status" className="text-sm text-foreground">
        승인·실행 <span className="font-semibold tabular-nums">{executed}</span>건 · 실패{" "}
        <span className={failed > 0 ? "font-semibold tabular-nums text-status-urgent-text" : "tabular-nums"}>
          {failed}
        </span>
        건 · 건너뜀 <span className="tabular-nums">{skipped}</span>건
      </p>
      {/* 사유 목록은 한 스크롤 영역에 모은다 — 목록마다 높이 상한을 따로 두면 창 높이가
          건수 조합마다 들쭉날쭉해진다(P8 Layout Stability). */}
      {failedRows.length + skippedRows.length + warningRows.length > 0 && (
        <div className="max-h-64 space-y-3 overflow-y-auto [scrollbar-gutter:stable]">
          <ResultList title="실패" rows={failedRows} />
          <ResultList title="건너뜀" rows={skippedRows} />
          <ResultList title="승인·실행됨 · 확인 필요" rows={warningRows} />
        </div>
      )}
      {failed > 0 && (
        <p className="text-xs text-muted-foreground">
          실패한 기안은{" "}
          <Link
            href="/approvals?tab=failed"
            onClick={onNavigate}
            className="text-foreground underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            실패 탭
          </Link>
          에서 다시 시도할 수 있습니다.
        </p>
      )}
    </div>
  );
}

function BulkApproveDialog({
  phase,
  onCancel,
  onConfirm,
  onClose,
}: {
  phase: Phase;
  onCancel: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const open = phase.kind !== "idle";
  const running = phase.kind === "running";
  const items = phase.kind === "idle" ? [] : phase.items;
  const settlements = items.filter((item) => item.payload?.action === SETTLEMENT_ACTION);

  // 단계가 바뀌면 누른 버튼이 사라진다 — 초점을 새 단계의 기준점으로 옮긴다. `autoFocus` 가
  // 아니라 effect 인 이유: 포커스 트랩(radix FocusScope)이 사라진 초점을 창 루트로 돌리는
  // 처리가 커밋 직후 마이크로태스크에서 돌아 `autoFocus` 를 덮어쓴다(테스트로 확인).
  const progressRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (phase.kind === "running") progressRef.current?.focus();
    if (phase.kind === "done") closeRef.current?.focus();
  }, [phase.kind]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // 진행 중에는 닫지 않는다(Esc·바깥 클릭 무시) — 요청은 이미 나갔다.
        if (next || running) return;
        if (phase.kind === "done") onClose();
        else onCancel();
      }}
    >
      <AlertDialogContent
        className="data-[size=default]:sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (running) event.preventDefault();
        }}
      >
        {phase.kind === "confirm" && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>선택한 기안 {items.length}건 승인</AlertDialogTitle>
              <AlertDialogDescription>
                승인하면 바로 실행되어 CRM 데이터가 바뀝니다. 목록에 보이는 순서대로 한 건씩 실행합니다.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul aria-label="승인할 기안 종류" className="space-y-1 text-sm">
              {summarizeByAction(items).map((row) => (
                <li key={row.label} className="flex items-baseline justify-between gap-3">
                  <span className="text-foreground">{row.label}</span>
                  <span className="tabular-nums text-muted-foreground">{row.count}건</span>
                </li>
              ))}
            </ul>
            {settlements.length > 0 && (
              // 단건 대기 카드의 승인은 정산 확정에도 따로 묻지 않으므로 이 창이 유일한 안전장치다 —
              // 건수만이 아니라 **어느 건인지** 보여 준다. 색만으로 말하지 않도록 테두리 상자에 싣는다.
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-status-urgent-text">
                <p className="font-medium">
                  정산 확정 {settlements.length}건이 포함돼 있습니다. 정산 확정은 되돌릴 수 없습니다.
                </p>
                <ul className="mt-1 list-inside list-disc">
                  {settlements.map((item) => (
                    <li key={item.id}>{item.title}</li>
                  ))}
                </ul>
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>취소</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  onConfirm();
                }}
              >
                {items.length}건 승인
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}

        {phase.kind === "running" && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>승인하는 중</AlertDialogTitle>
              <AlertDialogDescription>
                끝날 때까지 이 탭을 닫거나 새로고침하지 마세요. 한 건이 실패해도 나머지는 계속 처리합니다.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* 누른 「N건 승인」 버튼이 이 단계에서 사라지므로 초점을 여기로 옮긴다(위 effect). */}
            <div ref={progressRef} tabIndex={-1} className="space-y-1.5 focus:outline-none">
              <div
                role="progressbar"
                aria-label="일괄 승인 진행"
                aria-valuemin={0}
                aria-valuemax={items.length}
                aria-valuenow={phase.done}
                aria-valuetext={`${items.length}건 중 ${phase.done}건 처리`}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary motion-safe:transition-[width] motion-safe:duration-150"
                  style={{ width: `${items.length === 0 ? 0 : (phase.done / items.length) * 100}%` }}
                />
              </div>
              <p className="text-xs tabular-nums text-muted-foreground">
                {items.length}건 중 {phase.done}건 처리
              </p>
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>일괄 승인 결과</AlertDialogTitle>
              {phase.response && (
                <AlertDialogDescription>승인·실행된 기안과 실패한 기안은 대기 목록에서 빠집니다.</AlertDialogDescription>
              )}
            </AlertDialogHeader>
            <BulkResultSummary
              items={phase.items}
              response={phase.response}
              error={phase.error}
              onNavigate={onClose}
            />
            <AlertDialogFooter>
              <AlertDialogAction ref={closeRef} onClick={onClose}>
                닫기
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function PendingBulkList({
  items,
  approve,
  reject,
  approveMany,
  hasMore,
  loadMore,
  isLoadingMore,
  isError,
  onRetry,
  emptyMessage,
}: {
  items: ApprovalInboxItem[];
  approve: (id: string) => Promise<unknown>;
  reject: (id: string) => Promise<unknown>;
  approveMany: BulkApproveFn;
  hasMore: boolean;
  loadMore: () => unknown;
  isLoadingMore: boolean;
  isError: boolean;
  onRetry: () => void;
  emptyMessage: string;
}) {
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });

  // 선택은 **보이는 목록 기준**으로만 센다 — 30초 폴링으로 다른 곳에서 처리된 기안이 목록에서
  // 빠지면, 화면에 없는 기안이 「N건」에 남아 보이지 않는 것을 승인하게 된다.
  const selectedItems = React.useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds]
  );
  const selectedCount = selectedItems.length;
  const allSelected = items.length > 0 && selectedCount === items.length;

  const toggleOne = React.useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleAll = React.useCallback(
    (checked: boolean) => {
      setSelectedIds(checked ? new Set(items.map((item) => item.id)) : new Set());
    },
    [items]
  );

  const handleConfirm = async () => {
    if (phase.kind !== "confirm") return;
    // 고른 순서 = 화면 순서. 실행도 이 순서대로 한다.
    const batch = phase.items;
    setPhase({ kind: "running", items: batch, done: 0 });
    try {
      const response = await approveMany(
        batch.map((item) => item.id),
        {
          onProgress: (done) => setPhase({ kind: "running", items: batch, done }),
        }
      );
      setPhase({ kind: "done", items: batch, response, error: null });
    } catch (err) {
      setPhase({
        kind: "done",
        items: batch,
        response: null,
        error: err instanceof Error ? err.message : "일괄 승인 중 오류가 발생했습니다.",
      });
    }
  };

  // 진행 중에 탭을 닫거나 새로고침하면 남은 묶음이 안 나간다 — 브라우저 확인 창으로 한 번 막는다.
  const running = phase.kind === "running";
  React.useEffect(() => {
    if (!running) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [running]);

  const handleClose = () => {
    setPhase({ kind: "idle" });
    setSelectedIds(new Set());
  };

  // ⚠️ 빈 목록·오류 화면도 이 컴포넌트 **안에서** 그린다. 승인이 끝나 고른 기안이 전부 대기에서
  // 빠지면 목록이 비는데, 그때 상위가 빈 화면으로 갈아끼우면 결과 창까지 함께 사라진다(창 상태가
  // 이 컴포넌트에 있다). 그래서 창은 어떤 본문을 그리든 늘 붙어 있다.
  let body: React.ReactNode;
  if (isError) {
    body = <LoadErrorState onRetry={onRetry} />;
  } else if (items.length === 0) {
    body = <EmptyState message={emptyMessage} />;
  } else {
    body = (
      <>
        {/* 도구 줄은 선택이 0건이어도 늘 그리고(목록이 밀리지 않게, P8 Layout Stability), 긴 목록을
            내려가며 고를 때도 버튼이 보이도록 위에 붙인다. 버튼 글자 폭이 숫자 자릿수로 흔들리지
            않게 최소 폭을 준다. */}
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted px-3 py-2 shadow-soft-md">
          <SelectAllCheckbox
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            onChange={toggleAll}
            total={items.length}
            hasMore={hasMore}
          />
          <Button
            size="sm"
            className="min-w-32 tabular-nums"
            disabled={selectedCount === 0}
            onClick={() => setPhase({ kind: "confirm", items: selectedItems })}
          >
            선택한 {selectedCount}건 승인
          </Button>
        </div>

        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <PendingCard
              key={item.id}
              item={item}
              onApprove={approve}
              onReject={reject}
              selection={{
                checked: selectedIds.has(item.id),
                onCheckedChange: (checked) => toggleOne(item.id, checked),
              }}
            />
          ))}
        </ul>
        {hasMore && <LoadMoreButton onClick={() => loadMore()} disabled={isLoadingMore} />}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {body}

      <BulkApproveDialog
        phase={phase}
        onCancel={() => setPhase({ kind: "idle" })}
        onConfirm={() => void handleConfirm()}
        onClose={handleClose}
      />
    </div>
  );
}
