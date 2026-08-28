"use client";

import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import type { SellerSummary } from "@/lib/crm-types";
import { formatNumber } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { MobileTopBar } from "./mobile-top-bar";

type MobileSellersViewProps = {
  sellers: SellerSummary[];
  totalCount: number;
  instagramCount: number;
  youtubeCount: number;
  xCount: number;
  totalCampaigns: number;
  localQuery: string;
  setLocalQuery: (value: string) => void;
  commitSearch: (value: string) => void;
  onOpenSeller: (seller: SellerSummary) => void;
  isLoading?: boolean;
};

function resolveChannelUrl(seller: SellerSummary) {
  if (seller.channelUrl) return seller.channelUrl;
  if (seller.snsType === "YOUTUBE") {
    return seller.snsHandle.startsWith("UC")
      ? `https://www.youtube.com/channel/${seller.snsHandle}`
      : `https://www.youtube.com/@${seller.snsHandle}`;
  }
  if (seller.snsType === "X") {
    return `https://x.com/${seller.snsHandle}`;
  }
  return `https://www.instagram.com/${seller.snsHandle}`;
}

export function MobileSellersView({
  sellers,
  totalCount,
  instagramCount,
  youtubeCount,
  xCount,
  totalCampaigns,
  localQuery,
  setLocalQuery,
  commitSearch,
  onOpenSeller,
  isLoading = false,
}: MobileSellersViewProps) {
  return (
    <section className="mobile-tab-safe-top flex min-h-[calc(100dvh+1px)] flex-1 flex-col gap-4 px-5 pb-24">
      <MobileTopBar
        title="셀러 검색"
        right={
          <Badge variant="secondary" className="shrink-0">
            {sellers.length}명
          </Badge>
        }
      >
        <p className="mt-0.5 text-xs text-muted-foreground">
          연락처와 채널 접근이 필요한 셀러를 빠르게 찾습니다.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Instagram {instagramCount}</span>
          <span>YouTube {youtubeCount}</span>
          <span>X {xCount}</span>
        </div>
      </MobileTopBar>

      <InputGroup className="h-11 rounded-2xl border border-white/60 bg-white/80 backdrop-blur-sm shadow-soft-sm">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={localQuery}
          onChange={(event) => {
            const value = event.target.value;
            setLocalQuery(value);
            commitSearch(value);
          }}
          placeholder="이름, 핸들, 카테고리 검색"
          className="h-full border-0 text-sm focus-visible:ring-0"
        />
      </InputGroup>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>전체 {totalCount}명</span>
        <span>Instagram {instagramCount}</span>
        <span>YouTube {youtubeCount}</span>
        <span>X (Twitter) {xCount}</span>
        <span>캠페인 {totalCampaigns}건</span>
      </div>

      <div className="flex flex-col gap-3">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <article
              key={`skeleton-seller-${i}`}
              className="rounded-2xl border border-white/60 bg-white/85 backdrop-blur-sm p-3 shadow-soft-sm space-y-3 animate-pulse"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
              <div className="flex gap-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-11 w-full rounded-xl" />
            </article>
          ))
        ) : (
          sellers.map((seller) => (
            <article
              key={seller.id}
              className="rounded-2xl border border-white/60 bg-white/85 backdrop-blur-sm p-3 shadow-soft-sm"
            >
              <button
                type="button"
                onClick={() => onOpenSeller(seller)}
                // 프레스 틴트 — 카드 하단 "채널 열기" 버튼이 별도 탭 대상이라 카드 scale 대신
                // 이 영역만 틴트한다(outreach 카드와 동일 패턴, 네거티브 마진 = 레이아웃 불변).
                className="-m-1.5 flex w-full flex-col gap-2.5 rounded-xl p-1.5 text-left transition-colors duration-150 active:bg-slate-900/[0.04]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {seller.alias || seller.name}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      @{seller.snsHandle}
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {seller.snsType}
                  </Badge>
                </div>

                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>팔로워 {formatNumber(seller.currentFollowers)}</span>
                  <span>캠페인 {seller.campaignCount ?? seller.campaigns?.length ?? 0}회</span>
                  <span className="line-clamp-1">{seller.category || "미분류"}</span>
                </div>
              </button>

              <div className="mt-3">
                <Button type="button" variant="outline" size="sm" className="h-11 w-full rounded-xl" asChild>
                  <a href={resolveChannelUrl(seller)} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon data-icon="inline-start" />
                    채널 열기
                  </a>
                </Button>
              </div>
            </article>
          ))
        )}

        {!isLoading && sellers.length === 0 ? (
          <Empty className="border border-border/70 bg-background py-8">
            <EmptyHeader>
              <EmptyTitle>조건에 맞는 셀러가 없습니다.</EmptyTitle>
              <EmptyDescription>이름, 핸들, 카테고리로 다시 검색해보세요.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </section>
  );
}
