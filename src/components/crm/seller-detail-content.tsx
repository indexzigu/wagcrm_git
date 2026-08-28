"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Loader2, Trash2, Archive, ExternalLink, FileText, Upload, Building2, Plus, X, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DataEmpty } from "@/components/ui/empty";

import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { campaignStatusLabels, type CampaignStatus, type SnsType, type SellerSummary, type AssetSection, assetSectionLabels, acquisitionChannelLabels } from "@/lib/crm-types";
import { formatCurrency, formatDate, formatRate, formatBytes, formatBusinessNumber } from "@/lib/format";
import { filterNotionTemp } from "@/lib/notion-temp-filter";
import { applyChannelInfo } from "@/lib/partner-seller-display";
import { computeScorecardWithGrowth } from "@/lib/seller-scorecard";
import { SellerGrowthChart } from "./seller-growth-chart";
import { SellerPortalLinkSection } from "./seller-portal-link-section";
import { suggestPortalSlug } from "@/lib/portal-slug";
import { SellerErChart } from "./seller-er-chart";
import { ActivityTimeline } from "./activity-timeline";
import { SellerDealCandidates } from "./seller-deal-candidates";
import { CategoryTagInput, type CategoryTag } from "./category-tag-input";
import { ChannelUrlField } from "./channel-url-field";
import { InlineEditField } from "./inline-edit-field";
// 마스킹 규칙은 원천징수 리포트와 공유한다 — 같은 값이 두 화면에서 다르게 가려지면 안 된다.
import { maskResidentNumber } from "@/lib/withholding-report";

import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { LinkSearchDialog } from "./link-search-dialog";


import {
  AnimatedTabs,
  AnimatedTabsList,
  AnimatedTabsTrigger,
  AnimatedTabsContent,
} from "@/components/ui/animated-tabs";
import { SellerAiAnalysis } from "@/components/crm/seller-analysis/SellerAiAnalysis";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { StepMetricCard } from "./step-metric-card";
import { LEVELS } from "@/lib/seller-analysis/reviewMapping";
import { cn } from "@/lib/utils";
import { Image as ImageIcon } from "lucide-react";
import { decodeExternalUrls, encodeExternalUrls } from "@/lib/instagram-profile";


export type SellerDetailContentProps = {
  seller: SellerSummary;
  onUpdated?: (seller: SellerSummary) => void;
  onDeleted?: (sellerId: string) => void;
  onClose: () => void;
};

export function SellerDetailContent({
  seller,
  onUpdated,
  onDeleted,
  onClose,
}: SellerDetailContentProps) {
  const [snapshots, setSnapshots] = useState<Array<{ id: string; snapshotDate: string; followersCount: number; postsCount?: number | null; source: string; er?: number | null; avgLikes?: number | null; avgComments?: number | null }>>([]);
  const [bioHistories, setBioHistories] = useState<Array<{ id: string; collectedAt: string; previousBio: string | null; bio: string; source: string }>>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [categoryTags, setCategoryTags] = useState<CategoryTag[]>(
    seller.category
      ? seller.category.split(",").map((name, idx) => ({
          id: `temp-${idx}-${name.trim()}`,
          name: name.trim(),
        }))
      : []
  );
  const [partnerLinkSearchOpen, setPartnerLinkSearchOpen] = useState(false);
  const [linkedPartner, setLinkedPartner] = useState<{
    id: string;
    name: string;
    type: string;
    ceoName?: string;
    businessNumber?: string;
    representativeEmail?: string;
    contactInfo?: string;
  } | null>(null);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState("profile");

  // 정산 신원(주민등록번호·계좌) — 목록 페이로드에 싣지 않고 상세를 연 1명만 단건 조회한다.
  // 주민번호는 기본 마스킹이고 '보기'를 눌러야 펼쳐진다.
  const [settlementInfo, setSettlementInfo] = useState<{
    realName: string | null;
    residentNumber: string | null;
    accountNumber: string | null;
  } | null>(null);
  const [residentRevealed, setResidentRevealed] = useState(false);

  // Follower/Post history list/edit state
  const [showAddHistory, setShowAddHistory] = useState(false);
  const [newSnapshotDate, setNewSnapshotDate] = useState("");
  const [newFollowersCount, setNewFollowersCount] = useState("");
  const [newPostsCount, setNewPostsCount] = useState("");
  const [addingHistory, setAddingHistory] = useState(false);



  // Fetch seller history snapshots when seller changes
  const fetchHistory = useCallback(async () => {
    if (!seller) {
      setSnapshots([]);
      setBioHistories([]);
      return;
    }
    setLoadingSnapshots(true);
    try {
      const response = await fetch(`/api/sellers/${seller.id}/history`);
      if (response.ok) {
        const data = await response.json();
        setSnapshots(data.snapshots ?? []);
        setBioHistories(data.bioHistories ?? []);
      }
    } catch {
      // Silently fail
    } finally {
      setLoadingSnapshots(false);
    }
  }, [seller]);

  const handleAddHistory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSnapshotDate || !newFollowersCount) {
      toast.error("날짜와 팔로워 수를 입력해주세요.");
      return;
    }
    const count = parseInt(newFollowersCount, 10);
    if (isNaN(count) || count < 0) {
      toast.error("올바른 팔로워 수를 입력해주세요.");
      return;
    }

    const posts = newPostsCount ? parseInt(newPostsCount, 10) : undefined;
    if (posts !== undefined && (isNaN(posts) || posts < 0)) {
      toast.error("올바른 게시물 수를 입력해주세요.");
      return;
    }

    setAddingHistory(true);
    try {
      const response = await fetch(`/api/sellers/${seller.id}/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshotDate: newSnapshotDate,
          followersCount: count,
          postsCount: posts,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "이력 추가 실패");
      }

      const data = await response.json();
      toast.success("데이터 수집 이력이 추가되었습니다.");
      setNewSnapshotDate("");
      setNewFollowersCount("");
      setNewPostsCount("");
      setShowAddHistory(false);

      // Refresh snapshots
      await fetchHistory();

      // Trigger parent update
      if (data.latestFollowers !== undefined) {
        onUpdated?.({
          ...seller,
          currentFollowers: data.latestFollowers,
          currentPostsCount: data.latestPostsCount !== undefined ? data.latestPostsCount : seller.currentPostsCount,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "이력 추가 중 오류가 발생했습니다.";
      toast.error(message);
    } finally {
      setAddingHistory(false);
    }
  };

  const handleDeleteHistory = async (historyId: string) => {
    if (!confirm("이 데이터 수집 이력을 삭제하시겠습니까?")) return;

    try {
      const response = await fetch(`/api/sellers/${seller.id}/history?historyId=${historyId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "이력 삭제 실패");
      }

      const data = await response.json();
      toast.success("데이터 수집 이력이 삭제되었습니다.");

      // Refresh snapshots
      await fetchHistory();

      // Trigger parent update
      if (data.latestFollowers !== undefined) {
        onUpdated?.({
          ...seller,
          currentFollowers: data.latestFollowers,
          currentPostsCount: data.latestPostsCount !== undefined ? data.latestPostsCount : seller.currentPostsCount,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "이력 삭제 중 오류가 발생했습니다.";
      toast.error(message);
    }
  };

  useEffect(() => {
    let isMounted = true;
    
    const load = async () => {
      if (!seller) {
        setSnapshots([]);
        setBioHistories([]);
        return;
      }
      setLoadingSnapshots(true);
      try {
        const response = await fetch(`/api/sellers/${seller.id}/history`);
        if (response.ok && isMounted) {
          const data = await response.json();
          setSnapshots(data.snapshots ?? []);
          setBioHistories(data.bioHistories ?? []);
        }
      } catch {
        // Silently fail
      } finally {
        if (isMounted) {
          setLoadingSnapshots(false);
        }
      }
    };

    void load();
    return () => {
      isMounted = false;
    };
  }, [seller]);

  const handleManualSync = async () => {
    const targetUrl = seller.channelUrl || (
      seller.snsHandle
        ? (seller.snsType === "YOUTUBE"
          ? (seller.snsHandle.startsWith("UC") ? `https://www.youtube.com/channel/${seller.snsHandle}` : `https://www.youtube.com/@${seller.snsHandle}`)
          : `https://www.instagram.com/${seller.snsHandle}`)
        : ""
    );
    if (!targetUrl) {
      toast.error("동기화할 채널 URL 또는 SNS 핸들이 없습니다.");
      return;
    }
    setSyncing(true);
    try {
      // 1단계: 수집 시작 (즉시 반환)
      const response = await fetch(
        `/api/sellers/${seller.id}/channel-info?force=true&url=${encodeURIComponent(targetUrl)}`
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "동기화 실패");
      }
      const data = await response.json();

      // Apify 비동기 모드: pending=true이면 폴링 시작.
      // `api` 모드에서도 공식 Graph API가 조회 못 한 계정(개인계정 등)은 서버가 Apify로 폴백해
      // 같은 pending 형태로 내려온다 — 분기 조건은 그대로 두고 안내 문구만 갈라 준다(조용한 전환 금지).
      if (data.pending && data.runId) {
        toast.info(
          data.fallbackFrom === "api"
            ? "공식 API로 조회되지 않아 보조 수집 경로로 전환했습니다... (최대 1분 소요)"
            : "채널 정보를 수집 중입니다... (최대 1분 소요)",
        );
        const { runId, platform } = data as { runId: string; platform: string };
        const pollUrl = `/api/sellers/${seller.id}/channel-info/poll?runId=${runId}&platform=${platform}`;
        const MAX_POLLS = 30; // 3초 × 30 = 90초
        for (let i = 0; i < MAX_POLLS; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const pollRes = await fetch(pollUrl);
          if (!pollRes.ok) {
            const err = await pollRes.json();
            throw new Error(err.error || "폴링 오류");
          }
          const pollData = await pollRes.json();
          if (!pollData.pending) {
            // 완료
            toast.success("채널 정보 동기화가 완료되었습니다.");
            onUpdated?.({
              ...seller,
              name: pollData.name ?? seller.name,
              currentFollowers: pollData.currentFollowers ?? seller.currentFollowers,
              snsHandle: pollData.snsHandle ?? seller.snsHandle,
              snsType: pollData.snsType ?? seller.snsType,
              channelUrl: seller.channelUrl || targetUrl,
              currentPostsCount: pollData.currentPostsCount !== undefined ? pollData.currentPostsCount : seller.currentPostsCount,
              profileBio: pollData.profileBio !== undefined ? pollData.profileBio : seller.profileBio,
              profilePicUrl: pollData.profilePicUrl !== undefined ? pollData.profilePicUrl : seller.profilePicUrl,
              profileExternalUrls: pollData.profileExternalUrls !== undefined ? encodeExternalUrls(pollData.profileExternalUrls) : seller.profileExternalUrls,
              createdAt: pollData.createdAt ?? seller.createdAt,
            });
            await fetchHistory();
            return;
          }
        }
        throw new Error("동기화 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.");
      }

      // 동기 모드 (mock, YouTube API 등): 즉시 완료
      toast.success("채널 정보 동기화가 완료되었습니다.");
      onUpdated?.({
        ...seller,
        name: data.name ?? seller.name,
        currentFollowers: data.currentFollowers ?? seller.currentFollowers,
        snsHandle: data.snsHandle ?? seller.snsHandle,
        snsType: data.snsType ?? seller.snsType,
        channelUrl: seller.channelUrl || targetUrl,
        currentPostsCount: data.currentPostsCount !== undefined ? data.currentPostsCount : seller.currentPostsCount,
        profileBio: data.profileBio !== undefined ? data.profileBio : seller.profileBio,
        profilePicUrl: data.profilePicUrl !== undefined ? data.profilePicUrl : seller.profilePicUrl,
        profileExternalUrls: data.profileExternalUrls !== undefined ? encodeExternalUrls(data.profileExternalUrls) : seller.profileExternalUrls,
        createdAt: data.createdAt ?? seller.createdAt,
      });
      await fetchHistory();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "동기화 중 오류가 발생했습니다.");
    } finally {
      setSyncing(false);
    }
  };

  // Sync categoryTags from seller.category static cache string to avoid API fetch lag
  useEffect(() => {
    if (!seller || !seller.category) {
      setCategoryTags([]);
      return;
    }
    const parsed = seller.category.split(",").map((name, idx) => ({
      id: `temp-${idx}-${name.trim()}`,
      name: name.trim(),
    }));
    setCategoryTags(parsed);
  }, [seller]);

  // Fetch linked partner info when seller changes
  useEffect(() => {
    let cancelled = false;
    async function fetchLinkedPartner() {
      if (!seller) {
        if (!cancelled) {
          setLinkedPartner(null);
        }
        return;
      }

      if (!seller.agencyId) {
        if (!cancelled) {
          setLinkedPartner(null);
        }
        return;
      }

      try {
        const response = await fetch("/api/partners");
        if (response.ok && !cancelled) {
          const data = await response.json();
          const partners = Array.isArray(data) ? data : data.partners ?? [];
          const partner = partners.find((p: Record<string, unknown>) => String(p.id) === seller.agencyId);
          if (partner) {
            setLinkedPartner({
              id: String(partner.id),
              name: String(partner.name ?? ""),
              type: String(partner.type ?? ""),
              ceoName: partner.ceoName ? String(partner.ceoName) : undefined,
              businessNumber: partner.businessNumber ? String(partner.businessNumber) : undefined,
              representativeEmail: partner.representativeEmail ? String(partner.representativeEmail) : undefined,
              contactInfo: partner.contactInfo ? String(partner.contactInfo) : undefined,
            });
          } else {
            // Partner not found in list, use agencyName as fallback
            if (seller.agencyName) {
              setLinkedPartner({
                id: seller.agencyId!,
                name: seller.agencyName,
                type: "",
              });
            } else {
              setLinkedPartner(null);
            }
          }
        }
      } catch {
        // If we can't fetch partner details, use agencyName as fallback
        if (!cancelled && seller.agencyName) {
          setLinkedPartner({
            id: seller.agencyId!,
            name: seller.agencyName,
            type: "",
          });
        }
      }
    }

    void fetchLinkedPartner();
    return () => {
      cancelled = true;
    };
  }, [seller]);

  // 정산 신원 단건 조회 — 셀러가 바뀌면 펼침 상태도 초기화한다(앞 셀러의 주민번호가
  // 다음 셀러 화면에 펼쳐진 채로 남지 않도록).
  useEffect(() => {
    let cancelled = false;
    setSettlementInfo(null);
    setResidentRevealed(false);
    if (!seller?.id) return;

    fetch(`/api/sellers/${seller.id}/settlement-info`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setSettlementInfo({
          realName: data.realName ?? null,
          residentNumber: data.residentNumber ?? null,
          accountNumber: data.accountNumber ?? null,
        });
      })
      .catch(() => {
        /* 조회 실패는 섹션을 비워둘 뿐 상세 패널을 막지 않는다 */
      });

    return () => {
      cancelled = true;
    };
  }, [seller?.id]);

  // Generic save handler for InlineEditField — PATCHes to /api/sellers/[id]
  const handleFieldSave = async (field: string, value: string | number | boolean) => {
    const patch: Record<string, unknown> = { [field]: value };
    const res = await fetch(`/api/sellers/${seller.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      throw new Error("저장 실패");
    }
    const updated = await res.json();
    const next: SellerSummary = { ...seller, ...patch, ...updated };
    onUpdated?.(next);
    // 인라인 저장 성공은 무음 — InlineEditField의 낙관적 값 갱신이 피드백이고,
    // 실패 토스트는 InlineEditField(withMutationFeedback)가 소유한다. 거래처(usePartners)와 동일 계약.
  };

  // F6: 소개자 선택 옵션 — 셀러 목록 1회 로드(자기 자신 제외, alias 우선 표기)
  const [referrerOptions, setReferrerOptions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sellers")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`목록 조회 실패 (${res.status})`))))
      .then((data) => {
        if (cancelled) return;
        const list: Array<{ id: string; name: string; alias?: string | null }> = Array.isArray(data?.sellers)
          ? data.sellers
          : [];
        setReferrerOptions(
          list
            .filter((s) => s.id !== seller.id)
            .map((s) => ({ value: s.id, label: s.alias || s.name }))
        );
      })
      .catch((e) => console.warn("[seller-detail] 소개자 옵션 로드 실패:", e));
    return () => {
      cancelled = true;
    };
  }, [seller.id]);

  // Compute scorecard with growth rate
  const scorecard = computeScorecardWithGrowth(seller.campaigns ?? [], snapshots);
  const externalUrls = decodeExternalUrls(seller.profileExternalUrls);

  // Handle seller deletion
  const handleDelete = async () => {
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/sellers/${seller.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeleteDialogOpen(false);
        onClose();
        onDeleted?.(seller.id);
        toast.success("셀러가 삭제되었습니다.");
      } else if (res.status === 409) {
        toast.error("연결된 캠페인이 존재하여 삭제할 수 없습니다.");
      } else {
        toast.error("삭제에 실패했습니다.");
      }
    } catch {
      toast.error("삭제에 실패했습니다.");
    } finally {
      setDeleteLoading(false);
    }
  };

  // Prepare chart data from snapshots
  const chartData = snapshots.map((s) => ({
    date: typeof s.snapshotDate === "string"
      ? s.snapshotDate.slice(0, 10)
      : new Date(s.snapshotDate).toISOString().slice(0, 10),
    followers: s.followersCount,
    posts: s.postsCount,
    er: s.er,
    avgLikes: s.avgLikes,
    avgComments: s.avgComments,
  }));

  return (
    <>
      <div className="h-full w-full overflow-y-auto overflow-x-hidden pr-2">
        <div className="space-y-4 p-1.5 w-full max-w-full">
          {/* Editable Fields */}
          <div className="space-y-5 rounded-lg border border-border/70 bg-card p-4">
            {/* 상단 프로필 헤더 */}
            <div className="flex items-center justify-between gap-4">
              <h3 className="text-[13px] font-semibold text-foreground">기본 정보</h3>
              <div className="flex items-center gap-2">
                {/* 리포트 빠른 열람(오너 확인용) — 관리자 세션은 비밀번호 게이트를 우회하므로
                    바로 셀러 라이브 리포트가 열린다. 링크 생성/비번 관리는 하단 카드가 담당. */}
                {seller.portalSlug && (
                  <>
                    <a
                      href={`/${seller.portalSlug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      리포트 열기
                      <ExternalLink className="size-3.5" />
                    </a>
                    {/* 외부 내비게이션(리포트 열기)과 내부 설정(수집 관리)은 성격이 달라 구분선으로 분리 */}
                    <span aria-hidden="true" className="h-4 w-px bg-border/60" />
                  </>
                )}
                <span className="text-xs text-muted-foreground">수집 관리 대상</span>
                <Switch
                  checked={seller.isMonitored ?? false}
                  onCheckedChange={(checked) => handleFieldSave("isMonitored", checked)}
                />
              </div>
            </div>

            {/* Channel URL Field */}
            <div className="col-span-2 border border-border/60 bg-muted/20 p-2.5 rounded-md">
              <ChannelUrlField
                initialUrl={seller.channelUrl ?? ""}
                sellerId={seller.id}
                onSync={handleManualSync}
                syncing={syncing}
                onInfoApplied={(info) => {
                  const applied = applyChannelInfo(
                    {
                      snsType: seller.snsType,
                      snsHandle: seller.snsHandle,
                      name: seller.name,
                      currentFollowers: seller.currentFollowers,
                    },
                    info,
                  );
                  const next: SellerSummary = {
                    ...seller,
                    channelUrl: info.channelUrl || seller.channelUrl,
                    ...(applied.snsType != null && { snsType: applied.snsType as SnsType }),
                    ...(applied.snsHandle != null && { snsHandle: applied.snsHandle }),
                    ...(applied.name != null && { name: applied.name }),
                    ...(applied.currentFollowers != null && { currentFollowers: applied.currentFollowers }),
                  };
                  onUpdated?.(next);
                  toast.success("셀러 정보가 업데이트되었습니다.");
                }}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* 이름 */}
              <InlineEditField
                label="이름"
                value={filterNotionTemp(seller.name) || ""}
                displayValue={filterNotionTemp(seller.name) || "-"}
                fieldType="text"
                onSave={(v) => handleFieldSave("name", v)}
                className="col-span-1 border border-border/60 bg-muted/20 p-2.5 rounded-md"
              />

              {/* 별칭 */}
              <InlineEditField
                label="별칭"
                value={seller.alias || ""}
                displayValue={seller.alias || "-"}
                fieldType="text"
                onSave={(v) => handleFieldSave("alias", v)}
                className="col-span-1 border border-border/60 bg-muted/20 p-2.5 rounded-md"
              />

              {/* SNS 유형 */}
              <div className="col-span-1 flex items-center justify-between border border-border/60 bg-muted/20 p-2.5 rounded-md">
                <span className="text-xs text-muted-foreground">SNS 유형</span>
                <span className="text-xs font-medium text-foreground truncate">
                  {seller.snsType === "INSTAGRAM" ? "Instagram" : "YouTube"}
                </span>
              </div>

              {/* SNS 핸들 */}
              <InlineEditField
                label="SNS 핸들"
                value={filterNotionTemp(seller.snsHandle) || ""}
                displayValue={filterNotionTemp(seller.snsHandle) || "-"}
                fieldType="text"
                onSave={(v) => handleFieldSave("snsHandle", v)}
                className="col-span-1 border border-border/60 bg-muted/20 p-2.5 rounded-md"
              />

              {/* 팔로워 */}
              <InlineEditField
                label="팔로워"
                value={String(seller.currentFollowers)}
                displayValue={seller.currentFollowers.toLocaleString()}
                fieldType="number"
                onSave={(v) => handleFieldSave("currentFollowers", v)}
                className="col-span-1 border border-border/60 bg-muted/20 p-2.5 rounded-md"
              />

              {/* 등록일자 */}
              <div className="col-span-1 flex items-center justify-between border border-border/60 bg-muted/20 p-2.5 rounded-md">
                <span className="text-xs text-muted-foreground">등록일자</span>
                <span className="text-xs font-medium text-foreground">
                  {seller.createdAt ? formatDate(seller.createdAt) : "-"}
                </span>
              </div>

              {/* 적합성 */}
              <div className="col-span-2 flex items-center justify-between border border-border/60 bg-muted/20 p-2.5 rounded-md gap-4">
                <span className="text-xs text-muted-foreground shrink-0">적합성</span>
                <div className="flex gap-1.5 overflow-x-auto no-scrollbar justify-end w-full">
                  {["추천", "보류", "비추천", "미진행"].map((level) => {
                    const isSelected = (seller.fitLevel || "미진행") === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        onClick={() => handleFieldSave("fitLevel", level)}
                        className={cn(
                          "h-7 px-3 rounded-md text-[11px] font-semibold border transition-colors cursor-pointer select-none shrink-0",
                          isSelected ? (
                            (level === "추천" && "bg-emerald-50 text-emerald-700 border-emerald-300 shadow-soft-sm") ||
                            (level === "보류" && "bg-amber-50 text-amber-700 border-amber-300 shadow-soft-sm") ||
                            (level === "비추천" && "bg-rose-50 text-rose-700 border-rose-300 shadow-soft-sm") ||
                            "bg-slate-100 text-slate-700 border-slate-300 shadow-soft-sm"
                          ) : (
                            "bg-white text-slate-500 border-slate-200 hover:text-slate-600 hover:bg-slate-50"
                          )
                        )}
                      >
                        {level}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 카테고리 태그 */}
              <div className="col-span-2 flex items-center justify-between border border-border/60 bg-muted/20 p-2.5 rounded-md gap-4">
                <span className="text-xs text-muted-foreground shrink-0">카테고리</span>
                <div className="flex-1 flex justify-end">
                  <CategoryTagInput
                    selectedTags={categoryTags}
                    maxTags={5}
                    sellerId={seller.id}
                    onTagsChange={(tags) => {
                      setCategoryTags(tags);
                      onUpdated?.({
                        ...seller,
                        category: tags.map((t) => t.name).join(", ") || null,
                      });
                    }}
                    onError={(msg) => toast.error(msg)}
                  />
                </div>
              </div>
            </div>

            {/* 프로필 이미지 & 소개글 — 이미지는 라벨 달린 '데이터 필드'가 아니라 셀러 정체성
                그 자체라 필드 제목·카드 크롬 없이 사진만 정사각형으로 노출한다(오너 확정 2026-07-16). */}
            <div className="grid grid-cols-[auto_1fr] gap-3">
              <SellerProfileImage
                src={seller.profilePicUrl ?? null}
                alt={`${seller.alias || seller.name} 프로필 이미지`}
              />

              {/* 소개글 카드 */}
              <div className="border border-border/60 bg-muted/20 p-2.5 rounded-md text-xs flex flex-col justify-between">
                <div className="flex-1">
                  <span className="text-xs text-muted-foreground block mb-1">소개글</span>
                  <div className="relative">
                    <p className={cn("text-foreground whitespace-pre-wrap leading-relaxed text-[11px]", !bioExpanded && "line-clamp-4")}>
                      {seller.profileBio ? seller.profileBio.trim() : "등록된 소개글이 없습니다."}
                    </p>
                  </div>
                </div>
                {seller.profileBio && (seller.profileBio.split('\n').length > 4 || seller.profileBio.length > 100) && (
                  <button
                    onClick={() => setBioExpanded(!bioExpanded)}
                    className="text-[10px] text-blue-600 font-medium mt-1.5 hover:underline focus:outline-none self-start"
                  >
                    {bioExpanded ? "접기" : "...더보기"}
                  </button>
                )}
              </div>
            </div>

            {/* 외부 링크 */}
            {externalUrls.length > 0 && (
              <div className="border border-border/60 bg-muted/20 p-2.5 rounded-md text-xs">
                <span className="text-xs text-muted-foreground block mb-1.5">외부 링크</span>
                <div className="flex flex-col gap-1.5">
                  {externalUrls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-white/70 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      <span className="truncate">{url}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}


          </div>

          {/* 정산 정보 — 거래처가 연결돼 있으면 거래처 신원을 읽기 전용으로 보여주고,
              없으면 그 자리에서 개인 신원(주민등록번호·계좌)을 직접 입력받는다.

              왜 개인 셀러용 거래처를 따로 만들지 않는가(오너 확정 2026-07-23):
              ① 개인 → 사업자 전환이 실제로 일어나는데(전환자 2명 실측), 거래처를 만들면
                 전환할 때마다 개인용/사업자용 거래처가 둘로 쌓인다.
              ② 거래처는 계약 주체인데 개인 셀러의 계약 주체는 셀러 자신이다.
              ③ 주민등록번호는 소득자 개인에게 귀속되므로 전환해도 바뀌지 않는다.
              전환 대응은 이미 `SalesCampaign.sellerTaxType` 스냅샷이 담당한다 —
              과거 개인 시절 캠페인은 사업자 전환 후에도 INDIVIDUAL 로 남아 원천징수
              대상에 정상 포함된다(`isIndividualSeller` 가 스냅샷을 우선 본다). */}
          <div className="space-y-3 rounded-lg border border-border/70 bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-foreground">정산 정보</h3>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] px-2.5 gap-1"
                onClick={() => setPartnerLinkSearchOpen(true)}
              >
                <Link2 className="size-3" />
                연결
              </Button>
            </div>
            <Separator />
            
            {linkedPartner ? (
              <div className="border border-border/60 bg-muted/10 rounded-lg p-3 h-[74px] flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Building2 className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs font-bold text-foreground truncate">{linkedPartner.name}</span>
                    <Badge variant="outline" className="border-blue-100 bg-blue-50/20 text-blue-600 font-semibold text-[9px] px-1 py-0.2 rounded hover:bg-blue-50/20 leading-none shrink-0">
                      셀러
                    </Badge>
                  </div>
                  <a
                    href={`/partners?q=${encodeURIComponent(linkedPartner.name)}`}
                    className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    title="거래처 상세 페이지로 이동"
                  >
                    <ExternalLink className="size-3" />
                  </a>
                </div>
                
                <div className="flex items-center justify-between gap-2 text-[10px] w-full">
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="border border-border/80 bg-muted/30 px-1 py-0.5 rounded text-[9px] text-muted-foreground font-medium shrink-0 leading-none">
                      대표
                    </span>
                    <span className="text-[10px] text-foreground font-medium truncate">{linkedPartner.ceoName || "—"}</span>
                  </div>
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="border border-border/80 bg-muted/30 px-1 py-0.5 rounded text-[9px] text-muted-foreground font-medium shrink-0 leading-none">
                      사업자번호
                    </span>
                    <span className="text-[10px] text-foreground font-mono truncate">
                      {linkedPartner.businessNumber ? formatBusinessNumber(linkedPartner.businessNumber) : "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="border border-border/80 bg-muted/30 px-1 py-0.5 rounded text-[9px] text-muted-foreground font-medium shrink-0 leading-none">
                      연락처
                    </span>
                    <span className="text-[10px] text-foreground truncate">{linkedPartner.contactInfo || "—"}</span>
                  </div>
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="border border-border/80 bg-muted/30 px-1 py-0.5 rounded text-[9px] text-muted-foreground font-medium shrink-0 leading-none">
                      이메일
                    </span>
                    <span className="text-[10px] text-foreground truncate" title={linkedPartner.representativeEmail || ""}>
                      {linkedPartner.representativeEmail || "—"}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <p className="text-[10px] text-muted-foreground">
                  연결된 거래처가 없어 <span className="font-medium text-foreground">개인(원천징수 3.3%)</span>으로
                  처리됩니다. 원천징수 신고에는 실명과 주민등록번호가 필요합니다.
                </p>
                {/* 단일 컬럼(전체폭) — "주민등록번호"·"정산 계좌번호"(6자)는 이 컴포넌트가
                    쓰는 다른 라벨(2~4자)보다 훨씬 길어서, grid-cols-2 반폭 칸에서는
                    라벨이 줄바꿈되며 툴팁 아이콘과 겹쳤다(실사고). "유입 메모"가 이미
                    col-span-2 로 전체폭을 쓰는 것과 같은 패턴 — 짧은 라벨끼리만 반폭 2열. */}
                <div className="flex flex-col gap-3">
                  {/* 실명은 위 「이름」(=활동명이 들어가는 자리)과 다른 값이다 — 신고 서식은
                      법적 실명을 요구하므로 정산 정보 안에 주민등록번호와 짝으로 둔다. */}
                  <InlineEditField
                    label="실명"
                    description="원천징수 신고·간이지급명세서의 소득자 성명(활동명 아님)"
                    descriptionAsTooltip
                    value={settlementInfo?.realName ?? ""}
                    displayValue={settlementInfo?.realName || "-"}
                    fieldType="text"
                    onSave={async (v) => {
                      await handleFieldSave("realName", v);
                      setSettlementInfo((prev) => ({
                        residentNumber: prev?.residentNumber ?? null,
                        accountNumber: prev?.accountNumber ?? null,
                        realName: String(v) || null,
                      }));
                    }}
                    className="border border-border/60 bg-muted/20 p-2.5 rounded-md"
                  />
                  <InlineEditField
                    label="주민등록번호"
                    description="원천징수 신고·간이지급명세서 제출용"
                    descriptionAsTooltip
                    // 13자리를 홈택스에 그대로 옮겨 적는 값이라 말줄임 금지
                    preserveValueText
                    value={settlementInfo?.residentNumber ?? ""}
                    displayValue={
                      settlementInfo?.residentNumber
                        ? residentRevealed
                          ? settlementInfo.residentNumber
                          : maskResidentNumber(settlementInfo.residentNumber)
                        : "-"
                    }
                    fieldType="text"
                    onSave={async (v) => {
                      await handleFieldSave("residentNumber", v);
                      setSettlementInfo((prev) => ({
                        realName: prev?.realName ?? null,
                        accountNumber: prev?.accountNumber ?? null,
                        residentNumber: String(v) || null,
                      }));
                    }}
                    className="border border-border/60 bg-muted/20 p-2.5 rounded-md"
                  />
                  <InlineEditField
                    label="정산 계좌번호"
                    value={settlementInfo?.accountNumber ?? ""}
                    displayValue={settlementInfo?.accountNumber || "-"}
                    fieldType="text"
                    onSave={async (v) => {
                      await handleFieldSave("accountNumber", v);
                      setSettlementInfo((prev) => ({
                        realName: prev?.realName ?? null,
                        residentNumber: prev?.residentNumber ?? null,
                        accountNumber: String(v) || null,
                      }));
                    }}
                    className="border border-border/60 bg-muted/20 p-2.5 rounded-md"
                  />
                </div>
                {settlementInfo?.residentNumber ? (
                  <button
                    type="button"
                    onClick={() => setResidentRevealed((v) => !v)}
                    className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                  >
                    {residentRevealed ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                    {residentRevealed ? "주민등록번호 가리기" : "주민등록번호 보기"}
                  </button>
                ) : null}
              </div>
            )}
          </div>

          {/* F6 유입 경로 — 소개 기반 플라이휠의 outcome 적립 입력면 (GROWTH_FLYWHEEL_PLAN.md §F6).
              가용 일정 필드는 제거됐다(오너 확정 2026-07-16: 미리 파악하고 있는 개념이 아님) —
              DB 필드(availabilityNote)와 재캠페인 알림 표시는 보존, 입력면만 없앤다. */}
          <div className="space-y-3 rounded-lg border border-border/70 bg-card p-4">
            <h3 className="text-[13px] font-semibold text-foreground">유입 경로</h3>
            <Separator />
            <div className="grid grid-cols-2 gap-3">
              <InlineEditField
                label="유입 경로"
                value={seller.acquisitionChannel ?? ""}
                displayValue={
                  seller.acquisitionChannel
                    ? acquisitionChannelLabels[seller.acquisitionChannel] ?? seller.acquisitionChannel
                    : "-"
                }
                fieldType="select"
                options={Object.entries(acquisitionChannelLabels).map(([value, label]) => ({ value, label }))}
                onSave={(v) => handleFieldSave("acquisitionChannel", v)}
                className="col-span-1 border border-border/60 bg-muted/20 p-2.5 rounded-md"
              />
              <InlineEditField
                label="소개자"
                description="유입 경로가 '소개'일 때 소개해준 셀러"
                descriptionAsTooltip
                value={seller.referredById ?? ""}
                displayValue={seller.referredByName ?? "-"}
                fieldType="searchable-select"
                options={referrerOptions}
                onSave={(v) => handleFieldSave("referredById", v)}
                className="col-span-1 border border-border/60 bg-muted/20 p-2.5 rounded-md"
              />
              <InlineEditField
                label="유입 메모"
                value={seller.acquisitionNote ?? ""}
                displayValue={seller.acquisitionNote || "-"}
                fieldType="text"
                onSave={(v) => handleFieldSave("acquisitionNote", v)}
                className="col-span-2 border border-border/60 bg-muted/20 p-2.5 rounded-md"
              />
            </div>
          </div>

          {/* 선택지 문구는 `LEVELS`(reviewMapping.ts) 가 유일 정본이다 — 종전엔 같은 배열을
              여기 손으로 한 벌 더 적어, AI 제안이 쓰는 어휘와 화면 선택지가 조용히 갈릴 수
              있었다(2026-08-04 광고 반응 문구 개정에서 실제로 위험했다). */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StepMetricCard
              label="공구 활성화"
              value={seller.collaborationScore ?? ""}
              levels={LEVELS.collaborationScore}
              onSave={(v) => handleFieldSave("collaborationScore", v)}
            />
            <StepMetricCard
              label="광고 반응"
              value={seller.adResponseScore ?? ""}
              levels={LEVELS.adResponseScore}
              onSave={(v) => handleFieldSave("adResponseScore", v)}
            />
            <StepMetricCard
              label="댓글 반응"
              value={seller.commentResponseScore ?? ""}
              levels={LEVELS.commentResponseScore}
              onSave={(v) => handleFieldSave("commentResponseScore", v)}
            />
            <StepMetricCard
              label="활동 빈도"
              value={seller.activityFrequency ?? ""}
              levels={LEVELS.activityFrequency}
              onSave={(v) => handleFieldSave("activityFrequency", v)}
            />
          </div>

          {/* AI 분석 (§12-4) — 수동 평가(위 4필드) 바로 아래 배치: "입력 → AI 대조 → 검토 확정"의
              판단 순서를 만든다(UX 감사 P1-1). 성과/차트 등 다른 섹션은 이 판단 뒤로 밀린다. */}
          <Accordion type="single" collapsible defaultValue="ai-analysis" className="w-full">
            <AccordionItem value="ai-analysis" className="border rounded-lg border-border/70 bg-card px-4 py-1">
              <AccordionTrigger className="hover:no-underline py-3">
                <h3 className="text-[13px] font-semibold text-foreground">AI 분석</h3>
              </AccordionTrigger>
              <AccordionContent className="pb-3">
                <Separator className="mb-3" />
                <SellerAiAnalysis
                  sellerId={seller.id}
                  snsType={seller.snsType}
                  current={{
                    activityFrequency: seller.activityFrequency ?? null,
                    adResponseScore: seller.adResponseScore ?? null,
                    commentResponseScore: seller.commentResponseScore ?? null,
                    collaborationScore: seller.collaborationScore ?? null,
                    category: seller.category ?? null,
                    fitLevel: seller.fitLevel ?? null,
                  }}
                  onAutoApplied={(patch) => {
                    // 저장은 analyze 라우트가 서버에서 이미 끝냈다(오너 확정 2026-07-16 자동반영).
                    // 여기서는 부모 셀러 상태만 동기화 — 위 평가 카드·'현재' 컬럼이 낡지 않게.
                    onUpdated?.({ ...seller, ...patch });
                  }}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* Scorecard */}
          <div className="space-y-3 rounded-lg border border-border/70 bg-card p-4">
            <h3 className="text-[13px] font-semibold text-foreground">성과 요약</h3>
            <Separator />
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-border/70 bg-white/90 p-3">
                <div className="text-[11px] text-muted-foreground">누적 매출</div>
                <div className="mt-1 font-mono text-xs font-semibold">
                  {formatCurrency(scorecard.cumulativeSales)}
                </div>
              </div>
              <div className="rounded-lg border border-border/70 bg-white/90 p-3">
                <div className="text-[11px] text-muted-foreground">캠페인 수</div>
                {/* 유효 캠페인 수(그룹=1건, 캡 무관 서버 집계) 우선 — scorecard 는 12건 캡 배열
                    기반 폴백. 딜 행 수가 더 크면 병기(오너 G3)로 축소 오독을 막는다. */}
                <div className="mt-1 font-mono text-xs font-semibold">
                  {seller.campaignCount ?? scorecard.campaignCount}
                  {(seller.campaignRowCount ?? 0) > (seller.campaignCount ?? scorecard.campaignCount) && (
                    // font-sans: 부모 font-mono(값 자릿수 정렬용)가 메타 병기까지 새지 않게(ss-ux P2).
                    // "N개 딜" 표기는 mobile-campaign-card 그룹 배지와 통일.
                    <span className="ml-1 font-sans font-normal text-[10px] text-muted-foreground">
                      · {seller.campaignRowCount}개 딜
                    </span>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-border/70 bg-white/90 p-3">
                <div className="text-[11px] text-muted-foreground">팔로워 성장률</div>
                <div className="mt-1 font-mono text-xs font-semibold">
                  {scorecard.followerGrowthRate != null ? (
                    <span className={scorecard.followerGrowthRate >= 0 ? "text-green-600" : "text-red-600"}>
                      {scorecard.followerGrowthRate >= 0 ? "+" : ""}
                      {formatRate(scorecard.followerGrowthRate)}
                    </span>
                  ) : (
                    "-"
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Growth Trend Chart */}
          {!loadingSnapshots && (
            <SellerGrowthChart data={chartData} growthRate={scorecard.followerGrowthRate} />
          )}

          {/* ER Trend Chart (§11-3) — 팔로워=규모, ER=반응 밀도로 판단 축이 달라 별도 카드 */}
          {!loadingSnapshots && <SellerErChart data={chartData} />}

          {/* 셀러 전용 리포트 링크 — 성과 요약·차트 뒤(성과 그룹 마무리)에 배치. 빠른 열람은 상단
              '리포트 열기' 버튼이 담당하고, 이 카드는 링크 생성·비밀번호 관리(간헐적)를 담당한다. */}
          <SellerPortalLinkSection
            sellerId={seller.id}
            initialToken={seller.portalToken}
            initialSlug={seller.portalSlug}
            initialHasPassword={seller.hasPortalPassword}
            suggestedSlug={suggestPortalSlug(seller.snsHandle)}
          />

          {/* 데이터 수집 */}
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="followers" className="border rounded-lg border-border/70 bg-card px-4 py-1">
              <AccordionTrigger className="hover:no-underline py-3">
                <h3 className="text-[13px] font-semibold text-foreground">데이터 수집</h3>
              </AccordionTrigger>
              <AccordionContent className="pb-3">
                <Separator className="mb-3" />
                
                <AnimatedTabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                  <div className="flex items-center justify-between mb-3 gap-2">
                    <AnimatedTabsList className="bg-muted/50 rounded-md p-0.5 inline-flex h-8 w-[240px]">
                      <AnimatedTabsTrigger value="profile" className="text-[11px] font-semibold rounded-sm h-7 flex-1">프로필 데이터</AnimatedTabsTrigger>
                      <AnimatedTabsTrigger value="bio" className="text-[11px] font-semibold rounded-sm h-7 flex-1">소개글 이력</AnimatedTabsTrigger>
                    </AnimatedTabsList>

                    {activeTab === "profile" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px] px-2.5 gap-1 hover:bg-slate-50 transition-colors font-semibold"
                        onClick={() => setShowAddHistory(!showAddHistory)}
                      >
                        {showAddHistory ? (
                          <>
                            <X className="size-3" />
                            취소
                          </>
                        ) : (
                          <>
                            <Plus className="size-3" />
                            추가
                          </>
                        )}
                      </Button>
                    )}
                  </div>

                  <AnimatedTabsContent value="profile" className="space-y-3 mt-0">
                    {/* 내역 추가 폼 */}
                    {showAddHistory && (
                      <form onSubmit={handleAddHistory} className="rounded-lg border border-border/50 bg-white/60 p-3.5 animate-fade-in-up shadow-soft-sm">
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                          <div className="space-y-1 col-span-1">
                            <label className="text-[10px] font-bold text-muted-foreground">날짜</label>
                            <input
                              type="date"
                              required
                              value={newSnapshotDate}
                              onChange={(e) => setNewSnapshotDate(e.target.value)}
                              className="w-full rounded border border-border/80 px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none"
                            />
                          </div>
                          <div className="space-y-1 col-span-1">
                            <label className="text-[10px] font-bold text-muted-foreground">팔로워 수</label>
                            <input
                              type="number"
                              required
                              min="0"
                              placeholder="예: 15000"
                              value={newFollowersCount}
                              onChange={(e) => setNewFollowersCount(e.target.value)}
                              className="w-full rounded border border-border/80 px-2.5 py-1.5 text-xs font-mono focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none"
                            />
                          </div>
                          <div className="space-y-1 col-span-1">
                            <label className="text-[10px] font-bold text-muted-foreground">게시물 수</label>
                            <input
                              type="number"
                              min="0"
                              placeholder="예: 250"
                              value={newPostsCount}
                              onChange={(e) => setNewPostsCount(e.target.value)}
                              className="w-full rounded border border-border/80 px-2.5 py-1.5 text-xs font-mono focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none"
                            />
                          </div>
                          <div className="flex justify-end gap-1.5 col-span-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-xs h-8 text-muted-foreground hover:text-foreground hover:bg-slate-100"
                              onClick={() => {
                                setShowAddHistory(false);
                                setNewSnapshotDate("");
                                setNewFollowersCount("");
                                setNewPostsCount("");
                              }}
                            >
                              취소
                            </Button>
                            <Button type="submit" size="sm" className="text-xs h-8 font-semibold" disabled={addingHistory}>
                              {addingHistory && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                              저장
                            </Button>
                          </div>
                        </div>
                      </form>
                    )}

                    {/* 내역 목록 */}
                    {loadingSnapshots ? (
                      <p className="text-xs text-muted-foreground text-center py-4">로딩 중...</p>
                    ) : snapshots.length === 0 ? (
                      <DataEmpty title="수집된 프로필 데이터 내역이 없습니다" className="py-6" />
                    ) : (
                      <div className="w-full rounded-lg border border-border/50 bg-white/30 shadow-soft-sm overflow-hidden">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead>
                            <tr className="border-b border-border/50 bg-muted/60 text-[10px] font-semibold text-muted-foreground sticky top-0 backdrop-blur-sm z-10">
                              <th className="px-3 py-2.5">날짜</th>
                              <th className="px-3 py-2.5 text-right">팔로워 수</th>
                              <th className="px-3 py-2.5 text-right">게시물 수</th>
                              <th className="px-3 py-2.5 text-center">수집 경로</th>
                              <th className="px-3 py-2.5 text-center w-12">삭제</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...snapshots].reverse().map((snapshot) => (
                              <tr key={snapshot.id} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                                <td className="px-3 py-2 font-medium text-foreground">
                                  {formatDate(snapshot.snapshotDate)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-medium text-foreground">
                                  {snapshot.followersCount.toLocaleString()}
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-medium text-foreground">
                                  {snapshot.postsCount != null ? snapshot.postsCount.toLocaleString() : "—"}
                                </td>
                                <td className="px-3 py-2 text-center">
                                  {snapshot.source === "MANUAL" ? (
                                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[9px] text-blue-700 font-semibold border border-blue-200">수동</span>
                                  ) : (
                                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] text-emerald-700 font-semibold border border-emerald-200">자동</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground hover:text-red-600 hover:bg-red-50 rounded"
                                    onClick={() => handleDeleteHistory(snapshot.id)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </AnimatedTabsContent>

                  <AnimatedTabsContent value="bio" className="mt-0">
                    {bioHistories.length === 0 ? (
                      <div className="py-6 text-center text-xs text-muted-foreground border rounded-lg border-border/40 bg-white/30">
                        소개글 변경 이력이 없습니다
                      </div>
                    ) : (
                      <div className="space-y-2.5 w-full">
                        {bioHistories.map((history) => (
                          <div key={history.id} className="rounded-lg border border-border/40 bg-white/40 p-3 space-y-1.5 shadow-soft-sm transition-colors hover:bg-white/60">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-muted-foreground font-semibold">
                                {formatDate(history.collectedAt)}
                              </span>
                              {history.source === "MANUAL" ? (
                                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[9px] text-blue-700 font-semibold border border-blue-200">수동</span>
                              ) : (
                                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] text-emerald-700 font-semibold border border-emerald-200">자동</span>
                              )}
                            </div>
                            <p className="text-[11px] text-foreground whitespace-pre-wrap bg-white/50 p-2.5 rounded border border-border/20 leading-relaxed font-sans">
                              {history.bio.trim() || "(소개글 없음)"}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </AnimatedTabsContent>
                </AnimatedTabs>
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* Campaign History Table */}
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="campaigns" className="border rounded-lg border-border/70 bg-card px-4 py-1">
              <AccordionTrigger className="hover:no-underline py-3">
                <h3 className="text-[13px] font-semibold text-foreground">캠페인 이력</h3>
              </AccordionTrigger>
              <AccordionContent className="pb-3">
                <Separator className="mb-4" />
                {seller.campaigns?.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    캠페인 이력이 없습니다.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {seller.campaigns?.map(c => {
                      const isCompleted = c.status === "COMPLETED";
                      return (
                        <div key={c.id} className="flex items-center justify-between rounded-lg border border-border/50 p-2.5 px-3.5">
                          <div className="flex flex-col gap-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[12px] font-semibold text-foreground truncate">{c.dealName} - {seller.name}</span>
                              {c.brandName && (
                                <div className="flex items-center gap-1 shrink-0">
                                  <Badge variant="outline" className="h-[16px] px-1.5 text-[9px] font-normal text-muted-foreground rounded-full bg-slate-50 border-slate-200/80 leading-none">
                                    브랜드
                                  </Badge>
                                  <span className="text-[10px] text-muted-foreground">{c.brandName}</span>
                                </div>
                              )}
                            </div>
                            <div className="text-[10px] text-muted-foreground font-medium">
                              기간: {c.startDate ? formatDate(c.startDate) : "-"} ~ {c.endDate ? formatDate(c.endDate) : "-"} <span className="mx-0.5 text-muted-foreground/50">·</span> 매출: {c.actualSales != null ? formatCurrency(c.actualSales) : "-"}
                            </div>
                          </div>
                          <div className="shrink-0 ml-3">
                            <Badge
                              variant="secondary"
                              className={cn(
                                "text-[9px] px-2 py-0.5 rounded-full font-semibold border transition-colors leading-none",
                                isCompleted
                                  ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-50 border-emerald-200/60"
                                  : "bg-slate-100 text-slate-600 hover:bg-slate-100 border-transparent"
                              )}
                            >
                              {campaignStatusLabels[c.status as CampaignStatus] ?? c.status}
                            </Badge>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>



          {/* Activity Timeline */}
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="activity" className="border rounded-lg border-border/70 bg-card px-4 py-1">
              <AccordionTrigger className="hover:no-underline py-3">
                <h3 className="text-[13px] font-semibold text-foreground">활동 기록</h3>
              </AccordionTrigger>
              <AccordionContent className="pb-3">
                <Separator className="mb-3" />
                <ActivityTimeline
                  entityType="SELLER"
                  entityId={seller.id}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* 제안 후보 딜 (D2② — 읽기 전용) */}
          <SellerDealCandidates sellerId={seller.id} />

          {/* 첨부 자료 */}
          <SellerAssetSection sellerId={seller.id} />

          {/* Delete Button */}
          <div className="border-t border-border/70 pt-4">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="mr-1 size-3.5" />
              셀러 삭제
            </Button>
          </div>
        </div>
      </div>

      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        entityName={seller.name}
        entityType="셀러"
        onConfirm={handleDelete}
        loading={deleteLoading}
      />



      <LinkSearchDialog
        open={partnerLinkSearchOpen}
        onOpenChange={setPartnerLinkSearchOpen}
        entityType="partner"
        searchEndpoint="/api/search/partners"
        title="연결할 거래처 검색"
        placeholder="거래처명 검색"
        onSelect={async (item) => {
          try {
            const res = await fetch("/api/links/seller-partner", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sellerId: seller.id, partnerId: item.id }),
            });
            if (!res.ok) throw new Error("연결 실패");
            setLinkedPartner({
              id: item.id,
              name: item.label,
              type: item.metadata?.type ?? "",
              ceoName: item.metadata?.ceoName || undefined,
              businessNumber: item.metadata?.businessNumber || undefined,
              representativeEmail: item.metadata?.representativeEmail || undefined,
              contactInfo: item.metadata?.contactInfo || undefined,
            });
            toast.success("거래처가 연결되었습니다.");
            setPartnerLinkSearchOpen(false);
            onUpdated?.({ ...seller, agencyId: item.id, agencyName: item.label });
          } catch {
            toast.error("거래처 연결에 실패했습니다.");
          }
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// SellerAssetSection — 셀러 상세 패널 내 파일 업로드·목록 섹션
// ---------------------------------------------------------------------------

const SELLER_ASSET_SECTIONS: { value: AssetSection; label: string }[] = [
  { value: "PRODUCT_INTRO", label: assetSectionLabels["PRODUCT_INTRO"] },
  { value: "PRICE_TABLE", label: assetSectionLabels["PRICE_TABLE"] },
  { value: "SNS_CREATIVE", label: assetSectionLabels["SNS_CREATIVE"] },
  { value: "CONTRACT_SETTLEMENT", label: assetSectionLabels["CONTRACT_SETTLEMENT"] },
  { value: "ETC", label: assetSectionLabels["ETC"] },
];

type AssetItem = {
  id: string;
  fileName: string;
  section: string;
  sizeBytes: number;
  externalUrl?: string | null;
  archivedAt?: string | null;
};

/**
 * 셀러 프로필 이미지 — 라벨 없는 정사각형(모서리 약간 둥근, 오너 확정 2026-07-16).
 * 로드 실패 시 깨진 이미지 아이콘 대신 플레이스홀더로 강등한다: 서명 CDN URL이 만료된
 * 구 레코드 대응(영구 URL 치유는 history GET가 백그라운드로 수행 — seller-profile-image.ts).
 */
function SellerProfileImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  // 패널이 다른 셀러로 재사용될 때 실패 상태가 새 이미지에 들러붙지 않게 리셋
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const showImage = Boolean(src) && !failed;
  return (
    <div className="aspect-square w-28 shrink-0 self-start overflow-hidden rounded-lg border border-border/70 bg-muted shadow-soft-sm flex items-center justify-center">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src as string}
          alt={alt}
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <ImageIcon aria-hidden="true" className="size-6 text-muted-foreground" />
      )}
    </div>
  );
}

function SellerAssetSection({ sellerId }: { sellerId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<AssetSection>("SNS_CREATIVE");
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/assets?entityType=SELLER&entityId=${encodeURIComponent(sellerId)}`)
      .then((r) => r.json())
      .then((data: { assets?: AssetItem[] }) => {
        if (data.assets) setAssets(data.assets);
      })
      .catch(() => undefined);
  }, [sellerId]);

  async function handleUpload(file: File) {
    setBusy(true);
    setErrorMsg(null);
    const formData = new FormData();
    formData.set("entityType", "SELLER");
    formData.set("entityId", sellerId);
    formData.set("section", section);
    formData.set("file", file);
    const res = await fetch("/api/assets", { method: "POST", body: formData });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErrorMsg((data as { error?: string }).error ?? "업로드 실패");
      return;
    }
    const typed = data as { asset?: AssetItem };
    if (typed.asset) setAssets((prev) => [typed.asset!, ...prev]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleArchive(assetId: string) {
    const res = await fetch(`/api/assets/${assetId}`, { method: "PATCH" });
    if (!res.ok) return;
    const data = (await res.json()) as { asset: AssetItem };
    setAssets((prev) => prev.map((a) => (a.id === assetId ? data.asset : a)));
  }

  async function handleOpen(assetId: string) {
    const res = await fetch(`/api/assets/${assetId}?download=1`);
    const data = (await res.json()) as { downloadUrl?: string };
    if (data.downloadUrl) window.open(data.downloadUrl, "_blank", "noreferrer");
  }

  const visibleAssets = assets.filter((a) => !a.archivedAt);

  return (
    <section className="rounded-lg border border-border/70 bg-card p-4">
      <h3 className="text-xs font-semibold text-foreground">첨부 자료</h3>
      <p className="mt-1 text-xs text-muted-foreground">SNS 크리에이티브, 포트폴리오 등 관련 파일을 첨부합니다.</p>

      <div className="mt-3 flex gap-2">
        <div className="flex-1">
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as AssetSection)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring"
          >
            {SELLER_ASSET_SECTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <label
          className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-input px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary ${
            busy ? "pointer-events-none opacity-50" : ""
          }`}
        >
          <Upload className="size-3.5" />
          {busy ? "업로드 중..." : "파일 선택"}
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            accept=".pdf,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.doc,.docx"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
        </label>
      </div>
      {errorMsg ? <p className="mt-1.5 text-xs text-destructive">{errorMsg}</p> : null}

      {visibleAssets.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {visibleAssets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-white/80 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{asset.fileName}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {assetSectionLabels[asset.section as AssetSection]} · {formatBytes(asset.sizeBytes)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 gap-0.5">
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                  onClick={() => void handleOpen(asset.id)}
                  title="열기"
                >
                  <ExternalLink className="size-3" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                  onClick={() => void handleArchive(asset.id)}
                  title="보관"
                >
                  <Archive className="size-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 rounded-md border border-dashed border-border/50 bg-slate-50/60 py-4 text-center text-xs text-muted-foreground">
          첨부된 파일이 없습니다.
        </div>
      )}
    </section>
  );
}
