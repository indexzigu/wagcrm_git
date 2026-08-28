"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CircleDashed,
  Clock,
  CopyPlus,
  ExternalLink,
  FileSpreadsheet,
  FolderOpen,
  Link2,
  Play,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  assetProviderLabels,
  assetSectionLabels,
  type AssetRow,
  type AssetSection,
  type CampaignRow,
  type StorageSummary,
} from "@/lib/crm-types";
import { formatBytes, formatDate } from "@/lib/format";
import { isSellerPostAsset } from "@/lib/campaign-content";
import {
  computeCampaignPerformance,
  aggregateErByFormat,
  type PerfPost,
} from "@/lib/campaign-performance-report";
import { mergeSellerPostFeed, dedupeSellerPostsByUrl } from "@/lib/campaign-post-feed";
import type { SuggestedPost } from "@/lib/campaign-suggested-posts";
import type { CampaignStory } from "@/lib/crm-types";
import { instagramShortcode, isInstagramPermalink } from "@/lib/instagram-embed";
import { deriveLinkName, normalizeReferenceUrl, postIdentityKey } from "@/lib/reference-url";
import { InstagramEmbed } from "./instagram-embed";
import { SellerContentCollectButton } from "./seller-content-collect-button";

/** 수집·게시 시각 표기(KST, "M/D HH:mm") — formatDate는 날짜만이라 시:분이 필요한 수집시각 전용. */
function formatCollectedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const sectionOrder: AssetSection[] = [
  "PRODUCT_INTRO",
  "PRICE_TABLE",
  "GROUP_BUY_PRICE",
  "DETAIL_PAGE",
  "SNS_CREATIVE",
  "CONTRACT_SETTLEMENT",
  "ETC",
];

type AssetManagerProps = {
  campaign: CampaignRow;
  initialAssets: AssetRow[];
  storage: StorageSummary;
  onCampaignUpdated?: (campaign: CampaignRow) => void;
};

/**
 * 게시물 그리드 셀의 공통 썸네일 — 세로형(4:5) 이미지(=원본 게시물 열기 링크) + 릴스/영상 배지.
 * 통합 피드의 후보·등록 카드가 공유한다. thumb 없으면 Link2 플레이스홀더, href 없으면 비링크 div.
 * 식별 우선: 담당자는 URL이 아니라 썸네일로 "이 캠페인 게시물인지"를 판단한다.
 */
function PostThumb({
  href,
  thumb,
  mediaType,
  videoUrl,
}: {
  href: string | null;
  thumb: string | null;
  mediaType?: string | null;
  videoUrl?: string | null;
}) {
  const isReelish = mediaType === "reel" || mediaType === "video";
  // 세로형 피드(IG 표준 4:5) — 정사각보다 세로가 25% 길다. 추천·등록 두 카드가 공유하는 썸네일.
  const shell = "group relative block aspect-[4/5] bg-muted overflow-hidden";
  const [isHovered, setIsHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (isHovered && videoRef.current) {
      videoRef.current.play().catch(() => {});
    } else if (!isHovered && videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [isHovered]);

  const inner = (
    <>
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 pointer-fine:group-hover:scale-105"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Link2 className="size-6 text-muted-foreground/50" />
        </div>
      )}
      
      {videoUrl && (
        <video
          ref={videoRef}
          src={videoUrl}
          muted
          loop
          playsInline
          className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${
            isHovered ? "opacity-100" : "opacity-0"
          }`}
        />
      )}

      {isReelish ? (
        <span className="absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-0.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          <Play className="size-2.5 fill-white text-white" />
          {mediaType === "reel" ? "릴스" : "영상"}
        </span>
      ) : null}
    </>
  );

  const events = {
    onMouseEnter: () => setIsHovered(true),
    onMouseLeave: () => setIsHovered(false),
  };

  if (!href) return <div className={shell} {...events}>{inner}</div>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label="원본 게시물 열기"
      className={`${shell} outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring`}
      {...events}
    >
      {inner}
    </a>
  );
}

export function AssetManager({
  campaign,
  initialAssets,
  storage,
  onCampaignUpdated,
}: AssetManagerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState(initialAssets);
  const [section, setSection] = useState<AssetSection>("PRODUCT_INTRO");
  const [notes, setNotes] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [longTermArchive, setLongTermArchive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 셀러 게시물(R5) — 실게시물 URL 등록·딜 레퍼런스 복사 상태
  const [sellerPostUrl, setSellerPostUrl] = useState("");
  const [sellerPostBusy, setSellerPostBusy] = useState(false);
  const [sellerPostError, setSellerPostError] = useState<string | null>(null);
  const [sellerPostNotice, setSellerPostNotice] = useState<string | null>(null);
  const [promoteBusyId, setPromoteBusyId] = useState<string | null>(null);
  // 등록 게시물 "제외(무관)" 진행 중인 asset id — 후보 무관(dismissingPostUrl)의 등록판.
  const [droppingPostId, setDroppingPostId] = useState<string | null>(null);
  // 추천 게시물(후보②) — seller-analysis 수집 피드에서 캠페인 홍보 후보 자동 제시
  const [suggestions, setSuggestions] = useState<SuggestedPost[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [addingSuggestion, setAddingSuggestion] = useState<string | null>(null);
  // 후보 "무관" 분류 진행 중인 permalink(스토리 classifyingStoryId와 동형).
  const [dismissingPostUrl, setDismissingPostUrl] = useState<string | null>(null);
  // 추천 피드를 마지막으로 수집·분석한 시각(SellerAiProfile.analyzedAt).
  const [feedCollectedAt, setFeedCollectedAt] = useState<string | null>(null);
  // 수동 "지금 수집" 종료 후 후보·스토리 재조회 트리거 — 아래 두 fetch effect 의 deps 에 포함.
  const [contentRefreshKey, setContentRefreshKey] = useState(0);
  // 검토 기간(마감 +7일)이 지난 캠페인인지 — 서버가 미분류 후보·스토리를 접어서 보낸 상태.
  // 두 라우트가 같은 판정을 하므로 후보 응답 하나만 신뢰원으로 삼는다(스토리 응답은 중복 신호).
  const [reviewClosed, setReviewClosed] = useState(false);
  // 접힌 미분류분을 되살려 본다 — 뒤늦게 올라온 홍보 게시물을 등록할 탈출구(기본은 접힘).
  const [showClosedReview, setShowClosedReview] = useState(false);
  // 그룹(조합) 캠페인의 게시물 공유 범위(오너 2026-07-13: 그룹은 홍보 게시물을 개별 운영하지 않음).
  // suggested-posts 응답(sharedCampaignIds)이 채운다 — 미그룹·로드 전에는 자기 자신뿐.
  const [sharedCampaignIds, setSharedCampaignIds] = useState<string[]>([campaign.id]);
  // 셀러 스토리(캠페인 통합) — 수집창(시작−7일~마감+1일) 안 스토리를 최신순 검토·분류.
  // 스토리는 좋아요/댓글이 없다(인스타 특성) — 게시시각·수집시각·영상 여부·분류만 다룬다.
  const [stories, setStories] = useState<CampaignStory[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(false);
  const [storiesError, setStoriesError] = useState<string | null>(null);
  const [storyCapturedAt, setStoryCapturedAt] = useState<string | null>(null);
  const [classifyingStoryId, setClassifyingStoryId] = useState<string | null>(null);
  // 인스타 임베드(③b) 펼침 상태 — 키로 게시물을 식별(등록=asset.id, 추천=permalink).
  const [expandedEmbeds, setExpandedEmbeds] = useState<Set<string>>(new Set());
  function toggleEmbed(key: string) {
    setExpandedEmbeds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  // 포맷별 반응(③b 후속) — media_type 맵(shortcode→포맷). 등록 게시물을 포맷별 ER로 묶는다.
  const [formatMap, setFormatMap] = useState<Record<string, string>>({});
  // 성과 카드 객단가 정합용 — 진짜 주문건수(distinct)를 읽기 전용 라우트에서 가져온다(없으면 null).
  const [orderStats, setOrderStats] = useState<{ distinctOrderCount: number | null } | null>(null);

  const visibleAssets = useMemo(
    () =>
      assets.filter(
        (asset) =>
          asset.entityType === "CAMPAIGN" &&
          asset.entityId === campaign.id &&
          asset.section === section &&
          !asset.archivedAt,
      ),
    [assets, campaign.id, section],
  );
  // 셀러 게시물: 섹션 탭과 무관하게 캠페인의 외부링크 자산 전체(미보관)를 모아 별도 그룹으로 보여준다.
  // 그룹(조합) 캠페인이면 멤버 전체(sharedCampaignIds)의 등록 게시물을 공유해 보여준다 — 셀러는
  // 캠페인별 개별 게시물을 올리지 않는다(오너 2026-07-13). 자료관리(visibleAssets)는 캠페인별 유지.
  const sellerPosts = useMemo(() => {
    const shared = new Set(sharedCampaignIds);
    return assets.filter(
      (asset) => shared.has(asset.entityId) && isSellerPostAsset(asset),
    );
  }, [assets, sharedCampaignIds]);
  // 그룹(조합) 캠페인은 같은 셀러 게시물이 여러 회차에 각각 등록돼 있을 수 있다(오너 실측: 한 URL
  // 3회차 등록). URL별 대표 1장만 피드·성과에 쓰고(dedupeSellerPostsByUrl), "제외"(무관) 시 같은
  // URL의 모든 회차 asset을 byPermalink로 함께 보관한다. 로직·회귀는 campaign-post-feed 테스트가 고정.
  const { deduped: dedupedSellerPosts, byPermalink: assetsByPermalink } = useMemo(
    () => dedupeSellerPostsByUrl(sellerPosts, campaign.id),
    [sellerPosts, campaign.id],
  );
  // R6 캠페인 성과 리포트(내부용) — 이미 로드된 셀러 게시물 + 캐시 실적으로 stateless 집계.
  // 셀러 콘텐츠 효율(ER=좋아요/팔로워)이 핵심 지표. 신규 쿼리·크론·스키마 0. URL 중복 제거분 사용
  // (같은 게시물이 그룹 회차 수만큼 성과에 중복 반영되던 double-count 해소).
  const performance = useMemo(
    () =>
      computeCampaignPerformance(dedupedSellerPosts, {
        followers: campaign.currentFollowers,
        actualSales: campaign.actualSales,
        // 판매수량 = 합산 수량. 관리자 행에선 campaign.quantity가 그 값이다
        // (Σ 딜 수량 = 대시보드 정합값). campaign.itemCount는 "딜 개수"라 판매수량이 아님
        // — 그게 판매수량으로 잘못 표시되던 버그(메모리 wagcrm-ordercount-field-stores-quantity).
        itemCount: campaign.quantity,
        // 객단가 분모 = 진짜 주문건수(distinct). order-stats 라우트가 OrderCampaign 캐시에서 읽어옴.
        orderCount: orderStats?.distinctOrderCount ?? null,
      }),
    [
      dedupedSellerPosts,
      campaign.currentFollowers,
      campaign.actualSales,
      campaign.quantity,
      orderStats,
    ],
  );
  const sellerPostById = useMemo(
    () => new Map(dedupedSellerPosts.map((asset) => [asset.id, asset])),
    [dedupedSellerPosts],
  );
  // 이미 등록된 게시물 신원 키 — 추천에서 클라 측 즉시 제외(수동 추가분도 반영, 서버 dedup 보완).
  // URL 문자열이 아니라 postIdentityKey(shortcode)로 대조한다 — `/reel/` 수동 등록과
  // `/p/` 후보가 같은 게시물일 때 문자열 비교는 놓친다(서버 suggestCampaignPosts와 동일 규약).
  const registeredPostKeys = useMemo(
    () =>
      new Set(
        sellerPosts
          .map((a) => (a.externalUrl ? postIdentityKey(a.externalUrl) : null))
          .filter((k): k is string => !!k),
      ),
    [sellerPosts],
  );
  const visibleSuggestions = useMemo(
    () =>
      suggestions.filter((s) => {
        const key = postIdentityKey(s.permalink) ?? s.permalink;
        return !registeredPostKeys.has(key);
      }),
    [suggestions, registeredPostKeys],
  );

  // 종료된 캠페인의 접힌 미분류분을 되살릴 때만 붙는 파라미터 — 두 fetch 가 공유한다.
  const closedQuery = showClosedReview ? "?includeClosed=1" : "";

  // 캠페인의 셀러 수집 피드에서 추천 후보를 한 번 불러온다(읽기 전용·신규 수집 트리거 없음).
  useEffect(() => {
    let cancelled = false;
    setSuggestLoading(true);
    setSuggestError(null);
    fetch(`/api/campaigns/${campaign.id}/suggested-posts${closedQuery}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as {
          suggestions?: SuggestedPost[];
          lastCollectedAt?: string | null;
          sharedCampaignIds?: string[];
          reviewClosed?: boolean;
        };
        if (!cancelled) {
          setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
          setFeedCollectedAt(data.lastCollectedAt ?? null);
          // 서버는 펼침 여부와 무관하게 창의 사실을 보고한다 — 그대로 반영하면 "접기"로 돌아갈 수 있다.
          setReviewClosed(data.reviewClosed === true);
          // 그룹(조합) 캠페인의 게시물 공유 범위 — 서버(suggested-posts)가 그룹 스코프의 SSOT.
          setSharedCampaignIds(
            Array.isArray(data.sharedCampaignIds) && data.sharedCampaignIds.length > 0
              ? data.sharedCampaignIds
              : [campaign.id],
          );
        }
      })
      .catch(() => {
        if (!cancelled) setSuggestError("추천 게시물을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setSuggestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaign.id, contentRefreshKey, closedQuery]);

  // 캠페인 셀러의 스토리(수집창 내)를 최신순으로 불러온다(읽기 전용). 실패해도 피드 섹션은 무영향.
  useEffect(() => {
    let cancelled = false;
    setStoriesLoading(true);
    setStoriesError(null);
    fetch(`/api/campaigns/${campaign.id}/stories${closedQuery}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as {
          stories?: CampaignStory[];
          lastCapturedAt?: string | null;
        };
        if (!cancelled) {
          setStories(Array.isArray(data.stories) ? data.stories : []);
          setStoryCapturedAt(data.lastCapturedAt ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) setStoriesError("스토리를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setStoriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaign.id, contentRefreshKey, closedQuery]);

  // 포맷별 반응용 media_type 맵 — 읽기 전용(신규 수집 없음). 실패해도 리포트 본체는 무영향.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/campaigns/${campaign.id}/post-formats`)
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { formats?: Record<string, string> };
        if (!cancelled && data.formats) setFormatMap(data.formats);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [campaign.id]);

  // 주문 통계(진짜 주문건수) — 읽기 전용. 실패해도 객단가만 "—"로 폴백(카드 본체 무영향).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/campaigns/${campaign.id}/order-stats`)
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { distinctOrderCount?: number | null };
        if (!cancelled) setOrderStats({ distinctOrderCount: data.distinctOrderCount ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [campaign.id]);
  // 등록 게시물을 포맷별 ER로 묶는다 — 비교 의미가 있으려면 ER 계산 가능한 포맷이 2개 이상.
  const formatComparison = useMemo(
    () => aggregateErByFormat(performance.posts, formatMap).filter((f) => f.avgEr !== null),
    [performance.posts, formatMap],
  );

  // 통합 셀러 게시물 피드 — 추천(후보)과 등록을 하나의 목록으로 병합해 최신순 정렬(오너 2026-07-12).
  // 등록은 이미 로드된 asset(sellerPostById)을 역참조해 게시시각·videoUrl 등 원본 표현 자산을 함께 싣는다.
  const registeredPairs = useMemo(() => {
    const pairs: { post: PerfPost; asset: AssetRow }[] = [];
    for (const post of performance.posts) {
      const asset = sellerPostById.get(post.id);
      if (asset) pairs.push({ post, asset });
    }
    return pairs;
  }, [performance.posts, sellerPostById]);
  const postFeed = useMemo(
    () => mergeSellerPostFeed(visibleSuggestions, registeredPairs),
    [visibleSuggestions, registeredPairs],
  );
  const registeredCount = registeredPairs.length;
  const candidateCount = visibleSuggestions.length;

  const recommendedProvider =
    longTermArchive || (selectedFile?.size ?? 0) > 20 * 1024 * 1024
      ? "GOOGLE_DRIVE"
      : "SUPABASE";

  async function createAsset() {
    setBusy(true);
    setMessage(null);
    const formData = new FormData();
    formData.set("entityType", "CAMPAIGN");
    formData.set("entityId", campaign.id);
    formData.set("section", section);
    formData.set("notes", notes);
    formData.set("longTermArchive", String(longTermArchive));

    if (selectedFile) {
      formData.set("file", selectedFile);
      formData.set("provider", recommendedProvider);
    } else if (externalUrl) {
      formData.set("externalUrl", externalUrl);
      formData.set("fileName", externalUrl);
      formData.set(
        "provider",
        externalUrl.includes("drive.google.com") ? "GOOGLE_DRIVE" : "EXTERNAL_LINK",
      );
    } else {
      setBusy(false);
      setMessage("파일 또는 링크를 선택하세요.");
      return;
    }

    const response = await fetch("/api/assets", { method: "POST", body: formData });
    const raw = await response.text();
    let data: { error?: string; asset?: AssetRow; campaign?: CampaignRow } = {};
    if (raw) {
      try {
        data = JSON.parse(raw) as { error?: string; asset?: AssetRow; campaign?: CampaignRow };
      } catch {
        data = {};
      }
    }
    if (!response.ok) {
      setMessage(data.error ?? "자료 저장에 실패했습니다.");
      setBusy(false);
      return;
    }
    if (!data.asset) {
      setMessage("자료 저장 응답이 올바르지 않습니다.");
      setBusy(false);
      return;
    }
    const createdAsset = data.asset;
    setAssets((previous) => [createdAsset, ...previous]);
    if (data.campaign) {
      onCampaignUpdated?.(data.campaign as CampaignRow);
    }
    setSelectedFile(null);
    setExternalUrl("");
    setNotes("");
    setLongTermArchive(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setBusy(false);
  }

  async function openAsset(asset: AssetRow) {
    const response = await fetch(`/api/assets/${asset.id}?download=1`);
    const data = await response.json();
    if (data.downloadUrl) window.open(data.downloadUrl, "_blank", "noreferrer");
  }

  async function archiveAsset(asset: AssetRow) {
    const response = await fetch(`/api/assets/${asset.id}`, { method: "PATCH" });
    if (!response.ok) return;
    const data = await response.json();
    setAssets((previous) =>
      previous.map((item) => (item.id === asset.id ? data.asset : item)),
    );
    if (data.campaign) {
      onCampaignUpdated?.(data.campaign as CampaignRow);
    }
  }

  // 셀러 게시물 URL 추가 — R1 딜 패널(handleAddLink) UX 복제, 기존 /api/assets POST 재사용.
  async function addSellerPost() {
    const normalized = normalizeReferenceUrl(sellerPostUrl);
    if (!normalized) {
      setSellerPostError("올바른 URL이 아닙니다. http(s):// 주소를 입력하세요.");
      return;
    }
    // 신원 키(shortcode) 대조 — `/reel/` 원형과 `/p/` 프리뷰 관례가 같은 게시물일 수 있다.
    const newKey = postIdentityKey(normalized) ?? normalized;
    if (registeredPostKeys.has(newKey)) {
      setSellerPostError("이미 등록된 게시물 링크입니다.");
      return;
    }
    setSellerPostBusy(true);
    setSellerPostError(null);
    setSellerPostNotice(null);
    try {
      const formData = new FormData();
      formData.set("entityType", "CAMPAIGN");
      formData.set("entityId", campaign.id);
      formData.set("section", "SNS_CREATIVE");
      formData.set("externalUrl", normalized);
      formData.set("fileName", deriveLinkName(normalized));
      formData.set("provider", "EXTERNAL_LINK");
      const response = await fetch("/api/assets", { method: "POST", body: formData });
      const data = (await response.json()) as {
        error?: unknown;
        asset?: AssetRow;
        campaign?: CampaignRow;
      };
      if (!response.ok || !data.asset) {
        setSellerPostError(
          typeof data.error === "string"
            ? data.error
            : `게시물 추가 실패 (HTTP ${response.status})`,
        );
        return;
      }
      const createdAsset = data.asset;
      setAssets((previous) => [createdAsset, ...previous]);
      if (data.campaign) {
        onCampaignUpdated?.(data.campaign);
      }
      setSellerPostUrl("");
    } catch {
      // 네트워크·JSON 파싱 실패 — 인라인 에러로 노출(조용히 삼키지 않음)
      setSellerPostError("게시물 추가 요청 중 오류가 발생했습니다.");
    } finally {
      setSellerPostBusy(false);
    }
  }

  // 추천 게시물 한 클릭 등록(후보②) — 셀러 게시물 추가(addSellerPost)와 동일 계약으로
  // 기존 /api/assets POST 재사용. permalink는 라우트가 이미 정규화해 반환한 값.
  // 후보가 이미 아는 표현 자산(유형·영상·게시시각·재호스팅 썸네일)을 함께 시딩해
  // 등록 직후에도 추천 카드와 동일한 출력(유형 배지·롤오버 재생)이 유지되게 한다.
  async function addSuggestion(suggestion: SuggestedPost) {
    const permalink = suggestion.permalink;
    setAddingSuggestion(permalink);
    setSuggestError(null);
    try {
      const formData = new FormData();
      formData.set("entityType", "CAMPAIGN");
      formData.set("entityId", campaign.id);
      formData.set("section", "SNS_CREATIVE");
      formData.set("externalUrl", permalink);
      formData.set("fileName", deriveLinkName(permalink));
      formData.set("provider", "EXTERNAL_LINK");
      if (suggestion.mediaType) formData.set("mediaType", suggestion.mediaType);
      if (suggestion.videoUrl) formData.set("videoUrl", suggestion.videoUrl);
      if (suggestion.takenAt) formData.set("postedAt", suggestion.takenAt);
      // 만료성 IG CDN 썸네일은 시딩하지 않는다(서버도 거부) — enrich 크론의 재호스팅 경로로 유도
      if (suggestion.thumb && !/(cdninstagram\.com|fbcdn\.net)/i.test(suggestion.thumb)) {
        formData.set("thumbnailUrl", suggestion.thumb);
      }
      const response = await fetch("/api/assets", { method: "POST", body: formData });
      const data = (await response.json()) as {
        error?: unknown;
        asset?: AssetRow;
        campaign?: CampaignRow;
      };
      if (!response.ok || !data.asset) {
        setSuggestError(
          typeof data.error === "string" ? data.error : "게시물 추가에 실패했습니다.",
        );
        return;
      }
      const createdAsset = data.asset;
      setAssets((previous) => [createdAsset, ...previous]);
      setSuggestions((previous) => previous.filter((s) => s.permalink !== permalink));
      if (data.campaign) onCampaignUpdated?.(data.campaign);
    } catch {
      setSuggestError("게시물 추가 요청 중 오류가 발생했습니다.");
    } finally {
      setAddingSuggestion(null);
    }
  }

  // 후보 게시물 "무관" 분류 — 통합 모델에서 "홍보"는 addSuggestion(등록)이 담당하고, 여기선 무관만.
  // 무관 = SellerPostClassification(OTHER)로 영구 숨김(오너 결정4) → 낙관적으로 후보 목록에서 즉시 제거.
  // 무음 성공 계약(스토리 분류와 동형): 성공 시 토스트 없이 로컬 제거만, 실패만 인라인 에러.
  async function dismissPostCandidate(suggestion: SuggestedPost) {
    const permalink = suggestion.permalink;
    setDismissingPostUrl(permalink);
    setSuggestError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/posts/classification`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permalink, classification: "OTHER" }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: unknown };
      if (!response.ok || !data.ok) {
        setSuggestError(
          typeof data.error === "string" ? data.error : "무관 처리에 실패했습니다.",
        );
        return;
      }
      setSuggestions((previous) => previous.filter((s) => s.permalink !== permalink));
    } catch {
      setSuggestError("무관 처리 요청 중 오류가 발생했습니다.");
    } finally {
      setDismissingPostUrl(null);
    }
  }

  // 등록 게시물 "제외(무관)" — 스토리·후보 무관과 동형의 진짜 드롭. "보관"만 하면 OTHER 미기록으로
  // 다음 로드에 후보로 되살아나므로(오너 혼란 지점), 여기서는 ① OTHER 분류로 candidate 재등장을
  // 영구 차단 + ② 같은 URL의 모든 회차(그룹 공유 중복 포함) asset 보관을 함께 수행한다.
  async function dropRegisteredPost(asset: AssetRow) {
    const url = asset.externalUrl;
    setDroppingPostId(asset.id);
    setSellerPostError(null);
    setSellerPostNotice(null);
    try {
      // ① OTHER 분류(멱등) 먼저 — 같은 셀러 candidate 피드에서 영구 숨김. permalink 없으면 스킵.
      if (url) {
        const cls = await fetch(`/api/campaigns/${campaign.id}/posts/classification`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permalink: url, classification: "OTHER" }),
        });
        if (!cls.ok) {
          const d = (await cls.json().catch(() => ({}))) as { error?: unknown };
          throw new Error(typeof d.error === "string" ? d.error : "제외 처리에 실패했습니다.");
        }
      }
      // ② 같은 게시물(신원 키)의 전 회차 등록 asset 보관(그룹 공유 중복까지). URL 없으면 이 카드만.
      //    byPermalink의 키가 postIdentityKey라 조회 키도 같은 함수로 만든다.
      const key = url ? postIdentityKey(url) : null;
      const targets = key ? assetsByPermalink.get(key) ?? [asset] : [asset];
      const archivedIds: string[] = [];
      for (const t of targets) {
        const res = await fetch(`/api/assets/${t.id}`, { method: "PATCH" });
        if (res.ok) archivedIds.push(t.id);
      }
      // ③ 낙관적 로컬 반영 — 보관된 asset을 archivedAt 세팅(피드 필터가 제거). 후보로도 안 돌아옴.
      const nowIso = new Date().toISOString();
      setAssets((prev) =>
        prev.map((it) => (archivedIds.includes(it.id) ? { ...it, archivedAt: nowIso } : it)),
      );
    } catch (e) {
      setSellerPostError(e instanceof Error ? e.message : "제외 처리에 실패했습니다.");
    } finally {
      setDroppingPostId(null);
    }
  }

  // 딜 레퍼런스로 복사(R5 promote) — 같은 딜에 같은 URL이 있으면 alreadyExists로 안내.
  async function promoteSellerPost(asset: AssetRow) {
    setPromoteBusyId(asset.id);
    setSellerPostError(null);
    setSellerPostNotice(null);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/promote-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: asset.id }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        alreadyExists?: boolean;
        error?: unknown;
      };
      if (!response.ok) {
        setSellerPostError(
          typeof data.error === "string"
            ? data.error
            : `딜 레퍼런스 복사 실패 (HTTP ${response.status})`,
        );
        return;
      }
      setSellerPostNotice(
        data.alreadyExists ? "이미 딜 레퍼런스에 등록된 링크입니다." : "딜 레퍼런스로 복사됨",
      );
    } catch {
      setSellerPostError("딜 레퍼런스 복사 요청 중 오류가 발생했습니다.");
    } finally {
      setPromoteBusyId(null);
    }
  }

  // 스토리 분류(캠페인 홍보/무관/되돌리기) — 캠페인 상세에서. CAMPAIGN이면 이 캠페인을 홍보이력으로 연결.
  // 낙관적 갱신: 성공 시 로컬 classification만 바꾸고 재조회하지 않는다(무음 성공 계약).
  async function classifyStorySnapshot(
    story: CampaignStory,
    classification: "CAMPAIGN" | "OTHER" | "UNREVIEWED",
  ) {
    setClassifyingStoryId(story.id);
    setStoriesError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/stories`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotId: story.id, classification }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: unknown };
      if (!response.ok || !data.ok) {
        setStoriesError(
          typeof data.error === "string" ? data.error : "스토리 분류에 실패했습니다.",
        );
        return;
      }
      // 무관(OTHER)은 캠페인 표시에서 영구 숨김(오너 결정4) → 낙관적으로 목록에서 제거.
      // 홍보/되돌리기는 로컬 classification만 갱신(재조회 없음 · 무음 성공 계약).
      setStories((prev) =>
        classification === "OTHER"
          ? prev.filter((s) => s.id !== story.id)
          : prev.map((s) => (s.id === story.id ? { ...s, classification } : s)),
      );
    } catch {
      setStoriesError("스토리 분류 요청 중 오류가 발생했습니다.");
    } finally {
      setClassifyingStoryId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="flex items-center text-sm font-semibold text-foreground">
              <FolderOpen className="mr-2 size-4 text-muted-foreground" />
              자료 관리
            </h3>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Supabase {formatBytes(storage.supabaseEstimatedBytes)} /{" "}
            {formatBytes(storage.supabaseLimitBytes)} · Drive{" "}
            {storage.googleDriveConnected ? "연결됨" : "미연결"}
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            storage.supabaseEstimatedBytes >= storage.supabaseWarningBytes
              ? "border-amber-300 bg-amber-50 text-amber-700"
              : "bg-muted"
          }
        >
          {storage.supabaseEstimatedBytes >= storage.supabaseWarningBytes
            ? "용량 주의"
            : "무료 플랜"}
        </Badge>
      </div>

      <Tabs value={section} onValueChange={(value) => setSection(value as AssetSection)}>
        <TabsList className="h-auto flex-wrap justify-start">
          {sectionOrder.map((item) => (
            <TabsTrigger key={item} value={item} className="text-xs">
              {assetSectionLabels[item]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="space-y-3 rounded-lg border bg-card p-3">
        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <Label htmlFor="asset-file">파일</Label>
            <Input
              ref={fileInputRef}
              id="asset-file"
              type="file"
              accept=".pdf,.xls,.xlsx,.png,.jpg,.jpeg,.webp"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-2">
            <Label>추천 저장소</Label>
            <div className="flex h-9 items-center gap-2 rounded-lg border px-3 text-sm">
              <FolderOpen className="size-4 text-muted-foreground" />
              {assetProviderLabels[recommendedProvider]}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="asset-link">Drive 또는 외부 링크</Label>
          <Input
            id="asset-link"
            value={externalUrl}
            onChange={(event) => setExternalUrl(event.target.value)}
            placeholder="https://drive.google.com/..."
          />
        </div>

        <div className="grid gap-2 md:grid-cols-[0.8fr_1fr]">
          <div className="space-y-2">
            <Label>자료 유형</Label>
            <Select value={section} onValueChange={(value) => setSection(value as AssetSection)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sectionOrder.map((item) => (
                  <SelectItem key={item} value={item}>
                    {assetSectionLabels[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="asset-note">메모</Label>
            <Input
              id="asset-note"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="브랜드사 최신본, 정산 확인 필요 등"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={longTermArchive}
              onChange={(event) => setLongTermArchive(event.target.checked)}
              className="size-4"
            />
            장기 보관 자료
          </label>
          <Button size="sm" disabled={busy} onClick={createAsset}>
            <Upload className="size-4" />
            자료 추가
          </Button>
        </div>
        {message ? <p className="text-xs text-rose-600">{message}</p> : null}
      </div>

      <div className="space-y-2">
        {visibleAssets.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            등록된 자료가 없습니다.
          </div>
        ) : (
          visibleAssets.map((asset) => (
            <div key={asset.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" />
                  <p className="truncate text-sm font-medium">{asset.fileName}</p>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{assetProviderLabels[asset.provider]}</Badge>
                  <span>{formatBytes(asset.sizeBytes)}</span>
                  <span>{formatDate(asset.createdAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon" onClick={() => openAsset(asset)}>
                  <ExternalLink className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => archiveAsset(asset)}>
                  <Archive className="size-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 셀러 게시물 + R6 성과 리포트(내부용) — 셀러 콘텐츠 효율(ER)이 focal point,
          실적은 보조 컨텍스트. 우수 판정은 자동으로 하지 않고 ER 정렬로만 노출한다(R6 §3:
          담당자 수동 Pick = 기존 "딜 레퍼런스로" 버튼). */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center text-sm font-semibold text-foreground">
            <Link2 className="mr-2 size-4 text-muted-foreground" />
            셀러 게시물
            {/* 통합 피드: 등록(확정)·후보(추천) 카운트를 헤더 한 줄에 흡수(스토리 헤더와 같은 리듬). */}
            {registeredCount > 0 || candidateCount > 0 ? (
              <span className="ml-1.5 text-[11px] font-normal tabular-nums text-muted-foreground">
                등록 {registeredCount}
                {candidateCount > 0 ? ` · 후보 ${candidateCount}` : ""}
              </span>
            ) : null}
          </h3>
          <div className="flex items-center gap-2">
            {/* 마지막 수집(SellerAiProfile.analyzedAt) — 후보 감지 피드의 신선도. 스토리 헤더와 동일 표기. */}
            {feedCollectedAt ? (
              <p className="inline-flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground/80">
                <Clock className="size-2.5" />
                마지막 수집 {formatCollectedAt(feedCollectedAt)}
              </p>
            ) : null}
            {/* 셀러별 순차 수집(게시물→스토리) — 종료 후 refreshKey 로 두 목록·수집시각 재조회 */}
            <SellerContentCollectButton
              sellerId={campaign.sellerId}
              snsType={campaign.snsType}
              onComplete={() => setContentRefreshKey((k) => k + 1)}
            />
          </div>
        </div>

        {/* 성과 집계 카드 — 게시물이 있을 때만. 평균 ER이 focal point(단일 accent),
            나머지 실적은 grey 보조 통계(색=의미). */}
        {performance.postCount > 0 ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-muted-foreground">평균 참여율 (ER)</div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <span className="text-2xl font-bold leading-none tabular-nums text-primary">
                    {performance.avgEr !== null ? performance.avgEr.toFixed(1) : "—"}
                  </span>
                  <span className="text-sm font-semibold text-primary">%</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {performance.followers !== null
                    ? `좋아요 대비 · 팔로워 ${performance.followers.toLocaleString()}`
                    : "팔로워 미확인으로 ER 계산 불가"}
                </div>
              </div>
              <dl className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-1 text-right text-[11px]">
                <div>
                  <dt className="text-muted-foreground">평균 좋아요</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {performance.avgLikes !== null
                      ? Math.round(performance.avgLikes).toLocaleString()
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">실매출</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {performance.revenue !== null
                      ? `${performance.revenue.toLocaleString()}원`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">판매수량</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {performance.quantity !== null
                      ? `${performance.quantity.toLocaleString()}개`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">객단가</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {performance.aov !== null
                      ? `${Math.round(performance.aov).toLocaleString()}원`
                      : "—"}
                  </dd>
                  {performance.orders !== null ? (
                    <div className="text-[10px] tabular-nums text-muted-foreground">
                      주문 {performance.orders.toLocaleString()}건
                    </div>
                  ) : null}
                </div>
              </dl>
            </div>
          </div>
        ) : null}

        {/* 포맷별 반응 — 어떤 콘텐츠 포맷이 잘 반응했는지(릴스/피드/…). ER 계산 가능한 포맷이
            2개 이상일 때만(비교의 의미). grey 유틸(색=의미: 강조색 미사용, 정렬로 우열 표시). */}
        {formatComparison.length >= 2 ? (
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">포맷별 ER</span>
              {formatComparison.map((f) => (
                <span key={f.format} className="text-[11px] tabular-nums text-foreground">
                  {f.label} <span className="font-semibold">{(f.avgEr ?? 0).toFixed(1)}%</span>
                  <span className="text-muted-foreground"> ·{f.count}건</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex gap-2">
          <Input
            type="url"
            value={sellerPostUrl}
            onChange={(event) => {
              setSellerPostUrl(event.target.value);
              setSellerPostError(null);
            }}
            placeholder="셀러가 올린 게시물 URL 붙여넣기 (인스타/유튜브 등)"
            aria-label="셀러 게시물 URL"
            disabled={sellerPostBusy}
            className="h-8 flex-1 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 text-xs"
            disabled={sellerPostBusy || !sellerPostUrl.trim()}
            onClick={() => void addSellerPost()}
          >
            <Link2 className="size-3.5" />
            {sellerPostBusy ? "추가 중..." : "게시물 추가"}
          </Button>
        </div>
        {sellerPostError ? <p className="text-xs text-rose-600">{sellerPostError}</p> : null}
        {sellerPostNotice ? <p className="text-xs text-emerald-600">{sellerPostNotice}</p> : null}

        {/* 검토 기간(마감 +7일)이 지난 캠페인 — 미분류 후보·스토리를 접었다는 사실과 되살리는 길을
            **피드 그리드 바로 위**에서 알린다. 알림이 설명하는 대상 옆에 두어야 정보 지역성이 맞고,
            섹션 focal point(평균 ER 카드)와 헤더 사이를 회색 박스로 끊지 않는다(ss-ux 판정).
            접힘은 표시 정책일 뿐 데이터는 그대로다 — 전역 분류함(/admin/stories)에서 계속 보인다.
            색=의미(P8 §4): 심각도·판정 축이 아니라 단순 정보 상태라 무채색만 쓴다. */}
        {reviewClosed ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">
              종료된 캠페인: 미검토 후보·스토리를 접었습니다. 등록된 게시물은 그대로 보입니다.
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 text-[11px]"
              onClick={() => setShowClosedReview((v) => !v)}
            >
              {showClosedReview ? "다시 접기" : "미검토 항목 보기"}
            </Button>
          </div>
        ) : null}

        {/* 통합 셀러 게시물 피드 — 후보(추천)+등록을 하나의 그리드에 최신순(게시시각 내림차순)으로.
            후보는 dashed slate 테두리 + "후보" 배지로 구분(같은 카드 사이즈·포맷 유지). 담당자는 최신순
            으로 훑다가 후보를 만나면 그 자리에서 등록(추가)을, 등록 카드에선 딜 레퍼런스 승격/보관을 한다.
            좋아요 3-state(숫자/비공개/집계 전)는 공통, ER은 등록만(후보는 아직 '성과' 단계가 아님).
            색=의미: 상태 구분엔 slate만(primary/골드 미사용), ER 강조는 굵기(font-semibold)만. */}
        {postFeed.length === 0 ? (
          suggestLoading ? (
            <p className="text-[11px] text-muted-foreground">셀러 게시물 확인 중...</p>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {/* 접힘 상태에서 "없습니다"만 말하면 숨긴 후보를 "정말 없다"로 오판한다 — 스토리 빈
                  상태와 동형으로 되살리는 길을 함께 안내한다(ss-ux 지적). */}
              {reviewClosed && !showClosedReview
                ? "홍보로 등록된 게시물이 없습니다. 미검토 후보는 위에서 펼쳐 볼 수 있습니다."
                : "등록·추천된 셀러 게시물이 없습니다."}
            </div>
          )
        ) : (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {postFeed.map((card) => {
              if (card.status === "candidate") {
                const s = card.suggestion;
                const canEmbed = isInstagramPermalink(s.permalink);
                const embedOpen = expandedEmbeds.has(s.permalink);
                return (
                  <Fragment key={card.key}>
                    <div className="relative min-w-0 overflow-hidden rounded-lg border border-dashed border-slate-400/70 bg-slate-50/40 transition-colors hover:border-foreground/30">
                      <PostThumb href={s.permalink} thumb={s.thumb} mediaType={s.mediaType} videoUrl={s.videoUrl} />
                      {/* 우상단 배지(스토리 배지와 같은 좌표). is_gongu 자동감지=홍보 "추천"(primary),
                          그 외 미분류 후보=slate "후보"(status-badge PREPARATION 톤). 대시 테두리가 이미
                          "미등록 후보" 상태를 나타내므로 배지는 자동추천 여부를 전달한다. */}
                      {s.recommended ? (
                        <span className="absolute right-1.5 top-1.5 z-10 rounded-md bg-primary/90 px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground backdrop-blur-sm">
                          추천
                        </span>
                      ) : (
                        <span className="absolute right-1.5 top-1.5 z-10 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 backdrop-blur-sm">
                          후보
                        </span>
                      )}
                      <div className="px-2 pt-1.5">
                        <p className="truncate text-[11px] tabular-nums text-muted-foreground">
                          {s.takenAt ? formatDate(s.takenAt) : "날짜 미상"} · 좋아요{" "}
                          {/* 좋아요 숨김(likesHidden)은 임의 숫자 금지 — "비공개" 표기(등록 카드와 동일 3-state) */}
                          {s.likesHidden ? "비공개" : s.likes.toLocaleString()}
                          {s.comments !== null ? ` · 댓글 ${s.comments.toLocaleString()}` : ""}
                        </p>
                      </div>
                      {/* 분류 버튼 — 스토리와 동형(홍보/무관 2버튼). 통합 모델: "홍보"=Asset 등록(성과추적
                          시작, addSuggestion 재사용) · "무관"=영구 숨김(dismissPostCandidate). is_gongu
                          자동추천은 홍보 버튼을 primary-filled로 강조해 원클릭 확정을 유도한다. */}
                      <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                        {canEmbed ? (
                          <Button
                            size="icon-sm"
                            variant={embedOpen ? "secondary" : "ghost"}
                            className="shrink-0"
                            title={embedOpen ? "카드 닫기" : "게시물 카드 보기(영상 재생)"}
                            aria-expanded={embedOpen}
                            onClick={() => toggleEmbed(s.permalink)}
                          >
                            <Play className="size-4" />
                          </Button>
                        ) : null}
                        <button
                          type="button"
                          disabled={addingSuggestion === s.permalink || dismissingPostUrl === s.permalink}
                          onClick={() => void addSuggestion(s)}
                          title="캠페인 홍보로 등록(성과추적 시작)"
                          className={`flex-1 rounded py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:opacity-50 ${
                            s.recommended
                              ? "bg-primary text-primary-foreground hover:bg-primary/90"
                              : "bg-primary/10 text-primary hover:bg-primary/20"
                          }`}
                        >
                          {addingSuggestion === s.permalink ? "등록 중..." : "홍보"}
                        </button>
                        <button
                          type="button"
                          disabled={addingSuggestion === s.permalink || dismissingPostUrl === s.permalink}
                          onClick={() => void dismissPostCandidate(s)}
                          title="캠페인과 무관 처리(목록에서 숨김)"
                          className="flex-1 rounded bg-muted py-1 text-[11px] font-medium text-slate-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring hover:bg-muted/70 disabled:opacity-50"
                        >
                          {dismissingPostUrl === s.permalink ? "처리 중..." : "무관"}
                        </button>
                      </div>
                    </div>
                    {canEmbed && embedOpen ? (
                      <div className="col-span-full rounded-lg border bg-card p-3">
                        <InstagramEmbed permalink={s.permalink} />
                      </div>
                    ) : null}
                  </Fragment>
                );
              }
              // 등록 게시물(확정) — 실선 테두리(부재=확정), 게시시각·ER 메타, 딜 레퍼런스 복사·보관 액션.
              const { post, asset } = card;
              const canEmbed = isInstagramPermalink(post.externalUrl);
              const embedOpen = expandedEmbeds.has(post.id);
              const shortcode = instagramShortcode(post.externalUrl);
              // 유형: 구조화 필드(Asset.mediaType, 크론/시딩 적재) 우선 — postsPreview 맵은 분석된 셀러만 커버하는 폴백
              const mediaType = asset.mediaType ?? (shortcode ? formatMap[shortcode] : undefined);
              // 게시시각: 실제 IG postedAt 우선, 수동 추가건은 등록시각(createdAt) 폴백(정렬 키와 동일 규약).
              const postedLabel = formatDate(asset.postedAt ?? asset.createdAt);
              return (
                <Fragment key={card.key}>
                  <div className="relative min-w-0 overflow-hidden rounded-lg border bg-card transition-colors hover:border-foreground/30">
                    <PostThumb
                      href={post.externalUrl}
                      thumb={post.thumbnailUrl}
                      mediaType={mediaType}
                      videoUrl={asset.videoUrl}
                    />
                    {/* 분류 상태 배지(후보 "추천"/"후보"와 같은 좌표) — 등록 = 홍보 확정. 아래 "무관"
                        버튼이 이 분류를 되돌린다(스토리 카드의 배지+되돌리기와 동형). */}
                    <span className="absolute right-1.5 top-1.5 z-10 rounded-md bg-primary/90 px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground backdrop-blur-sm">
                      홍보
                    </span>
                    <div className="px-2 pt-1.5">
                      <p className="truncate text-[11px] tabular-nums">
                        <span className="text-muted-foreground">
                          {postedLabel} · 좋아요{" "}
                          {/* 좋아요 숨김(likesHidden)은 임의 숫자 금지 — "비공개"로 표기(오너 결정 2026-07-11) */}
                          {post.likesHidden ? "비공개" : post.likes !== null ? post.likes.toLocaleString() : "집계 전"}
                        </span>
                        {post.comments !== null ? (
                          <span className="text-muted-foreground"> · 댓글 {post.comments.toLocaleString()}</span>
                        ) : null}
                        {post.er !== null ? (
                          <>
                            <span className="text-muted-foreground"> · </span>
                            <span className="font-semibold text-foreground">ER {post.er.toFixed(1)}%</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                      {canEmbed ? (
                        <Button
                          size="icon-sm"
                          variant={embedOpen ? "secondary" : "ghost"}
                          className="shrink-0"
                          title={embedOpen ? "카드 닫기" : "게시물 카드 보기(영상 재생)"}
                          aria-expanded={embedOpen}
                          onClick={() => toggleEmbed(post.id)}
                        >
                          <Play className="size-4" />
                        </Button>
                      ) : null}
                      <Button
                        size="icon-sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={promoteBusyId === asset.id}
                        onClick={() => void promoteSellerPost(asset)}
                        title="딜 레퍼런스로 복사"
                      >
                        <CopyPlus className="size-4" />
                      </Button>
                      {/* 제외(무관) — 스토리·후보 무관과 동형. "보관"과 달리 OTHER 분류까지 기록해
                          후보로 되살아나지 않는 진짜 드롭. 그룹 공유 중복(같은 URL 여러 회차)도 함께 제외. */}
                      <button
                        type="button"
                        disabled={droppingPostId === asset.id}
                        onClick={() => void dropRegisteredPost(asset)}
                        title="캠페인과 무관 처리: 홍보에서 제외하고 목록에서 숨김(후보로 되돌아오지 않음)"
                        className="ml-auto shrink-0 rounded bg-muted px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring hover:bg-muted/70 disabled:opacity-50"
                      >
                        {droppingPostId === asset.id ? "처리 중..." : "무관"}
                      </button>
                    </div>
                  </div>
                  {canEmbed && embedOpen && post.externalUrl ? (
                    <div className="col-span-full rounded-lg border bg-card p-3">
                      <InstagramEmbed permalink={post.externalUrl} />
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        )}
        {suggestError ? <p className="text-[11px] text-rose-600">{suggestError}</p> : null}

        {/* 셀러 스토리(캠페인 통합) — /admin/stories 전역 분류함과 같은 데이터를 이 캠페인
            수집창(시작 7일 전~마감 1일 후)으로 좁혀 최신순으로 보여준다. 스토리는 좋아요/댓글이
            없다(휘발성 24h) — 게시시각·수집시각·영상 여부·분류(홍보/무관)만 다룬다. */}
        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex items-center text-[13px] font-semibold text-foreground">
              <CircleDashed className="mr-1.5 size-3.5 text-muted-foreground" />
              셀러 스토리
              {stories.length > 0 ? (
                <span className="ml-1.5 text-[11px] font-normal tabular-nums text-muted-foreground">
                  {stories.length}건
                </span>
              ) : null}
            </h4>
            {storyCapturedAt ? (
              <p className="inline-flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground/80">
                <Clock className="size-2.5" />
                마지막 수집 {formatCollectedAt(storyCapturedAt)}
              </p>
            ) : null}
          </div>

          {storiesLoading ? (
            <p className="text-[11px] text-muted-foreground">스토리 확인 중...</p>
          ) : stories.length === 0 ? (
            <div className="rounded-lg border border-dashed p-3 text-[11px] text-muted-foreground">
              {storiesError ??
                (reviewClosed && !showClosedReview
                  ? "홍보로 분류된 스토리가 없습니다. 미검토 스토리는 위에서 펼쳐 볼 수 있습니다."
                  : "수집된 스토리가 없습니다. 캠페인 기간(시작 7일 전~마감 1일 후) 중 매일 자정 자동 수집됩니다.")}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {stories.map((story) => {
                  const img = story.thumbnailUrl || story.sourceImageUrl;
                  const isCampaign = story.classification === "CAMPAIGN";
                  const busy = classifyingStoryId === story.id;
                  return (
                    <div
                      key={story.id}
                      className={`overflow-hidden rounded-lg border bg-card transition-colors ${
                        isCampaign ? "border-primary/50 ring-1 ring-primary/30" : "border-border"
                      }`}
                    >
                      {/* 크기 통일(오너 결정1): 게시물 카드와 동일 4:5. 스토리 원본은 세로 9:16이라
                          object-cover로 상단이 크롭된다(주 콘텐츠가 상단이라 허용). */}
                      <div className="relative aspect-[4/5] bg-muted">
                        {img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={img}
                            alt=""
                            loading="lazy"
                            // 9:16 스토리를 4:5로 담을 때 상단 앵커 크롭(주 콘텐츠가 상단, 오너 결정1).
                            // object-top 없으면 중앙 크롭이라 상하가 균등 잘림 — 주석과 어긋남(ss-ux 지적).
                            className="absolute inset-0 h-full w-full object-cover object-top"
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/60">
                            썸네일 없음
                          </div>
                        )}
                        {story.mediaType === 2 ? (
                          <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-black/55 px-1 py-0.5 text-[9px] font-medium text-white backdrop-blur-sm">
                            <Play className="size-2 fill-white text-white" />
                            영상
                          </span>
                        ) : null}
                        {isCampaign ? (
                          <span className="absolute right-1 top-1 rounded bg-primary/90 px-1 py-0.5 text-[9px] font-bold text-primary-foreground">
                            홍보
                          </span>
                        ) : null}
                      </div>
                      <div className="px-1.5 pb-1.5 pt-1">
                        <p className="truncate text-[10px] tabular-nums text-foreground/80">
                          {formatCollectedAt(story.takenAt)}
                        </p>
                        <p className="truncate text-[9px] tabular-nums text-muted-foreground/70">
                          수집 {formatCollectedAt(story.capturedAt)}
                        </p>
                        <div className="mt-1 flex gap-1">
                          {story.classification === "UNREVIEWED" ? (
                            <>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void classifyStorySnapshot(story, "CAMPAIGN")}
                                className="flex-1 rounded bg-primary/10 py-0.5 text-[10px] font-semibold text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring hover:bg-primary/20 disabled:opacity-50"
                              >
                                홍보
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void classifyStorySnapshot(story, "OTHER")}
                                className="flex-1 rounded bg-muted py-0.5 text-[10px] font-medium text-slate-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring hover:bg-muted/70 disabled:opacity-50"
                              >
                                무관
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void classifyStorySnapshot(story, "UNREVIEWED")}
                              className="flex-1 rounded border border-border py-0.5 text-[10px] font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring hover:bg-muted/40 disabled:opacity-50"
                              title="분류 되돌리기"
                            >
                              {isCampaign ? "✓ 홍보" : "무관"} · 되돌리기
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {storiesError ? <p className="text-[11px] text-rose-600">{storiesError}</p> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
