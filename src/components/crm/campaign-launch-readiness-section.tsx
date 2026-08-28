"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type {
  ReadinessAudit,
  ReadinessLevel,
} from "@/lib/offer/launch-readiness";

/**
 * 캠페인 상세 "오픈 준비" 섹션 (C2 M4b).
 *
 * 흩어져 있던 자동 판정(오퍼 진단 · 주문관리 등록 · 채널 지정)을 한 자리에
 * 모아 SHIP/FIX/BLOCK 을 보여준다. **새 체크박스를 만들지 않는다** — 오너가
 * 체크리스트 배지를 실측 근거로 기각했기 때문이다(`campaign-setup.ts`).
 *
 * 판정 축이 둘이라는 걸 화면에서도 지킨다:
 * - **BLOCK = 사고 축**(법령·계정 리스크) — 강한 색으로 세운다.
 * - **FIX = 성과 축** — 열려도 사고는 아니지만 안 팔린다.
 * 이 구분이 흐려지면 운영자가 BLOCK 을 무시하는 법부터 배운다.
 *
 * ⛔ 오픈을 막는 UI 를 두지 않는다(스펙 §2 — 자동 차단 아님). 판정을 보여주는
 * 것까지가 이 섹션의 일이고, 열지 말지는 운영자가 정한다.
 */

type ReadinessResponse = ReadinessAudit & {
  campaignId: string;
  dealName: string | null;
  requiredDisclosureCount: number;
  /**
   * 표현 게이트가 **무엇을 근거로** 판정했는가. `NO_ASSET_DRAFT` 면 검사할 본문이
   * 없어 표현 축이 아예 돌지 않은 것이다 — 이 값을 화면이 버리면 운영자는 항목이
   * 없는 것을 "통과"로 읽는다(미검사와 무결점은 화면에서 구분되지 않는다).
   */
  claimGateSource?: "ASSET_DRAFT" | "NO_ASSET_DRAFT";
  /**
   * 브랜드용 자료의 검사 여부 — 셀러용과 **따로** 받는다(오너 결정 2026-08-02:
   * 브랜드용도 판정에 포함). 한 값으로 합치면 "둘 중 하나만 검사됨"이 "검사됨"으로
   * 뭉개져 위 규약(부재가 통과처럼 읽히면 안 된다)이 그대로 깨진다.
   */
  brandClaimGateSource?: "ASSET_DRAFT" | "NO_ASSET_DRAFT";
};

const LEVEL_META: Record<
  ReadinessLevel,
  { label: string; hint: string; badge: string }
> = {
  SHIP: {
    label: "준비됨",
    hint: "걸리는 항목이 없습니다",
    badge: "bg-status-success-bg text-foreground",
  },
  FIX: {
    label: "손볼 것 있음",
    hint: "열 수는 있지만 성과를 깎는 항목이 있습니다",
    badge: "bg-status-caution-bg text-status-caution-text",
  },
  BLOCK: {
    label: "열기 전 조치 필요",
    hint: "법령·계정 리스크가 있는 항목입니다",
    badge: "bg-status-urgent-bg text-status-urgent-text",
  },
};

const SOURCE_LABEL: Record<string, string> = {
  CLAIMS: "표현",
  OFFER: "오퍼",
  SETUP: "세팅",
  PRICE: "가격",
};

function isReadinessResponse(body: unknown): body is ReadinessResponse {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { items?: unknown; level?: unknown };
  return Array.isArray(candidate.items) && typeof candidate.level === "string";
}

export function CampaignLaunchReadinessSection({
  campaignId,
}: {
  campaignId: string;
}) {
  const [data, setData] = useState<ReadinessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/launch-readiness`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "오픈 준비 상태를 불러오지 못했습니다");
      }
      // 응답 형태를 믿지 않는다 — items 가 없는 페이로드에 렌더가 죽으면
      // 캠페인 패널 전체가 함께 죽는다(딜 패널에서 실제로 밟은 회귀).
      const body: unknown = await res.json();
      if (!isReadinessResponse(body)) {
        throw new Error("오픈 준비 응답 형식이 올바르지 않습니다");
      }
      setData(body);
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "오픈 준비 상태를 불러오지 못했습니다",
      );
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const meta = data ? (LEVEL_META[data.level] ?? LEVEL_META.FIX) : null;
  // BLOCK 이 위로 — 사고 축을 성과 축 아래에 묻지 않는다.
  const items = data
    ? [...data.items].sort((a, b) =>
        a.level === b.level ? 0 : a.level === "BLOCK" ? -1 : 1,
      )
    : [];

  return (
    <div className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center text-sm font-semibold text-foreground">
            <ShieldCheckIcon className="mr-2 size-4 text-muted-foreground" />
            오픈 준비
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            이미 기록된 판정만 모았습니다. 따로 체크할 것은 없습니다.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label="오픈 준비 다시 확인"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
        </Button>
      </div>

      {error && (
        <p className="rounded-md bg-status-urgent-bg px-3 py-2 text-xs text-status-urgent-text">
          {error}
        </p>
      )}

      {loading && !data && <Skeleton className="h-16 w-full" />}

      {data && meta && (
        <>
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
            aria-live="polite"
          >
            <span
              className={cn(
                "rounded px-2 py-0.5 text-xs font-semibold",
                meta.badge,
              )}
            >
              {meta.label}
            </span>
            <span className="text-xs text-muted-foreground">{meta.hint}</span>
            {data.daysUntilStart !== null && (
              <span className="text-xs text-muted-foreground">
                {data.daysUntilStart >= 0
                  ? `판매 시작 ${data.daysUntilStart}일 전`
                  : `판매 시작 ${Math.abs(data.daysUntilStart)}일 지남`}
              </span>
            )}
          </div>

          {items.length > 0 && (
            <ul className="space-y-2">
              {items.map((item, index) => (
                <li
                  key={`${item.source}-${index}`}
                  className="rounded-md border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {SOURCE_LABEL[item.source] ?? item.source}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px] font-medium",
                        item.level === "BLOCK"
                          ? "bg-status-urgent-bg text-status-urgent-text"
                          : "bg-status-caution-bg text-status-caution-text",
                      )}
                    >
                      {item.level === "BLOCK" ? "조치 필요" : "손볼 것"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {item.message}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-foreground">→ {item.fix}</p>
                </li>
              ))}
            </ul>
          )}

          {/* 표현 축 미검사 사유 (C1×C3 — "축을 생략하고 그 사실을 운영자에게
              알린다"). #174 가 근거 카드에서 세운 것과 같은 규약이다: 라우트가 주는
              정보를 화면이 버리면 **부재가 통과처럼 읽힌다.**

              항목 목록 **아래**에 두는 이유 — 이건 판정이 아니라 판정의 범위에 대한
              주석이다. 위로 올리면 실제 조치 항목(BLOCK/FIX)보다 먼저 읽혀 순서가
              뒤집힌다.

              심각도가 아니라 "검사 조건"이라 상태 hue 를 받지 않는다(P8 §4) —
              무채색 인셋. 컨테이너가 `bg-white/90` 이라 틴트-온-틴트가 아니다. */}
          {data.claimGateSource === "NO_ASSET_DRAFT" && (
            <p className="rounded-md border border-input bg-background px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              표현 검사는 아직 돌지 않았습니다. 셀러에게 보낸 자료가 없어 검사할
              본문이 없습니다.
              {data.requiredDisclosureCount > 0
                ? ` 필수 고지 ${data.requiredDisclosureCount}건이 등록돼 있지만, 본문에 실제로 들어갔는지는 자료가 있어야 확인됩니다.`
                : " 필수 고지도 아직 등록되지 않았습니다."}{" "}
              딜에서 콘텐츠 가이드를 생성해 보내면 다음 조회부터 금지 표현과 고지
              누락을 함께 판정합니다.
            </p>
          )}

          {/* 브랜드용 자료의 미검사 사유 — 위와 같은 규약을 같은 형태로 적용한다.
              두 유형이 각각 판정 대상이므로(오너 결정 2026-08-02) 한쪽만 비어도
              그 사실이 화면에 남아야 한다. */}
          {data.brandClaimGateSource === "NO_ASSET_DRAFT" && (
            <p className="rounded-md border border-input bg-background px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              브랜드용 자료는 아직 표현 검사를 받지 않았습니다. 브랜드에 보낸
              자료가 없어 검사할 본문이 없습니다. 브랜드용 가이드도 소비자에게
              닿으므로, 보내면 다음 조회부터 함께 판정합니다.
            </p>
          )}
        </>
      )}
    </div>
  );
}
