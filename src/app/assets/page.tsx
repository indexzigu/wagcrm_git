"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArchiveIcon,
  ReceiptTextIcon,
  MessageCircleIcon,
  InboxIcon,
  ArrowRightIcon,
} from "lucide-react";
import { CrmShell } from "@/components/crm/crm-shell";
import { Badge } from "@/components/ui/badge";

type HubCard = {
  href: string;
  title: string;
  description: string;
  icon: React.ElementType;
  badge: React.ReactNode;
  disabled?: boolean;
};

export default function AssetsHubPage() {
  const [assetCount, setAssetCount] = React.useState<number | null>(null);
  const [priceSheetReviewCount, setPriceSheetReviewCount] = React.useState<number | null>(null);
  const [inboxPendingCount, setInboxPendingCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    fetch("/api/assets")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const assets = Array.isArray(data.assets) ? data.assets : [];
        const active = assets.filter((a: { archivedAt?: string | null }) => !a.archivedAt);
        setAssetCount(active.length);
      })
      .catch(() => {
        if (!cancelled) setAssetCount(null);
      });

    fetch("/api/price-sheets")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const sheets = Array.isArray(data.priceSheets) ? data.priceSheets : [];
        const needsReview = sheets.filter(
          (s: { status?: string }) => s.status && !["APPLIED", "EXTRACT_FAILED"].includes(s.status),
        );
        setPriceSheetReviewCount(needsReview.length);
      })
      .catch(() => {
        if (!cancelled) setPriceSheetReviewCount(null);
      });

    // H1: 배지에 필요한 건 개수뿐 — 목록 전체 대신 count 엔드포인트를 쓴다(스케일 낭비 제거).
    fetch("/api/reference-inbox?status=PENDING&count=1")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setInboxPendingCount(typeof data.count === "number" ? data.count : null);
      })
      .catch(() => {
        if (!cancelled) setInboxPendingCount(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const cards: HubCard[] = [
    {
      href: "/assets/archive",
      title: "자료 아카이브",
      description: "거래처·딜·캠페인·셀러별 업로드 자료를 탐색하고 관리합니다.",
      icon: ArchiveIcon,
      badge:
        assetCount === null ? (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
            불러오는 중...
          </Badge>
        ) : (
          <Badge variant="status-info" className="text-[11px]">
            자료 {assetCount}건
          </Badge>
        ),
    },
    {
      href: "/assets/price-sheets",
      title: "가격표 인제스트",
      description: "브랜드사 가격표(xlsx/이미지/pdf/pptx)를 업로드해 구조화 추출하고 딜에 반영합니다.",
      icon: ReceiptTextIcon,
      badge:
        priceSheetReviewCount === null ? (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
            불러오는 중...
          </Badge>
        ) : priceSheetReviewCount > 0 ? (
          <Badge variant="status-pending" className="text-[11px]">
            검수 {priceSheetReviewCount}건
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            검수 대기 없음
          </Badge>
        ),
    },
    {
      href: "/assets/katalk",
      title: "카톡 기록",
      description: "직원 카톡 txt 업로드 · 방 매핑 관리",
      icon: MessageCircleIcon,
      badge: (
        <Badge variant="outline" className="text-[11px] text-muted-foreground">
          업로드 · 방 관리
        </Badge>
      ),
    },
    {
      href: "/assets/inbox",
      title: "미분류 레퍼런스",
      description: "수집한 인스타/틱톡/유튜브 링크를 딜에 배정하거나 기각합니다.",
      icon: InboxIcon,
      badge:
        inboxPendingCount === null ? (
          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
            불러오는 중...
          </Badge>
        ) : inboxPendingCount > 0 ? (
          <Badge variant="status-pending" className="text-[11px]">
            미분류 {inboxPendingCount}건
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            미분류 없음
          </Badge>
        ),
    },
  ];

  return (
    <CrmShell title="자료 목록" description="자료 아카이브, 가격표 인제스트, 카톡 기록을 한 곳에서 관리합니다.">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => {
            const Icon = card.icon;
            const content = (
              <div
                className={`group flex h-full flex-col justify-between gap-4 rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.72)] p-5 shadow-soft-md backdrop-blur transition-[translate,border-color,box-shadow] ${
                  card.disabled
                    ? "opacity-70"
                    : "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-soft-hover"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </div>
                  {!card.disabled && (
                    <ArrowRightIcon className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-[15px] font-bold text-foreground">{card.title}</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">{card.description}</p>
                </div>
                <div>{card.badge}</div>
              </div>
            );

            if (card.disabled) {
              return (
                <div key={card.href} className="cursor-not-allowed">
                  {content}
                </div>
              );
            }

            return (
              <Link key={card.href} href={card.href} className="block h-full">
                {content}
              </Link>
            );
          })}
        </div>
      </div>
    </CrmShell>
  );
}
