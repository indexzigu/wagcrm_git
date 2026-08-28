"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, ChevronRight, Pencil, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { formatDateRange } from "@/lib/date-utils";
import { cn } from "@/lib/utils";
import type {
  CampaignGroupDetailRow,
  CampaignGroupMemberRow,
  CampaignGroupRow,
  CampaignRow,
} from "@/lib/crm-types";
import { SubStageBadge } from "./sub-stage-badge";
import {
  dismissSuggestion,
  fetchActiveSuggestions,
  fetchGroupDetail,
  fetchGroupSuggestions,
  formatGroupLabel,
  joinCampaignToGroup,
  removeGroupMember,
  renameGroup,
} from "@/lib/campaign-group-client";

/**
 * CG-1 표면 ⓒ — 사이드패널 "그룹" 섹션 (+ 표면 ⓑ 인라인 합류 배너 호스트).
 *
 * "이 캠페인이 실세계 묶음의 일부인가, 형제는 무엇이고 묶임이 올바른가"를 판단하도록 돕는다.
 * 형제 캠페인 이동 · 공통 기간 확인 · 잘못 묶인 멤버 제외(2인 그룹은 자동 해체 경고) ·
 * 무그룹 캠페인의 합류 제안(날짜 수정 직후) + "그룹으로 묶기" 조합 피커.
 *
 * 불변식: groupId는 campaign-groups 라우트로만 바뀐다(campaign-group-client가 강제).
 * 정산/입금/계산서는 CG-1에서 캠페인별 — 푸터 노트로 정직하게 고지(전파는 CG-2).
 */

type CampaignGroupSectionProps = {
  campaign: CampaignRow;
  /** 형제 멤버로 패널을 스왑. 미제공 시 멤버 행은 조회 전용(이동 없음). */
  onNavigateToCampaign?: (campaignId: string) => void;
  /** 현재 캠페인의 그룹 소속이 바뀌면(합류/제외/해체) 갱신된 행을 상위에 전달(배지·목록 동기화). */
  onGroupMembershipChanged?: (updatedCampaign: CampaignRow) => void;
  /** 날짜 수정 이벤트마다 증가하는 nonce. 값이 바뀔 때만 합류 제안을 재조회(패널 오픈 시엔 조회 안 함). */
  suggestNonce?: number;
};

const SECTION_SHELL =
  "space-y-3 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm";

const ROUND_BADGE =
  "inline-flex shrink-0 items-center rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[9px] font-bold text-indigo-700 select-none";

export function CampaignGroupSection({
  campaign,
  onNavigateToCampaign,
  onGroupMembershipChanged,
  suggestNonce,
}: CampaignGroupSectionProps) {
  const groupId = campaign.groupId ?? null;

  const [detail, setDetail] = useState<CampaignGroupDetailRow | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // 표면 ⓑ 자동 합류 배너(무그룹 + 날짜 수정 직후)
  const [banner, setBanner] = useState<CampaignGroupRow[] | null>(null);

  // 조합 피커(무그룹 "그룹으로 묶기")
  const [pickerOpen, setPickerOpen] = useState(false);

  const [joiningGroupId, setJoiningGroupId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<CampaignGroupMemberRow | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // 그룹 상세 조회(소속일 때). campaign.id를 키로 리마운트하므로 최초 마운트에도 실행.
  useEffect(() => {
    if (!groupId) {
      setDetail(null);
      setDetailError(false);
      setLoadingDetail(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(false);
    fetchGroupDetail(groupId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {
        if (!cancelled) setDetailError(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, reloadNonce]);

  // 표면 ⓑ — 날짜 수정 이벤트 직후에만 합류 후보 조회(무그룹 한정, 세션 억제 적용).
  useEffect(() => {
    if (!suggestNonce) return; // 0/undefined = 패널 오픈. 이벤트 없이는 조회 안 함.
    if (groupId) return; // 이미 그룹 소속이면 합류 제안 없음(병합 미지원).
    let cancelled = false;
    fetchActiveSuggestions({
      sellerId: campaign.sellerId,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      excludeCampaignId: campaign.id,
    })
      .then((groups) => {
        if (!cancelled) setBanner(groups.length > 0 ? groups : null);
      })
      .catch(() => {
        // 비차단 — 제안 조회 실패는 조용히 무시(생성/수정은 이미 성공).
      });
    return () => {
      cancelled = true;
    };
    // suggestNonce가 오를 때만 실행. 날짜 변경은 nonce와 함께 오므로 필드 deps 포함해도 1회.
  }, [suggestNonce, groupId, campaign.id, campaign.sellerId, campaign.startDate, campaign.endDate]);

  const refreshCurrentCampaign = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const refreshed = (await res.json()) as CampaignRow;
      onGroupMembershipChanged?.(refreshed);
    } catch {
      // 비차단 — 상위 동기화 실패해도 섹션 로컬 상태는 이미 갱신됨.
    }
  }, [campaign.id, onGroupMembershipChanged]);

  useEffect(() => {
    if (editingName) {
      setNameDraft(detail?.name ?? "");
      nameInputRef.current?.focus();
    }
  }, [editingName, detail?.name]);

  async function handleJoin(group: CampaignGroupRow) {
    setJoiningGroupId(group.id);
    try {
      await joinCampaignToGroup(group.id, campaign.id);
      setBanner(null);
      setPickerOpen(false);
      toast.success("그룹에 합류했습니다.");
      await refreshCurrentCampaign();
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : "합류하지 못했습니다. 다시 시도해 주세요.",
      );
    } finally {
      setJoiningGroupId(null);
    }
  }

  function handleDismissBanner() {
    if (banner) {
      for (const group of banner) {
        dismissSuggestion(campaign.id, group.id);
      }
    }
    setBanner(null);
  }

  async function handleRemove(member: CampaignGroupMemberRow) {
    if (!groupId) return;
    setRemovingId(member.campaignId);
    try {
      const result = await removeGroupMember(groupId, member.campaignId);
      if (result.dissolved) {
        setDetail(null);
        toast.success("남는 캠페인이 1건뿐이라 그룹이 해제되었습니다.");
      } else if (member.campaignId === campaign.id) {
        // 현재 캠페인을 뺐다 → 현재는 미그룹으로 전환.
        setDetail(null);
        toast.success("이 캠페인을 그룹에서 제외했습니다.");
      } else {
        setDetail(result.group);
        toast.success(`${member.dealName}을 그룹에서 제외했습니다.`);
      }
      await refreshCurrentCampaign();
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : "그룹에서 제외하지 못했습니다.",
      );
    } finally {
      setRemovingId(null);
      setPendingRemoval(null);
    }
  }

  async function handleSaveName() {
    if (!groupId) return;
    const next = nameDraft.trim();
    if (next === (detail?.name ?? "")) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      const updated = await renameGroup(groupId, next);
      setDetail(updated);
      setEditingName(false);
      toast.success(next ? "그룹 이름을 변경했습니다." : "자동 이름으로 되돌렸습니다.");
    } catch (err) {
      toast.error(
        err instanceof Error && err.message ? err.message : "이름을 변경하지 못했습니다.",
      );
    } finally {
      setSavingName(false);
    }
  }

  function navigateTo(member: CampaignGroupMemberRow) {
    if (member.campaignId === campaign.id) return;
    onNavigateToCampaign?.(member.campaignId);
  }

  const groupLabel = detail ? formatGroupLabel(detail) : "";
  const memberCount = detail?.members.length ?? 0;
  const willDissolve = memberCount === 2;

  // -------------------------------------------------------------------------
  // 렌더
  // -------------------------------------------------------------------------

  const header = (
    <div className="flex items-center gap-2">
      <h3 className="flex items-center text-sm font-semibold text-foreground">
        <Boxes className="mr-2 size-4 text-muted-foreground" />
        그룹
      </h3>
      {groupId && memberCount > 0 ? (
        <Badge variant="secondary" size="count">
          {memberCount}건
        </Badge>
      ) : null}
    </div>
  );

  // 로딩(그룹 상세 fetch)
  if (groupId && loadingDetail && !detail) {
    return (
      <section className={SECTION_SHELL} aria-busy="true">
        {header}
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-9 animate-shimmer rounded-lg bg-slate-100"
              aria-hidden="true"
            />
          ))}
        </div>
      </section>
    );
  }

  // 에러(그룹 상세 fetch 실패)
  if (groupId && detailError && !detail) {
    return (
      <section className={SECTION_SHELL}>
        {header}
        <div
          className="flex items-center justify-between gap-3 rounded-lg border p-3 text-xs"
          style={{
            borderColor: "var(--status-urgent)",
            background: "var(--status-urgent-bg)",
            color: "var(--status-urgent-text)",
          }}
          role="alert"
        >
          <span>그룹 정보를 불러오지 못했습니다.</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={() => setReloadNonce((n) => n + 1)}
          >
            <RotateCw className="mr-1 size-3" />
            다시 불러오기
          </Button>
        </div>
      </section>
    );
  }

  // 그룹 소속
  if (groupId && detail) {
    return (
      <section className={SECTION_SHELL}>
        {header}

        {/* 그룹명 + 인라인 이름 수정 */}
        <div className="flex items-center gap-2">
          {editingName ? (
            <div className="flex w-full flex-col gap-1">
              <div className="flex items-center gap-2">
                <Input
                  ref={nameInputRef}
                  value={nameDraft}
                  disabled={savingName}
                  placeholder={detail.name ?? "자동 이름"}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleSaveName();
                    } else if (event.key === "Escape") {
                      setEditingName(false);
                    }
                  }}
                  className="h-8 text-xs"
                  aria-label="그룹 이름"
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  disabled={savingName}
                  onClick={() => void handleSaveName()}
                >
                  {savingName ? "저장 중…" : "저장"}
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">
                비우면 자동 이름으로 돌아갑니다.
              </span>
            </div>
          ) : (
            <>
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                title={groupLabel}
              >
                {groupLabel}
              </span>
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-slate-100 hover:text-foreground"
                aria-label="그룹 이름 수정"
              >
                <Pencil className="size-3.5" />
              </button>
            </>
          )}
        </div>

        {/* 멤버 리스트 */}
        <ul role="list" className="space-y-1.5">
          {detail.members.map((member) => {
            const isCurrent = member.campaignId === campaign.id;
            const navigable = !isCurrent && Boolean(onNavigateToCampaign);
            return (
              <li key={member.campaignId} className="group/member">
                <div
                  role={navigable ? "button" : undefined}
                  tabIndex={navigable ? 0 : undefined}
                  onClick={navigable ? () => navigateTo(member) : undefined}
                  onKeyDown={
                    navigable
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            navigateTo(member);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors",
                    isCurrent
                      ? "border-primary/30 bg-primary/5"
                      : "border-border/70 bg-background",
                    navigable && "cursor-pointer hover:bg-accent/30",
                  )}
                >
                  <SubStageBadge
                    status={member.status}
                    size="compact"
                    className="shrink-0"
                  />
                  <span
                    className="min-w-0 flex-1 truncate font-medium text-foreground"
                    title={member.dealName}
                  >
                    {member.dealName}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatDateRange(member.startDate, member.endDate)}
                  </span>
                  {member.roundNumber ? (
                    <span className={ROUND_BADGE}>{member.roundNumber}차</span>
                  ) : null}
                  {isCurrent ? (
                    <span className="shrink-0 text-[10px] font-semibold text-primary">
                      현재
                    </span>
                  ) : navigable ? (
                    <ChevronRight
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingRemoval(member);
                    }}
                    disabled={removingId === member.campaignId}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/member:opacity-100 focus-visible:opacity-100"
                    aria-label={`${member.dealName} 캠페인을 그룹에서 제외`}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="text-[11px] text-muted-foreground">
          정산·입금·계산서는 아직 캠페인별로 관리됩니다.
        </p>

        {/* 제외 확인 — 2인이면 자동 해체 경고, 3인↑이면 가벼운 확인 */}
        <AlertDialog
          open={!!pendingRemoval}
          onOpenChange={(next) => {
            if (!next) setPendingRemoval(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {willDissolve
                  ? "그룹에서 제외하면 그룹이 해제됩니다"
                  : `${pendingRemoval?.dealName ?? ""}을 그룹에서 제외할까요?`}
              </AlertDialogTitle>
              {willDissolve ? (
                <AlertDialogDescription>
                  {`남는 캠페인이 1건뿐이라 '${groupLabel}' 그룹이 해제됩니다. 계속할까요?`}
                </AlertDialogDescription>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>취소</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  if (pendingRemoval) void handleRemove(pendingRemoval);
                }}
                className="bg-[var(--status-urgent)] text-white hover:bg-[var(--status-urgent)]/90 focus-visible:ring-[var(--status-urgent)]/40"
              >
                {willDissolve ? "제외하고 그룹 해제" : "제외"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    );
  }

  // 무그룹 상태
  return (
    <section className={SECTION_SHELL}>
      {header}

      {/* 표면 ⓑ — 자동 합류 배너(날짜 수정 직후 겹치는 그룹 발견 시) */}
      {banner && banner.length > 0 ? (
        <GroupJoinBanner
          candidates={banner}
          joiningGroupId={joiningGroupId}
          onJoin={handleJoin}
          onDismiss={handleDismissBanner}
        />
      ) : null}

      <p className="text-xs text-muted-foreground">
        이 캠페인은 그룹에 속해 있지 않습니다.
      </p>

      <GroupPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        campaign={campaign}
        joiningGroupId={joiningGroupId}
        onJoin={handleJoin}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// 표면 ⓑ 인라인 배너
// ---------------------------------------------------------------------------

function GroupJoinBanner({
  candidates,
  joiningGroupId,
  onJoin,
  onDismiss,
}: {
  candidates: CampaignGroupRow[];
  joiningGroupId: string | null;
  onJoin: (group: CampaignGroupRow) => void;
  onDismiss: () => void;
}) {
  const [chooserOpen, setChooserOpen] = useState(false);
  const representative = candidates[0];
  const multiple = candidates.length > 1;
  const label = formatGroupLabel(representative);
  const joining = joiningGroupId === representative.id;

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3"
    >
      <div className="flex items-start gap-2">
        <Boxes className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="text-xs text-foreground">
          {`'${label}' 그룹에 이 캠페인을 합류시킬까요?`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={joining}
          onClick={() => onJoin(representative)}
          aria-label={`${label} 그룹에 합류`}
        >
          {joining ? "합류 중…" : "합류"}
        </Button>
        {multiple ? (
          <Popover open={chooserOpen} onOpenChange={setChooserOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 text-xs">
                합류할 그룹 고르기
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2">
              <GroupCandidateList
                candidates={candidates}
                joiningGroupId={joiningGroupId}
                onJoin={(group) => {
                  setChooserOpen(false);
                  onJoin(group);
                }}
              />
            </PopoverContent>
          </Popover>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground"
          onClick={onDismiss}
        >
          합류 안 함
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 무그룹 "그룹으로 묶기" 조합 피커 — suggest로 겹치는 기존 그룹을 찾아 합류.
// ---------------------------------------------------------------------------

function GroupPicker({
  open,
  onOpenChange,
  campaign,
  joiningGroupId,
  onJoin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign: CampaignRow;
  joiningGroupId: string | null;
  onJoin: (group: CampaignGroupRow) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<CampaignGroupRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    // 수동 조회 — 세션 억제 미적용(사용자가 명시적으로 열었으므로).
    fetchGroupSuggestions({
      sellerId: campaign.sellerId,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      excludeCampaignId: campaign.id,
    })
      .then((groups) => {
        if (!cancelled) setCandidates(groups);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, campaign.sellerId, campaign.startDate, campaign.endDate, campaign.id]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 w-fit text-xs">
          <Boxes className="mr-1 size-3.5" />
          그룹으로 묶기
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        {loading ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            불러오는 중…
          </p>
        ) : error ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            후보를 불러오지 못했습니다.
          </p>
        ) : candidates && candidates.length > 0 ? (
          <GroupCandidateList
            candidates={candidates}
            joiningGroupId={joiningGroupId}
            onJoin={onJoin}
          />
        ) : (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            묶을 수 있는 같은 셀러·기간 캠페인이 없습니다.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function GroupCandidateList({
  candidates,
  joiningGroupId,
  onJoin,
}: {
  candidates: CampaignGroupRow[];
  joiningGroupId: string | null;
  onJoin: (group: CampaignGroupRow) => void;
}) {
  return (
    <ul role="list" className="flex flex-col gap-1">
      {candidates.map((group) => {
        const label = formatGroupLabel(group);
        const joining = joiningGroupId === group.id;
        return (
          <li key={group.id}>
            <button
              type="button"
              disabled={joining}
              onClick={() => onJoin(group)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/40 disabled:opacity-60"
              aria-label={`${label} 그룹에 합류`}
            >
              <span className="min-w-0 flex-1 truncate font-medium" title={label}>
                {label}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatDateRange(group.startDate, group.endDate)} · {group.memberCount}건
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
