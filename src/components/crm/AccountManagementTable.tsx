"use client";

import * as React from "react";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types (Task 4·5 API 계약 — src/app/api/settings/accounts/*)
// ---------------------------------------------------------------------------

interface CrmAccount {
  id: string;
  email: string;
  displayName: string;
  status: "approved" | "rejected" | "pending";
  role: "admin" | "operator";
  isOwnerFloor: boolean;
  grantedBy: string | null;
  grantedAt: string | null;
  lastSignInAt: string | null;
}

const STATUS_LABEL: Record<CrmAccount["status"], string> = {
  pending: "대기",
  approved: "활성",
  rejected: "거절됨",
};

// P8 색 사용 원칙 §1(심각도 축) — 대기는 오너의 판단이 필요한 소수라 caution,
// 활성은 success, 거절은 이미 처리된 종결 상태라 무채색(중립)으로 내린다.
// 리터럴 색 없이 기존 배지 변형(badge.tsx)만 사용한다.
const STATUS_BADGE_VARIANT: Record<CrmAccount["status"], "status-pending" | "status-success" | "secondary"> = {
  pending: "status-pending",
  approved: "status-success",
  rejected: "secondary",
};

/** 대기 건을 위로 — 오너가 처리해야 할 것이 먼저 보여야 한다. */
const STATUS_ORDER: Record<CrmAccount["status"], number> = {
  pending: 0,
  approved: 1,
  rejected: 2,
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function AccountManagementTable({ currentUserId }: { currentUserId: string }) {
  const [accounts, setAccounts] = React.useState<CrmAccount[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/accounts");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "계정 목록을 불러오지 못했습니다");
      setAccounts(body.accounts);
      setError(null);
    } catch (err) {
      // 빈 목록으로 위장하지 않는다 — 원인을 화면에 남긴다.
      setError(err instanceof Error ? err.message : "계정 목록을 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const mutate = React.useCallback(
    async (id: string, patch: { status?: "approved" | "rejected"; role?: "admin" | "operator" }) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/settings/accounts/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "권한 변경에 실패했습니다");
        setAccounts((prev) => prev.map((item) => (item.id === id ? body.account : item)));
        setError(null);
      } catch (err) {
        // load()의 성공 경로가 setError(null)을 호출하므로, 재조회를 먼저 끝낸 뒤
        // 실패 사유를 다시 세팅한다 — 순서가 바뀌면 서버가 준 구체적 거부 사유
        // (오너 바닥 계정 · 자기 강등 등)가 재조회 성공에 조용히 덮여 사라진다.
        const message = err instanceof Error ? err.message : "권한 변경에 실패했습니다";
        await load();
        setError(message);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const sorted = React.useMemo(
    () => [...accounts].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
    [accounts],
  );

  return (
    <div className="space-y-4">
      {error ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-status-urgent/30 bg-status-urgent-bg px-3 py-2.5 text-xs font-medium text-status-urgent-text"
        >
          <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-border/70 bg-white/60">
        <Table className="min-w-[860px] text-[13px]">
          <TableHeader className="bg-white/90 supports-backdrop-filter:backdrop-blur">
            <TableRow className="border-b border-slate-200 hover:bg-transparent">
              <TableHead className="h-11 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                이름
              </TableHead>
              <TableHead className="h-11 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                이메일
              </TableHead>
              <TableHead className="h-11 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                상태
              </TableHead>
              <TableHead className="h-11 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                역할
              </TableHead>
              <TableHead className="h-11 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                마지막 로그인
              </TableHead>
              <TableHead className="h-11 px-3 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                작업
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i} className="border-b border-slate-200/80 hover:bg-transparent">
                  <TableCell colSpan={6} className="h-14 px-3">
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : sorted.length === 0 && !error ? (
              <TableRow className="border-0 hover:bg-transparent">
                <TableCell colSpan={6} className="h-56">
                  <Empty className="border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <span className="text-xs font-medium">0</span>
                      </EmptyMedia>
                      <EmptyTitle>계정이 없습니다</EmptyTitle>
                      <EmptyDescription>로그인 요청이 들어오면 여기에 표시됩니다.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((account) => (
                <TableRow
                  key={account.id}
                  className="border-b border-slate-200/80 bg-white/60 transition-colors duration-150 hover:bg-white"
                >
                  <TableCell className="h-14 px-3">
                    <span className="block truncate font-medium text-foreground">{account.displayName}</span>
                  </TableCell>
                  <TableCell className="h-14 px-3">
                    <span className="block truncate text-muted-foreground">{account.email}</span>
                  </TableCell>
                  <TableCell className="h-14 px-3">
                    <Badge variant={STATUS_BADGE_VARIANT[account.status]} className="rounded-2xl px-2.5 font-medium shadow-none">
                      {STATUS_LABEL[account.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="h-14 px-3">
                    <span className="text-muted-foreground">
                      {account.status === "approved" ? (account.role === "admin" ? "admin" : "operator") : "—"}
                    </span>
                  </TableCell>
                  <TableCell className="h-14 px-3">
                    <span className="font-mono text-[13px] text-muted-foreground">
                      {formatDate(account.lastSignInAt)}
                    </span>
                  </TableCell>
                  <TableCell className="h-14 px-3">
                    <AccountRowActions
                      account={account}
                      isSelf={currentUserId !== "" && account.id === currentUserId}
                      busy={busyId === account.id}
                      onMutate={mutate}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

function AccountRowActions({
  account,
  isSelf,
  busy,
  onMutate,
}: {
  account: CrmAccount;
  isSelf: boolean;
  busy: boolean;
  onMutate: (id: string, patch: { status?: "approved" | "rejected"; role?: "admin" | "operator" }) => Promise<void>;
}) {
  if (account.isOwnerFloor) {
    return <span className="block text-right text-xs text-muted-foreground">오너</span>;
  }

  // 서버(Task 5)가 자기 강등·자기 회수를 거부한다 — 여기서는 오너 바닥 행과 같은 방식으로
  // "눌러도 무조건 실패하는 버튼"을 아예 보여주지 않는다(설계 문서: UI 비활성 + 서버 거부
  // 두 겹). pending 상태의 자기 행은 이 화면에 실질 도달하지 않으므로(대기 계정은 로그인
  // 자체가 막혀 있다) 별도 분기를 만들지 않는다(YAGNI).
  if (isSelf) {
    return <span className="block text-right text-xs text-muted-foreground">본인</span>;
  }

  const busyIcon = busy ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null;

  if (account.status === "pending") {
    return (
      <div className="flex justify-end gap-1.5">
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => onMutate(account.id, { status: "approved", role: "admin" })}
        >
          {busyIcon}
          admin 승인
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => onMutate(account.id, { status: "approved", role: "operator" })}
        >
          {busyIcon}
          operator 승인
        </Button>
        <Button
          variant="destructive"
          size="xs"
          disabled={busy}
          onClick={() => onMutate(account.id, { status: "rejected" })}
        >
          {busyIcon}
          거절
        </Button>
      </div>
    );
  }

  if (account.status === "approved") {
    return (
      <div className="flex justify-end gap-1.5">
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() =>
            onMutate(account.id, { role: account.role === "admin" ? "operator" : "admin" })
          }
        >
          {busyIcon}
          {account.role === "admin" ? "operator 로 변경" : "admin 으로 변경"}
        </Button>
        <Button
          variant="destructive"
          size="xs"
          disabled={busy}
          onClick={() => onMutate(account.id, { status: "rejected" })}
        >
          {busyIcon}
          접근 회수
        </Button>
      </div>
    );
  }

  // rejected
  return (
    <div className={cn("flex justify-end")}>
      <Button
        variant="outline"
        size="xs"
        disabled={busy}
        onClick={() => onMutate(account.id, { status: "approved", role: "operator" })}
      >
        {busyIcon}
        다시 승인
      </Button>
    </div>
  );
}
