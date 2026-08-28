"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  CheckIcon,
  ClapperboardIcon,
  ExternalLinkIcon,
  FolderPlusIcon,
  ImageIcon,
  InboxIcon,
  Loader2Icon,
  PlayIcon,
  UserRoundIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { CrmShell } from "@/components/crm/crm-shell";
import { Button } from "@/components/ui/button";
import { DataEmpty } from "@/components/ui/empty";
import { SearchableDropdown } from "@/components/crm/searchable-dropdown";
import { EntityIdentity } from "@/components/crm/entity-identity";
import { getDealContextParts } from "@/lib/deal-display";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  classifyInstagramUrl,
  formatKoreanCount,
  formatRelativeKo,
} from "@/lib/reference-kind";
import { cn } from "@/lib/utils";

type InboxItem = {
  id: string;
  rawUrl: string;
  normalizedUrl: string;
  linkName: string;
  source: string;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  igUsername: string | null;
  igProfilePicUrl: string | null;
  igFullName: string | null;
  igBio: string | null;
  igFollowerCount: number | null;
  igPostCount: number | null;
  note: string | null;
  status: string;
  createdAt: string;
};

type DealOption = {
  id: string;
  dealName: string;
  brandName?: string;
  partnerName: string;
};

type BusyAction = "assign" | "dismiss";

type AssignTarget = { kind: "single"; item: InboxItem } | { kind: "bulk" };

export function ReferenceInboxClient() {
  const [items, setItems] = React.useState<InboxItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [text, setText] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [busyMap, setBusyMap] = React.useState<Record<string, BusyAction>>({});

  // 딜 배정 다이얼로그 + 서버 검색 상태
  const [assignTarget, setAssignTarget] = React.useState<AssignTarget | null>(null);
  const [deals, setDeals] = React.useState<DealOption[]>([]);
  const [dealSearching, setDealSearching] = React.useState(false);
  const recentDealsRef = React.useRef<DealOption[]>([]);
  const dealDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dealFetchSeqRef = React.useRef(0);

  // 다중 선택
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkDismissOpen, setBulkDismissOpen] = React.useState(false);

  const setBusy = React.useCallback((id: string, action: BusyAction | null) => {
    setBusyMap((prev) => {
      const next = { ...prev };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  }, []);

  const loadItems = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/reference-inbox?status=PENDING");
      if (!res.ok) throw new Error("목록을 불러오지 못했습니다.");
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "목록을 불러오지 못했습니다.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadItems();
  }, [loadItems]);

  // in-flight 딜 검색 응답을 무효화한다(언마운트·다이얼로그 닫힘 시 setState 방지).
  const invalidateDealFetch = React.useCallback(() => {
    dealFetchSeqRef.current++;
  }, []);

  // 최근 딜 목록(검색어 없음 기본 화면) — 다이얼로그가 닫혔다 열려도 재사용.
  React.useEffect(() => {
    const seq = ++dealFetchSeqRef.current;
    fetch("/api/search/deals")
      .then((res) => res.json())
      .then((data) => {
        const results = Array.isArray(data.results) ? data.results : [];
        recentDealsRef.current = results;
        if (seq === dealFetchSeqRef.current) setDeals(results);
      })
      .catch(() => {
        if (seq === dealFetchSeqRef.current) setDeals([]);
      });
    return () => {
      if (dealDebounceRef.current) clearTimeout(dealDebounceRef.current);
      // 언마운트 후 도착하는 in-flight 응답이 setState하지 않도록 seq를 무효화한다.
      invalidateDealFetch();
    };
  }, [invalidateDealFetch]);

  // 딜 서버 검색(디바운스 300ms) — 최근 20건 클라 필터의 한계를 해소한다.
  // 2자 미만은 서버 규칙(q.length < 2 → 빈 결과)과 맞춰 최근 목록으로 복귀.
  const handleDealSearchChange = React.useCallback((query: string) => {
    if (dealDebounceRef.current) clearTimeout(dealDebounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      dealFetchSeqRef.current++;
      setDealSearching(false);
      setDeals(recentDealsRef.current);
      return;
    }
    setDealSearching(true);
    dealDebounceRef.current = setTimeout(async () => {
      const seq = ++dealFetchSeqRef.current;
      try {
        const res = await fetch(`/api/search/deals?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) throw new Error("검색 실패");
        const data = await res.json();
        if (seq !== dealFetchSeqRef.current) return;
        setDeals(Array.isArray(data.results) ? data.results : []);
      } catch {
        if (seq === dealFetchSeqRef.current) setDeals([]);
      } finally {
        if (seq === dealFetchSeqRef.current) setDealSearching(false);
      }
    }, 300);
  }, []);

  const closeAssignDialog = React.useCallback(() => {
    setAssignTarget(null);
    if (dealDebounceRef.current) clearTimeout(dealDebounceRef.current);
    dealFetchSeqRef.current++;
    setDealSearching(false);
    setDeals(recentDealsRef.current);
  }, []);

  const handleAdd = React.useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      toast.error("추가할 URL을 입력하세요.");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/reference-inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.formErrors?.[0] ?? "추가에 실패했습니다.");
      }
      const added: number = data.added ?? 0;
      const skipped: number = data.skipped ?? 0;
      const invalid: number = data.invalid ?? 0;
      const parts = [`${added}개 추가`];
      if (skipped > 0) parts.push(`${skipped}개 중복`);
      if (invalid > 0) parts.push(`${invalid}개 무효`);
      const message = parts.join(", ");
      if (added > 0) {
        toast.success(message);
        setText("");
        const newItems: InboxItem[] = Array.isArray(data.items) ? data.items : [];
        setItems((prev) => [...newItems, ...prev]);
      } else {
        toast.warning(message);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "추가에 실패했습니다.");
    } finally {
      setAdding(false);
    }
  }, [text]);

  const removeFromSelection = React.useCallback((ids: Iterable<string>) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const assignOne = React.useCallback(async (item: InboxItem, dealId: string) => {
    const res = await fetch(`/api/reference-inbox/${item.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error ?? "배정에 실패했습니다.");
    }
    return Boolean(data?.alreadyExists);
  }, []);

  const handleAssign = React.useCallback(
    async (item: InboxItem, dealId: string) => {
      setBusy(item.id, "assign");
      closeAssignDialog();
      try {
        const alreadyExists = await assignOne(item, dealId);
        toast.success(
          alreadyExists ? "이미 등록된 자료라 인박스에서 정리했습니다." : "딜 자료로 배정했습니다.",
        );
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        removeFromSelection([item.id]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "배정에 실패했습니다.");
      } finally {
        setBusy(item.id, null);
      }
    },
    [assignOne, closeAssignDialog, removeFromSelection, setBusy],
  );

  const handleBulkAssign = React.useCallback(
    async (dealId: string) => {
      const targets = items.filter((i) => selected.has(i.id));
      closeAssignDialog();
      if (targets.length === 0) return;
      setBulkBusy(true);
      try {
        const results = await Promise.allSettled(
          targets.map(async (item) => {
            await assignOne(item, dealId);
            return item.id;
          }),
        );
        const okIds = new Set(
          results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
            .map((r) => r.value),
        );
        const failedCount = results.length - okIds.size;
        setItems((prev) => prev.filter((i) => !okIds.has(i.id)));
        removeFromSelection(okIds);
        if (failedCount === 0) {
          toast.success(`${okIds.size}건을 딜 자료로 배정했습니다.`);
        } else if (okIds.size === 0) {
          toast.error(`배정에 실패했습니다. (${failedCount}건)`);
        } else {
          toast.warning(`${okIds.size}건 배정, ${failedCount}건은 실패했습니다.`);
        }
      } finally {
        setBulkBusy(false);
      }
    },
    [assignOne, closeAssignDialog, items, removeFromSelection, selected],
  );

  const restoreItem = React.useCallback(async (item: InboxItem) => {
    try {
      const res = await fetch(`/api/reference-inbox/${item.id}/restore`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "복원에 실패했습니다.");
      }
      // 서버가 돌려준 최신 행 우선 — 기각~복원 사이 크론 보강분을 잃지 않는다.
      const restored: InboxItem = data?.item ?? item;
      setItems((prev) =>
        [...prev.filter((i) => i.id !== restored.id), restored].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      );
      toast.success("기각을 취소했습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "복원에 실패했습니다.");
    }
  }, []);

  const handleDismiss = React.useCallback(
    async (item: InboxItem) => {
      setBusy(item.id, "dismiss");
      try {
        const res = await fetch(`/api/reference-inbox/${item.id}`, { method: "DELETE" });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error ?? "기각에 실패했습니다.");
        }
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        removeFromSelection([item.id]);
        // 확인창 대신 실행 취소(소프트 기각이라 상태 복원으로 되돌림).
        toast("기각했습니다.", {
          duration: 5000,
          action: {
            label: "실행 취소",
            onClick: () => void restoreItem(item),
          },
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "기각에 실패했습니다.");
      } finally {
        setBusy(item.id, null);
      }
    },
    [removeFromSelection, restoreItem, setBusy],
  );

  const handleBulkDismiss = React.useCallback(async () => {
    const targets = items.filter((i) => selected.has(i.id));
    setBulkDismissOpen(false);
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        targets.map(async (item) => {
          const res = await fetch(`/api/reference-inbox/${item.id}`, { method: "DELETE" });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new Error(data?.error ?? "기각 실패");
          }
          return item.id;
        }),
      );
      const okIds = new Set(
        results
          .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
          .map((r) => r.value),
      );
      const failedCount = results.length - okIds.size;
      setItems((prev) => prev.filter((i) => !okIds.has(i.id)));
      removeFromSelection(okIds);
      if (failedCount === 0) {
        toast.success(`${okIds.size}건을 기각했습니다.`);
      } else if (okIds.size === 0) {
        toast.error(`기각에 실패했습니다. (${failedCount}건)`);
      } else {
        toast.warning(`${okIds.size}건 기각, ${failedCount}건은 실패했습니다.`);
      }
    } finally {
      setBulkBusy(false);
    }
  }, [items, removeFromSelection, selected]);

  const toggleSelect = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 선택된 카드들과 같은 계정(igUsername)의 화면 내 모든 카드를 선택에 추가.
  const selectSameAccounts = React.useCallback(() => {
    const accounts = new Set(
      items
        .filter((i) => selected.has(i.id) && i.igUsername)
        .map((i) => i.igUsername as string),
    );
    if (accounts.size === 0) {
      toast.warning("선택한 항목에 계정 정보가 없습니다.");
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of items) {
        if (item.igUsername && accounts.has(item.igUsername)) next.add(item.id);
      }
      return next;
    });
  }, [items, selected]);

  const openAssign = React.useCallback((item: InboxItem) => {
    setAssignTarget({ kind: "single", item });
  }, []);

  const dismissItem = React.useCallback(
    (item: InboxItem) => {
      void handleDismiss(item);
    },
    [handleDismiss],
  );

  const anySelected = selected.size > 0;

  return (
    <TooltipProvider delayDuration={300}>
      <CrmShell
        title={
          <div className="flex flex-col gap-1">
            <Link
              href="/assets"
              className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3.5" />
              자료 목록
            </Link>
            <span>미분류 레퍼런스</span>
          </div>
        }
        description="수집한 인스타/틱톡/유튜브 링크를 딜에 배정하거나 기각합니다."
      >
        <div className="flex flex-col gap-6 p-6 md:p-8">
          {/* 상단 일괄 추가 입력 */}
          <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/90 p-5 shadow-soft-md">
            <div className="flex items-center gap-2">
              <InboxIcon className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">링크 일괄 추가</h2>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder="인스타/틱톡/유튜브 URL을 줄바꿈으로 여러 개 붙여넣기"
              className="w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground shadow-soft-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-focus-ring"
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                자동 수집된 링크 외에 직접 추가할 수 있습니다.
              </p>
              <Button size="sm" onClick={() => void handleAdd()} disabled={adding}>
                {adding ? (
                  <span className="flex items-center gap-1">
                    <Loader2Icon className="size-3.5 animate-spin" /> 추가 중
                  </span>
                ) : (
                  "추가"
                )}
              </Button>
            </div>
          </div>

          {/* 그리드 피드 영역 */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                수집된 레퍼런스 썸네일 피드 ({items.length}건)
              </h2>
            </div>

            {loading ? (
              <div className="stagger-fade-in grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {Array.from({ length: 5 }, (_, i) => (
                  <div
                    key={i}
                    className="flex flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-soft-md"
                  >
                    <div className="aspect-[4/5] w-full animate-pulse bg-muted" />
                    <div className="flex flex-col gap-1.5 p-3">
                      <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
                      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <DataEmpty
                icon={InboxIcon}
                title="미분류 레퍼런스가 없습니다."
                className="rounded-2xl py-24"
              />
            ) : (
              <div className="stagger-fade-in grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {items.map((item) => (
                  <InboxCard
                    key={item.id}
                    item={item}
                    busyAction={busyMap[item.id] ?? null}
                    selected={selected.has(item.id)}
                    selectionActive={anySelected}
                    disableActions={bulkBusy}
                    onToggleSelect={toggleSelect}
                    onOpenAssign={openAssign}
                    onDismiss={dismissItem}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 다중 선택 액션 바 */}
        {anySelected && (
          <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
            <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-xl border border-border/70 bg-card px-4 py-2.5 shadow-soft-lg">
              <span className="mr-1 text-sm font-bold tabular-nums text-foreground">
                <span className="text-primary">{selected.size}</span>건 선택
              </span>
              <Button variant="ghost" size="sm" onClick={selectSameAccounts} disabled={bulkBusy}>
                같은 계정 모두 선택
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set())}
                disabled={bulkBusy}
              >
                선택 해제
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setBulkDismissOpen(true)}
                disabled={bulkBusy}
              >
                <XIcon className="size-3.5" />
                기각
              </Button>
              <Button size="sm" onClick={() => setAssignTarget({ kind: "bulk" })} disabled={bulkBusy}>
                {bulkBusy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <FolderPlusIcon className="size-3.5" />
                )}
                딜 배정
              </Button>
            </div>
          </div>
        )}

        {/* 딜 배정 다이얼로그 (단건/일괄 공용) */}
        <Dialog open={!!assignTarget} onOpenChange={(o) => !o && closeAssignDialog()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {assignTarget?.kind === "bulk"
                  ? `${selected.size}건을 딜에 배정하기`
                  : "딜에 배정하기"}
              </DialogTitle>
              <DialogDescription>
                {assignTarget?.kind === "bulk"
                  ? "선택한 레퍼런스들을 어느 딜의 자료로 귀속시킬지 선택하세요."
                  : "선택한 레퍼런스를 어느 딜의 자료로 귀속시킬지 선택하세요."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-[160px] flex-col justify-start py-4">
              <SearchableDropdown
                items={deals}
                value={null}
                disabled={false}
                getSearchableText={(deal) =>
                  `${deal.dealName} ${deal.brandName ?? ""} ${deal.partnerName}`
                }
                getLabel={(deal) => {
                  // 브랜드·거래처 표기는 getDealContextParts 가 정본이다(브랜드사 =
                  // 거래처인 딜이 흔해서 같은 이름을 두 번 적지 않게 접어준다).
                  // 시각 문법은 검색형 Dialog 선례 LinkSearchDialog 와 같은
                  // EntityIdentity — 드롭다운 행이라 compact 변형을 쓴다.
                  const context = getDealContextParts({
                    brandName: deal.brandName ?? null,
                    partnerName: deal.partnerName,
                  });
                  return (
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">
                        {deal.dealName}
                      </div>
                      {context.length > 0 ? (
                        <EntityIdentity
                          parts={context}
                          variant="compact"
                          className="mt-0.5 gap-x-2 gap-y-0.5"
                        />
                      ) : null}
                    </div>
                  );
                }}
                getValue={(deal) => deal.id}
                placeholder="검색하여 딜 선택..."
                emptyMessage="검색 결과 없음"
                /* Dialog 안이므로 포털 금지 — 포털하면 목록이 스크롤되지 않는다.
                   근거는 ui/popover.tsx 의 portal prop 주석. */
                portal={false}
                onSearchChange={handleDealSearchChange}
                searching={dealSearching}
                onValueChange={(dealId) => {
                  if (!assignTarget) return;
                  if (assignTarget.kind === "single") {
                    void handleAssign(assignTarget.item, dealId);
                  } else {
                    void handleBulkAssign(dealId);
                  }
                }}
              />
            </div>
          </DialogContent>
        </Dialog>

        {/* 일괄 기각 확인 */}
        <AlertDialog open={bulkDismissOpen} onOpenChange={setBulkDismissOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{selected.size}건을 기각할까요?</AlertDialogTitle>
              <AlertDialogDescription>
                선택한 레퍼런스를 인박스에서 정리합니다. 같은 링크가 다시 수집되면 중복으로
                걸러집니다.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>취소</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void handleBulkDismiss()}>
                기각
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CrmShell>
    </TooltipProvider>
  );
}

/** 아이콘 액션 버튼 1개(툴팁 포함). busy면 스피너로 치환. */
function CardActionButton({
  label,
  busy,
  disabled,
  destructive,
  primary,
  onClick,
  children,
}: {
  label: string;
  busy?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  primary?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "text-muted-foreground",
            primary && "text-primary hover:bg-primary/10 hover:text-primary",
            destructive && "hover:bg-destructive/10 hover:text-destructive",
          )}
        >
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// 선택 토글 시 그리드 전체 리렌더를 막기 위해 memo — 콜백은 부모에서 안정화되어 내려온다.
const InboxCard = React.memo(function InboxCard({
  item,
  busyAction,
  selected,
  selectionActive,
  disableActions,
  onToggleSelect,
  onOpenAssign,
  onDismiss,
}: {
  item: InboxItem;
  busyAction: BusyAction | null;
  selected: boolean;
  selectionActive: boolean;
  disableActions: boolean;
  onToggleSelect: (id: string) => void;
  onOpenAssign: (item: InboxItem) => void;
  onDismiss: (item: InboxItem) => void;
}) {
  const [isHovered, setIsHovered] = React.useState(false);
  // 릴스 미리보기는 모션이므로 reduced-motion 설정을 존중한다(마운트 시 1회 판정).
  const prefersReducedMotion = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const kind = classifyInstagramUrl(item.normalizedUrl);
  // 프로필류는 계정 정보가 보강된 뒤에만 프로필 비주얼을 쓴다(그 전엔 수집 대기).
  const isProfileVisual =
    (kind === "PROFILE" || kind === "PROFILE_REELS") && Boolean(item.igUsername);
  const busy = busyAction !== null;
  const pending = !item.thumbnailUrl && !isProfileVisual;

  // 하단 둘째 줄: 팔로워(아이콘+수치) · 게시물 수(프로필) · 수집 시점. 유형 텍스트는 배지 전담.
  const metaBits: React.ReactNode[] = [];
  if (item.igFollowerCount != null) {
    metaBits.push(
      <span key="followers" className="inline-flex items-center gap-1">
        <UsersIcon className="size-3 shrink-0" role="img" aria-label="팔로워" />
        {formatKoreanCount(item.igFollowerCount)}
      </span>,
    );
  }
  if (kind === "PROFILE" && item.igPostCount != null) {
    metaBits.push(<span key="posts">게시물 {formatKoreanCount(item.igPostCount)}</span>);
  }
  if (pending) {
    metaBits.push(<span key="pending">다음 수집 주기에 채워집니다</span>);
  } else {
    metaBits.push(<span key="time">{formatRelativeKo(item.createdAt)}</span>);
  }

  // 하단 표시명: 계정명 우선. 없으면 URL 파생 텍스트 대신 중립 유형 라벨(승인 시안: URL 텍스트 제거).
  // 비인스타 링크는 호스트 기반 표시명이 유일한 정체성이라 linkName을 유지한다.
  const footerTitle = item.igUsername
    ? `@${item.igUsername}`
    : kind === "POST"
      ? "인스타그램 게시물"
      : kind === "PROFILE"
        ? "인스타그램 프로필"
        : kind === "PROFILE_REELS"
          ? "인스타그램 릴스 피드"
          : item.linkName;

  return (
    <div
      aria-busy={busy}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border bg-card shadow-soft-md transition-shadow hover:shadow-soft-hover",
        selected ? "border-primary/60 ring-2 ring-primary/25" : "border-border/50",
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 다중 선택 체크 (호버·선택·키보드 포커스·선택 모드에서 노출) */}
      <button
        type="button"
        aria-pressed={selected}
        aria-label={selected ? "선택 해제" : "선택"}
        disabled={busy || disableActions}
        onClick={() => onToggleSelect(item.id)}
        className={cn(
          "absolute left-2.5 top-2.5 z-10 flex size-7 items-center justify-center rounded-lg border shadow-soft-sm transition-opacity",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          "disabled:pointer-events-none disabled:opacity-40",
          selected
            ? "border-primary bg-primary text-primary-foreground opacity-100"
            : cn(
                "border-border bg-card/95 text-transparent opacity-0",
                "group-hover:opacity-100 group-focus-within:opacity-100",
                selectionActive && "opacity-100",
              ),
        )}
      >
        <CheckIcon className="size-4" strokeWidth={3} />
      </button>

      {/* 1. 시각 영역 */}
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-muted">
        {isProfileVisual ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-primary/10 via-transparent to-transparent p-5 text-center">
            <span className="relative inline-flex">
              {item.igProfilePicUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.igProfilePicUrl}
                  alt={item.igUsername ?? "프로필"}
                  className="size-20 rounded-full border-2 border-card object-cover shadow-soft-sm"
                />
              ) : (
                <span className="flex size-20 items-center justify-center rounded-full border-2 border-card bg-primary/80 text-2xl font-bold text-primary-foreground shadow-soft-sm">
                  {(item.igUsername ?? item.linkName).replace(/^_+/, "").charAt(0).toUpperCase() || "?"}
                </span>
              )}
              {kind === "PROFILE_REELS" && (
                <span className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full border-2 border-card bg-primary text-primary-foreground">
                  <PlayIcon className="size-2.5 fill-current" />
                </span>
              )}
            </span>
            <div className="min-w-0">
              {item.igFullName && (
                <p className="truncate text-sm font-bold text-foreground">{item.igFullName}</p>
              )}
              <p className="truncate text-xs text-muted-foreground">@{item.igUsername}</p>
            </div>
            {item.igFollowerCount != null && (
              <span className="inline-flex items-baseline gap-1 rounded-full border border-border/60 bg-card px-3 py-1 text-xs text-muted-foreground">
                <b className="text-sm font-bold tabular-nums text-foreground">
                  {formatKoreanCount(item.igFollowerCount)}
                </b>
                팔로워
              </span>
            )}
            {/* 4번째 줄 고정 렌더(리플로우 방지): 프로필=bio, 릴스 피드=유형 라벨 */}
            <div className="flex h-[18px] max-w-[90%] items-center justify-center">
              {kind === "PROFILE_REELS" ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
                  <ClapperboardIcon className="size-3" />
                  릴스 피드
                </span>
              ) : item.igBio ? (
                <span className="truncate text-xs text-muted-foreground">{item.igBio}</span>
              ) : null}
            </div>
          </div>
        ) : item.thumbnailUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.thumbnailUrl}
              alt={item.linkName}
              loading="lazy"
              className="absolute inset-0 size-full object-cover transition-transform duration-500 pointer-fine:group-hover:scale-105 motion-reduce:transition-none motion-reduce:pointer-fine:group-hover:scale-100"
            />
            {/* 릴스 미리보기: 호버 중에만 마운트(프리로드 0) — 카드 수가 늘어도 초기 비용 없음 */}
            {item.videoUrl && isHovered && !prefersReducedMotion && (
              <video
                src={item.videoUrl}
                autoPlay
                muted
                loop
                playsInline
                preload="none"
                className="absolute inset-0 size-full object-cover"
              />
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/60">
            <div className="absolute inset-0 animate-pulse bg-muted" />
            <ImageIcon className="relative size-6 text-muted-foreground/50" />
            <span className="relative text-xs text-muted-foreground">썸네일 수집 대기</span>
          </div>
        )}

        {/* 유형 배지 (우상단) — 프로필 비주얼 카드는 내부 신호(아바타 마크·라벨)가 유형을 전담하므로 생략 */}
        {!isProfileVisual && (kind !== null || item.videoUrl) && (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-[11px] font-semibold text-white backdrop-blur-sm">
            {kind === "PROFILE" ? (
              <>
                <UserRoundIcon className="size-3" />
                프로필
              </>
            ) : kind === "PROFILE_REELS" ? (
              <>
                <ClapperboardIcon className="size-3" />
                릴스 피드
              </>
            ) : item.videoUrl ? (
              <>
                <PlayIcon className="size-2.5 fill-current" />
                릴스
              </>
            ) : (
              <>
                <ImageIcon className="size-3" />
                게시물
              </>
            )}
          </span>
        )}
      </div>

      {/* 2. 하단 정보 + 액션 */}
      <div className="flex items-center gap-1.5 py-1.5 pl-3 pr-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {item.igProfilePicUrl && !isProfileVisual && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.igProfilePicUrl}
                alt={item.igUsername ?? "프로필"}
                className="size-5 shrink-0 rounded-full object-cover"
              />
            )}
            <span className="truncate text-sm font-semibold text-foreground">
              {footerTitle}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1 overflow-hidden whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {metaBits.map((bit, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-muted-foreground/60">·</span>}
                {bit}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon-lg"
                className="text-muted-foreground"
                aria-label="원본 열기"
              >
                <a href={item.normalizedUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon className="size-4" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>원본 열기</TooltipContent>
          </Tooltip>
          <CardActionButton
            label="딜 배정"
            primary
            busy={busyAction === "assign"}
            disabled={busy || disableActions}
            onClick={() => onOpenAssign(item)}
          >
            <FolderPlusIcon className="size-4" />
          </CardActionButton>
          {/* 파괴적 액션은 간격으로 분리해 오클릭 방지 */}
          <div className="ml-2">
            <CardActionButton
              label="기각"
              destructive
              busy={busyAction === "dismiss"}
              disabled={busy || disableActions}
              onClick={() => onDismiss(item)}
            >
              <XIcon className="size-4" />
            </CardActionButton>
          </div>
        </div>
      </div>
    </div>
  );
});
