"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, ChevronRight, Pencil, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { formatDealContextLabel } from "@/lib/deal-display";
import {
  expandYmdRangeByWindow,
  GROUP_WINDOW_DAYS,
} from "@/lib/campaign-group-clustering";
import { cn } from "@/lib/utils";
import type {
  CampaignCombineCandidateRow,
  CampaignGroupDetailRow,
  CampaignGroupMemberRow,
  CampaignGroupRow,
  CampaignRow,
} from "@/lib/crm-types";
import { SubStageBadge } from "./sub-stage-badge";
import {
  createCampaignGroup,
  dismissSuggestion,
  fetchActiveSuggestions,
  fetchCombineCandidates,
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
  const [combining, setCombining] = useState(false);
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

  /**
   * 멤버십이 바뀐 캠페인들을 다시 읽어 상위 목록에 흘려보낸다.
   *
   * ⚠️ **id 목록을 받는 것이 요점이다** — 상위 콜백(`onCampaignUpdated` →
   * `replaceCampaignRow`)은 **행 하나를 교체하는** 계약이라 목록이 스스로 따라오지
   * 않는다. 그런데 그룹 **생성**은 고른 캠페인 전부의 `groupId` 를 한 번에 바꾼다.
   * 현재 캠페인만 갱신하면 나머지 행은 새로고침 전까지 미그룹으로 남아 보드의 그룹
   * 배지가 거짓말을 한다(방금 묶은 것이 안 묶인 것처럼 보인다).
   */
  const refreshCampaigns = useCallback(
    async (campaignIds: string[]) => {
      const rows = await Promise.all(
        campaignIds.map(async (id) => {
          try {
            const res = await fetch(`/api/campaigns/${id}`, { cache: "no-store" });
            if (!res.ok) return null;
            return (await res.json()) as CampaignRow;
          } catch {
            // 비차단 — 상위 동기화 실패해도 섹션 로컬 상태는 이미 갱신됨.
            return null;
          }
        }),
      );
      let failed = 0;
      for (const row of rows) {
        if (row) onGroupMembershipChanged?.(row);
        else failed += 1;
      }
      return failed;
    },
    [onGroupMembershipChanged],
  );

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
      await refreshCampaigns([campaign.id]);
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

  /**
   * 기존 캠페인들을 새 그룹으로 묶는다(경로 ⓐ). `campaignIds` 에는 호출부가 현재
   * 캠페인을 이미 포함시켜 넘긴다(서버 최소 2건 요구).
   */
  async function handleCombine(campaignIds: string[]) {
    setCombining(true);
    try {
      await createCampaignGroup(campaignIds);
      setBanner(null);
      setPickerOpen(false);
      toast.success(`${campaignIds.length}건을 하나의 그룹으로 묶었습니다.`);
      // ⛔ 현재 캠페인만 갱신하지 말 것 — 이 호출은 `campaignIds` **전부**의
      // groupId 를 바꿨고, 상위는 행 하나씩만 교체한다(위 refreshCampaigns 주석).
      const failed = await refreshCampaigns(campaignIds);
      if (failed > 0) {
        // 묶기 자체는 성공했다. 다만 목록이 못 따라왔으므로 그 사실을 말한다 —
        // 조용히 두면 방금 묶은 캠페인이 안 묶인 것처럼 보이는 상태로 남는다.
        toast.warning("묶기는 끝났지만 목록 갱신이 일부 실패했습니다. 새로고침해 주세요.");
      }
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : "그룹으로 묶지 못했습니다. 다시 시도해 주세요.",
      );
    } finally {
      setCombining(false);
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
    // 제외 **전** 멤버 명단 — 해체되면 이 전원이 미그룹으로 바뀐다.
    // ℹ️ 이 렌더의 `detail` 은 await 뒤에도 같은 값이다(`setDetail` 은 다음 렌더의
    // 바인딩을 만들 뿐 실행 중인 클로저가 잡은 값을 바꾸지 않는다) — 미리 잡는 것은
    // 필수가 아니라, 아래에서 `setDetail(null)` 을 부르는 자리라 "언제 기준의
    // 명단인가"를 이름으로 못박기 위해서다.
    const memberIdsBeforeRemoval = detail?.members.map((m) => m.campaignId) ?? [];
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
      // ⛔ 현재 캠페인만 갱신하지 말 것 — 해체는 **남은 멤버까지** 미그룹으로 만들고,
      // 형제를 뺀 경우엔 그 형제의 groupId 가 바뀐다. 상위는 행 하나씩만 교체하므로
      // (위 refreshCampaigns 주석) 빠뜨린 행은 새로고침 전까지 보드에 그룹 배지를
      // 그대로 달고 있어 실제와 다르게 보인다.
      // ℹ️ **오늘은 두 갈래의 결과가 같다** — 서버는 남는 멤버가 1건 이하일 때만
      // 해체하므로 해체는 곧 "2건짜리에서 하나를 뺐다"이고, 그러면 제외 전 명단이
      // 그대로 [뺀 멤버, 현재]다. 그래도 갈래를 남기는 것은 그 일치가 **서버의 해체
      // 조건과의 결합**이기 때문이다 — 한 번에 여러 건을 빼는 경로가 생기면
      // "해체 = 2건" 전제가 조용히 깨진다. ⛔ 같다는 이유로 접지 말 것.
      const affectedIds = [
        ...new Set(
          result.dissolved
            ? [...memberIdsBeforeRemoval, campaign.id]
            : [member.campaignId, campaign.id],
        ),
      ];
      const failed = await refreshCampaigns(affectedIds);
      if (failed > 0) {
        // 제외 자체는 성공했다. 조용히 두면 고치려던 "배지가 거짓말하는" 상태가
        // 다른 이유로 그대로 재현된다(handleCombine 과 같은 규율).
        toast.warning("제외는 끝났지만 목록 갱신이 일부 실패했습니다. 새로고침해 주세요.");
      }
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
            // 표기 조립은 `formatDealContextLabel` 이 소유한다 — 브랜드와 거래처가
            // 같은 딜이면 하나만 보여주는 규칙이라, 호출부가 손으로 이어붙이는 순간
            // 같은 딜이 표면마다 다르게 읽힌다.
            const context = formatDealContextLabel({
              brandName: member.brandName,
              partnerName: member.partnerName,
            });
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
                    "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors",
                    isCurrent
                      ? "border-primary/30 bg-primary/5"
                      : "border-border/70 bg-background",
                    navigable && "cursor-pointer hover:bg-accent/30",
                  )}
                >
                  <SubStageBadge
                    status={member.status}
                    size="compact"
                    className="mt-0.5 shrink-0"
                  />
                  {/* 2행으로 가른 것은 축이 둘이기 때문이다 — 1행은 정체성(무슨
                      캠페인인가), 2행은 판단 근거(같은 묶음인가). 한 줄에서 경쟁시키면
                      딜이름과 브랜드가 둘 다 잘려 판단 축이 되레 사라진다.
                      브랜드·거래처는 좋고 나쁨이 없는 범주라 무채색이다(P8 §4). */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="min-w-0 truncate font-medium text-foreground"
                        title={member.dealName}
                      >
                        {member.dealName}
                      </span>
                      {member.roundNumber ? (
                        <span className={ROUND_BADGE}>{member.roundNumber}차</span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {context ? (
                        <span className="min-w-0 truncate" title={context}>
                          {context}
                        </span>
                      ) : null}
                      <span className="shrink-0">
                        {formatDateRange(member.startDate, member.endDate)}
                      </span>
                    </div>
                  </div>
                  {/* 이동 어포던스·제거 버튼은 2행 블록 밖에 남긴다 — 행 전체가 클릭
                      대상(role="button")이라 행 수준 조작이지 정체성 줄의 일부가
                      아니다. `mt-0.5` 는 items-start 아래에서 첫 줄에 맞추는 값. */}
                  {isCurrent ? (
                    <span className="mt-0.5 shrink-0 text-[10px] font-semibold text-primary">
                      현재
                    </span>
                  ) : navigable ? (
                    <ChevronRight
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
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
                    className="mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/member:opacity-100 focus-visible:opacity-100"
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

      <GroupCombineDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        campaign={campaign}
        joiningGroupId={joiningGroupId}
        combining={combining}
        onJoin={handleJoin}
        onCombine={handleCombine}
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
// 무그룹 "그룹으로 묶기" — 사이드패널의 조합 다이얼로그 (표면 ⓒ 안에서 열린다.
// ⚠️ 청사진의 「표면 ⓐ」는 `bulk-combo-campaign-dialog.tsx`(캠페인을 새로 만들며
// 묶는 창)가 이미 쓰고 있다 — 같은 글자를 여기에 겹쳐 쓰지 말 것)
// ---------------------------------------------------------------------------
//
// ⛔ 이 자리에 있던 종전 팝오버는 `suggest`(= 이미 만들어진 **그룹** 조회)만 부르면서
// 문구는 "묶을 수 있는 캠페인이 없습니다"라고 말했다. 그룹이 하나도 없는 셀러에서는
// 무엇을 골라도 영원히 빈 목록이었고(기존 캠페인을 새 그룹으로 묶는 경로가 앱에
// 아예 없었다), 오너는 그 침묵을 "브랜드가 달라서 안 묶인다"로 읽었다. 그래서 두
// 질문을 갈라서 묻는다 — 합류할 기존 그룹은 `suggest`, 새로 묶을 캠페인은 `combinable`.
//
// 두 동작이 한 창에 있지만 커밋 모델이 섞이지 않게 한다: 합류는 줄마다 붙은 명시적
// 버튼(즉시 실행), 새로 묶기는 체크박스 + 푸터 확정. 줄 아무 데나 눌러서 실행되는
// 자리는 이 창에 없다.

function GroupCombineDialog({
  open,
  onOpenChange,
  campaign,
  joiningGroupId,
  combining,
  onJoin,
  onCombine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign: CampaignRow;
  joiningGroupId: string | null;
  combining: boolean;
  onJoin: (group: CampaignGroupRow) => void;
  onCombine: (campaignIds: string[]) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [groups, setGroups] = useState<CampaignGroupRow[]>([]);
  const [joinError, setJoinError] = useState(false);
  const [candidates, setCandidates] = useState<CampaignCombineCandidateRow[]>([]);
  const [alreadyGroupedCount, setAlreadyGroupedCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setJoinError(false);
    setSelectedIds([]);
    // 수동 조회 — 세션 억제 미적용(사용자가 명시적으로 열었으므로).
    const params = {
      sellerId: campaign.sellerId,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      excludeCampaignId: campaign.id,
    };
    // 합류 후보(기존 그룹)는 순수 겹침으로 조회되므로 범위를 근접 창만큼 넓혀
    // 묶기 후보와 **같은 날짜 규칙**을 태운다. 안 넓히면 2일 떨어진 그룹이 합류
    // 목록엔 없는데 그 멤버는 "이미 다른 그룹에 속해 있다"로 집계돼, 오너가 취할
    // 행동이 화면에 없는 막다른 길이 생긴다(이 기능이 없애려던 바로 그 형태다).
    // ⚠️ 이 일치는 **이 창 안에서만** 성립한다 — 날짜 수정 직후의 합류 배너
    // (`fetchActiveSuggestions`)는 의도적으로 안 넓힌 범위를 쓴다(nag 억제).
    const joinParams = { ...params, ...expandYmdRangeByWindow(params) };
    // ⛔ Promise.all 로 묶지 말 것 — 합류 목록은 **보조**이고 묶기 목록이 이 창의
    // 본체다. all 이면 suggest 한 번 실패가 후보 목록까지 통째로 가려, 고치려던
    // "아무것도 안 보인다"가 다른 이유로 재현된다. 합류 조회가 실패해도 묶기는
    // 그대로 진행되지만, **실패 자체는 숨기지 않는다**(joinError → 안내 문구).
    // 빈 목록으로 접으면 "조회 실패"와 "합류할 그룹 없음"이 같은 모양이 된다.
    Promise.allSettled([fetchGroupSuggestions(joinParams), fetchCombineCandidates(params)])
      .then(([joinResult, combineResult]) => {
        if (cancelled) return;
        setGroups(joinResult.status === "fulfilled" ? joinResult.value : []);
        // ⛔ 실패를 빈 목록으로 접지 말 것 — "조회 실패"와 "합류할 그룹 없음"이
        // 화면에서 같은 모양이 되면, 이 창이 없애려던 막다른 길이 그대로 재현된다.
        setJoinError(joinResult.status === "rejected");
        if (combineResult.status === "fulfilled") {
          setCandidates(combineResult.value.candidates);
          setAlreadyGroupedCount(combineResult.value.alreadyGroupedCount);
        } else {
          setError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, campaign.sellerId, campaign.startDate, campaign.endDate, campaign.id]);

  function toggleCandidate(campaignId: string) {
    setSelectedIds((prev) =>
      prev.includes(campaignId)
        ? prev.filter((id) => id !== campaignId)
        : [...prev, campaignId],
    );
  }

  // 합류가 날아가는 중이면 묶기도 잠근다 — 둘 다 이 캠페인의 groupId 를 바꾸므로,
  // 겹쳐 누르면 서버 advisory lock 에서 진 쪽이 ALREADY_GROUPED(409)로 떨어져
  // 한 번의 조작에 성공 토스트와 오류 토스트가 같이 뜬다(데이터는 안전하다).
  const busy = combining || joiningGroupId !== null;

  // 서버는 최소 2건을 요구한다. 현재 캠페인이 항상 포함되므로 1건만 골라도 성립한다.
  const canSubmit = selectedIds.length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 w-fit text-xs">
          <Boxes className="mr-1 size-3.5" />
          그룹으로 묶기
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>그룹으로 묶기</DialogTitle>
          <DialogDescription>
            {`같은 셀러의 캠페인 중 일정이 겹치거나 ${GROUP_WINDOW_DAYS}일 이내인 것만 보입니다. 이미 그룹에 속한 캠페인은 새로 묶을 수 없고, 대신 그 그룹에 합류할 수 있습니다.`}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <CombineSkeleton />
        ) : error ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            후보를 불러오지 못했습니다. 창을 닫았다가 다시 열어 주세요.
          </p>
        ) : (
          <div className="space-y-4">
            {joinError ? (
              <p className="rounded-md border border-dashed border-border/70 px-2 py-3 text-center text-xs text-muted-foreground">
                합류할 수 있는 기존 그룹을 불러오지 못했습니다. 새로 묶는 것은 아래에서 그대로 할 수 있습니다.
              </p>
            ) : groups.length > 0 ? (
              <section className="space-y-1.5">
                <h3 className="text-xs font-semibold text-foreground">
                  이미 있는 그룹에 합류
                </h3>
                <ul role="list" className="flex flex-col gap-1">
                  {groups.map((group) => {
                    const label = formatGroupLabel(group);
                    const joining = joiningGroupId === group.id;
                    return (
                      <li
                        key={group.id}
                        className="flex items-center gap-2 rounded-md border border-border/70 px-2 py-1.5 text-xs"
                      >
                        <GroupRowContent group={group} />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 shrink-0 text-xs"
                          disabled={busy}
                          onClick={() => onJoin(group)}
                          aria-label={`${label} 그룹에 합류`}
                        >
                          {joining ? "합류 중…" : "합류"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            <section className="space-y-1.5">
              <h3 className="text-xs font-semibold text-foreground">새로 묶기</h3>
              {candidates.length === 0 ? (
                <p className="rounded-md border border-dashed border-border/70 px-2 py-4 text-center text-xs text-muted-foreground">
                  {alreadyGroupedCount > 0
                    ? "일정이 가까운 캠페인은 이미 다른 그룹에 속해 있습니다."
                    : "일정이 가까운 다른 캠페인이 없습니다."}
                </p>
              ) : (
                <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
                  {candidates.map((candidate) => (
                    <CombineCandidateRow
                      key={candidate.campaignId}
                      candidate={candidate}
                      checked={selectedIds.includes(candidate.campaignId)}
                      disabled={busy}
                      onToggle={() => toggleCandidate(candidate.campaignId)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            취소
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => onCombine([campaign.id, ...selectedIds])}
          >
            {combining ? "묶는 중…" : `선택한 ${selectedIds.length}건과 묶기`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 후보 1줄. 오너가 "이게 같은 묶음인가"를 판단하는 축(브랜드·거래처·차수·상태·기간)을 함께 싣는다. */
function CombineCandidateRow({
  candidate,
  checked,
  disabled,
  onToggle,
}: {
  candidate: CampaignCombineCandidateRow;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  // 제목은 딜 이름이다 — 캠페인명(`{딜} - {셀러} {N}차`)을 쓰면 차수가 배지와 겹쳐
  // 두 번 나오고(P2), 같은 셀러만 나열되는 목록에서 셀러명이 매 줄 반복된다.
  const title = candidate.dealName;
  const context = formatDealContextLabel({
    brandName: candidate.brandName,
    partnerName: candidate.partnerName,
  });

  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40">
      {/* 라벨이 감싸고 있어도 이름을 명시한다 — 라벨 안이 배지·기간까지 섞인 조각
          여러 개라 접근성 트리에서 캠페인 이름으로 읽히지 않는다(실측값 "on"). */}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`${title} 선택`}
        className="mt-0.5 size-4 cursor-pointer rounded border-slate-300 text-primary focus:ring-focus-ring"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium" title={title}>
            {title}
          </span>
          {candidate.roundNumber ? (
            <span className={ROUND_BADGE}>{candidate.roundNumber}차</span>
          ) : null}
          <SubStageBadge status={candidate.status} size="compact" className="shrink-0" />
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {context ? <span className="min-w-0 truncate">{context}</span> : null}
          <span className="shrink-0">
            {formatDateRange(candidate.startDate, candidate.endDate)}
          </span>
        </span>
      </span>
    </label>
  );
}

/** 로딩은 스피너가 아니라 최종 레이아웃 모양의 스켈레톤(styleseed 기계 점검 3). */
function CombineSkeleton() {
  return (
    <div className="space-y-2 py-2" role="status" aria-live="polite">
      <span className="sr-only">후보를 불러오는 중</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * 합류 후보 그룹 1줄의 **표시 내용** — 배너의 그룹 고르기와 조합 다이얼로그가 공유한다.
 *
 * 두 표면은 조작 방식이 다르다(줄 전체가 버튼 vs 줄 옆 「합류」 버튼). 그래서 껍데기는
 * 각자 두되 "그룹 1건을 무엇으로 보여줄 것인가"(이름 폴백·기간·멤버 수)는 여기 한 곳에
 * 둔다 — 이 레포에서 반복해 난 결함이 "화면이 같은 판정을 손으로 재구현하는 것"이다.
 */
function GroupRowContent({ group }: { group: CampaignGroupRow }) {
  const label = formatGroupLabel(group);
  return (
    <>
      <span className="min-w-0 flex-1 truncate font-medium" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {formatDateRange(group.startDate, group.endDate)} · {group.memberCount}건
      </span>
    </>
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
              <GroupRowContent group={group} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
