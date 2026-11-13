"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Search, ExternalLink, RefreshCw, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusDot, type StatusTone } from "./status-dot";
import { evaluateMarketPrice, type EvaluatedCandidate } from "@/lib/price-monitor/pipeline";
import type { PriceVerdict } from "@/lib/price-monitor/verdict";
import type { OutlierReason } from "@/lib/price-monitor/outlier";
import {
  MARKET_SOURCE_LABEL,
  summarizeSourceFailures,
  summarizeSourceStatuses,
  type MarketSourceErrors,
  type MarketSourceStates,
} from "@/lib/price-monitor/source-errors";
import { displayLabel } from "@/lib/display-label";
import type { OwnerMatchLabel, OwnerMatchLabelValue } from "@/lib/price-monitor/scoring";
import {
  buildBrandIdentities,
  parseBrandAliases,
  type MatchAccuracy,
} from "@/lib/price-monitor/match-context";
import type { LabelInsights } from "@/lib/price-monitor/label-evidence";
import { candidateNameKey, candidateUrlKey } from "@/lib/price-monitor/match-axes";
import { toast } from "@/lib/toast";

export type MonitorItem = {
  id: string;
  name: string;
  searchQuery: string;
  sellingPrice: number;
  unit?: string | null;
  expectedQuantity?: number | null;
  /** AI가 추출한 모델명/모델코드(P3-2) — evaluateMarketPrice 판정 시 매치 보너스로 사용된다. */
  modelName?: string | null;
  /** 딜 브랜드명(옵션이면 부모 것) — 브랜드·회사 축의 기본 정체성 이름(2026-11-13 3축 분리). */
  brandName?: string | null;
};

/** /api/price-monitoring/labels GET 응답 — 딜(옵션)→루트, 루트별 오너 표시·회사 이름, 정확도. */
type LabelState = {
  roots: Record<string, string>;
  labels: Record<string, OwnerMatchLabel[]>;
  aliases: Record<string, string[]>;
  accuracy: (MatchAccuracy & Partial<LabelInsights>) | null;
};

const EMPTY_LABEL_STATE: LabelState = { roots: {}, labels: {}, aliases: {}, accuracy: null };

type MultiMarketPriceMonitorProps = {
  items: MonitorItem[];
  campaignShippingFee?: number | null;
  campaignFreeShippingThreshold?: number | null;
};

type PriceItem = {
  mall: string;
  price: number;
  shippingFee: number;
  totalPrice: number;
  url: string;
  channel: string;
  productName?: string;
};

type EvaluatedPriceItem = PriceItem & EvaluatedCandidate;

type ItemEvaluation = {
  items: EvaluatedPriceItem[];
  minItem: EvaluatedPriceItem | null;
  verdict: PriceVerdict;
  ourUnitPrice: number | null;
};

const BRAND_AXIS_LABEL = { match: "브랜드 일치", missing: "브랜드 없음" } as const;

/** 상품명은 거의 같은데 브랜드·회사 이름만 안 보여 빠진 후보 — 오너가 회사 이름을 더하면 되살아난다(흐리게 덮지 않는다). */
const RESCUABLE_PRODUCT_SCORE = 70;

const EXCLUDE_REASON_LABEL: Record<OutlierReason, string> = {
  EXCLUDE_KEYWORD: "제외 키워드(중고/해외직구 등)",
  OWNER_DIFFERENT: "다른 상품으로 표시함",
  BRAND_MISMATCH: BRAND_AXIS_LABEL.missing,
  MATCH_TOO_LOW: "상품명 불일치",
  PRICE_BAND_VIOLATION: "비정상 저가(밴드 초과)",
  QUANTITY_MISMATCH: "수량 불일치",
};

// 판정 낱말은 범례(`price-defense-card.tsx` LEGEND)와 같은 한 낱말이다(상태 낱말 기준 2026-10-08,
// 설계 정본 docs/private/specs/2026-10-08-status-wording-proposal.md A10). 유지(OK)는 할 일이 없어
// 낱말 대신 「—」. 종전 라벨에 붙어 있던 풀이(±1%·일치율 낮음)는 `hint` 설명창으로 옮겼다.
// 위반 색은 원시 rose-600 대신 상태 토큰(P8 가드레일 2).
const VERDICT_BADGE: Record<
  PriceVerdict,
  { label: string; className: string; tone: StatusTone | null; hint?: string }
> = {
  OK: { label: "—", className: "text-slate-500", tone: null },
  TIE: { label: "동가", className: "text-status-caution-text", tone: "caution", hint: "최저가와 ±1% 이내입니다." },
  VIOLATED: { label: "위반", className: "text-status-urgent-text", tone: "urgent", hint: "우리 판매가보다 싼 곳이 있습니다." },
  REVIEW: { label: "검토", className: "text-status-caution-text", tone: "caution", hint: "상품명 일치율이 기준보다 낮아 자동 판정을 보류했습니다. 옵션 수량이 정해져 있는데 후보의 수량을 읽지 못하면 더 높은 기준을 쓰고, 같은 상품으로 표시한 후보는 기준과 상관없이 인정합니다." },
  NO_DATA: { label: "비교불가", className: "text-slate-500", tone: "neutral", hint: "비교할 수 있는 유효 후보가 없습니다." },
};

export function MarketPriceMonitor({
  items = [],
  campaignShippingFee,
  campaignFreeShippingThreshold,
}: MultiMarketPriceMonitorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  
  // Map of itemId -> result state
  const [results, setResults] = useState<Record<string, {
    loading: boolean;
    /**
     * 조회 API 가 준 원래 후보. 판정은 저장하지 않고 그릴 때마다 오너 표시·회사 이름을 반영해 다시 낸다
     * (표시가 조회보다 늦게 오거나 오너가 표시를 바꿔도 판정이 따라가게 — 2026-11-13).
     */
    rawItems?: PriceItem[];
    /** 입력칸에 쓰는 중인 검색어 — 칠 때마다 바뀐다. */
    searchedQuery: string;
    /** 위 rawItems 를 실제로 조회한 검색어 — 판정 기준이라 입력 중에 바뀌면 안 된다. */
    fetchedQuery?: string;
    /**
     * 소스별 실패 사유(`/api/price-monitoring` 응답의 errors). 화면 상단 경고 배너의 재료다 —
     * 이걸 버리면 3소스 중 하나가 죽어도 남은 소스로 계산된 값이 무표시로 "최저가" 행세를 한다
     * (실제로 그랬다: 쿠팡이 16일간 401 이었는데 화면에는 아무 흔적도 없었음).
     */
    sourceErrors?: MarketSourceErrors;
    /** 소스별 상태와 조회시각. legacy 응답에는 없어 unknown으로 처리한다. */
    sourceStates?: MarketSourceStates;
  }>>({});
  
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  // 오너 「같은 상품 / 다른 상품」 표시와 「같은 회사로 볼 이름」(2026-11-13 3축 분리). 판정 재료라
  // 조회 결과와 따로 들고, 그릴 때 둘을 합쳐 판정한다.
  const [labelState, setLabelState] = useState<LabelState>(EMPTY_LABEL_STATE);
  const [labelLoadError, setLabelLoadError] = useState<string | null>(null);
  const [pendingLabelKey, setPendingLabelKey] = useState<string | null>(null);
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [savingAliasRoot, setSavingAliasRoot] = useState<string | null>(null);
  const dealIdsKey = items.map((item) => item.id).filter(Boolean).join(",");

  useEffect(() => {
    if (!isOpen || !dealIdsKey) return;
    let cancelled = false;
    fetch(`/api/price-monitoring/labels?dealIds=${encodeURIComponent(dealIdsKey)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? `요청 실패 (HTTP ${res.status})`);
        return data as LabelState;
      })
      .then((data) => {
        if (cancelled) return;
        setLabelState({
          roots: data.roots ?? {},
          labels: data.labels ?? {},
          aliases: data.aliases ?? {},
          accuracy: data.accuracy ?? null,
        });
        setLabelLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // 숨기지 않는다 — 표시를 못 읽으면 판정이 오너 표시 없이 나오므로 화면 위에 알린다.
        console.error("Price match labels fetch error:", error);
        setLabelLoadError(error instanceof Error ? error.message : "불러오기 실패");
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, dealIdsKey]);

  // 옵션 딜 → 루트 딜 id 대응(라벨 표가 아니다). 응답 전에는 자기 자신을 루트로 본다.
  const rootOf = (dealId: string) => {
    const mappedRoot = labelState.roots[dealId];
    return mappedRoot ?? dealId;
  };

  const toggleExpand = (id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const getOurShipping = (sellingPrice: number) => {
    return campaignShippingFee &&
      (!campaignFreeShippingThreshold || sellingPrice < campaignFreeShippingThreshold)
        ? campaignShippingFee
        : 0;
  };

  const fetchSingleItem = async (item: MonitorItem, customQuery?: string) => {
    const queryToSearch = customQuery ?? item.searchQuery;
    setResults(prev => ({
      ...prev,
      [item.id]: { ...prev[item.id], loading: true, searchedQuery: queryToSearch }
    }));

    try {
      const res = await fetch("/api/price-monitoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: queryToSearch }),
      });
      if (res.ok) {
        const data = await res.json();
        setResults(prev => ({
          ...prev,
          [item.id]: {
            loading: false,
            rawItems: (data.allItems || []) as PriceItem[],
            searchedQuery: queryToSearch,
            fetchedQuery: queryToSearch,
            sourceErrors: data.errors as MarketSourceErrors | undefined,
            sourceStates: data.sources as MarketSourceStates | undefined,
          }
        }));
      } else {
        throw new Error(`요청 실패 (HTTP ${res.status})`);
      }
    } catch (error) {
      console.error("Price monitor fetch error:", error);
      const reason = error instanceof Error ? error.message : "조회 요청 실패";
      setResults(prev => ({
        ...prev,
        [item.id]: {
          loading: false,
          rawItems: [],
          searchedQuery: queryToSearch,
          fetchedQuery: queryToSearch,
          // 요청 자체가 실패하면 어느 소스도 조회되지 않은 것이다. NO_DATA 배지만으로는
          // "검색 결과가 없다"로 읽혀(아래 렌더) 장애가 정상 결과로 위장되므로 3소스 전부
          // 실패로 표기해 같은 배너에 태운다.
          sourceErrors: { naver: reason, coupang: reason, kakao: reason },
        }
      }));
    }
  };

  const evaluateItem = (item: MonitorItem, res: (typeof results)[string] | undefined): ItemEvaluation => {
    const root = rootOf(item.id);
    const result = evaluateMarketPrice({
      candidates: res?.rawItems ?? [],
      targetQuery: res?.fetchedQuery ?? res?.searchedQuery ?? item.searchQuery,
      ourTotalPrice: item.sellingPrice + getOurShipping(item.sellingPrice),
      expectedUnit: item.unit,
      expectedQuantity: item.expectedQuantity,
      modelName: item.modelName,
      brandIdentities: buildBrandIdentities(item.brandName, (labelState.aliases[root] ?? []).join("\n")),
      ownerLabels: labelState.labels[root] ?? [],
    });
    return {
      items: result.allScored,
      minItem: result.minValidItem,
      verdict: result.verdict,
      ourUnitPrice: result.ourUnitPrice,
    };
  };

  /** 후보에 붙은 저장된 표시를 찾는다 — scoring.findOwnerLabel 과 같은 열쇠(판매처+상품명)로만. */
  const findStoredLabel = (root: string, candidate: EvaluatedPriceItem) => {
    const nameKey = candidateNameKey(candidate.mall, candidate.productName);
    return (labelState.labels[root] ?? []).find((l) => l.nameKey === nameKey);
  };

  const warnIfNotReevaluated = (reevaluateError: unknown) => {
    if (typeof reevaluateError === "string" && reevaluateError) {
      toast.warning("저장했지만 홈 화면 판정은 다음 정기 조회 때 바뀝니다.", { description: reevaluateError });
    }
  };

  const submitLabel = async (
    item: MonitorItem,
    candidate: EvaluatedPriceItem,
    label: OwnerMatchLabelValue,
    searchQuery: string,
  ) => {
    const root = rootOf(item.id);
    const busyKey = `${root}|${candidateNameKey(candidate.mall, candidate.productName)}`;
    setPendingLabelKey(busyKey);
    try {
      const res = await fetch("/api/price-monitoring/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId: item.id,
          label,
          candidate: {
            channel: candidate.channel,
            mall: candidate.mall,
            productName: candidate.productName,
            url: candidate.url,
          },
          // 서버가 이 검색어로 후보를 다시 판정해 원인 근거를 저장한다(시스템 판정도 서버가 정한다).
          searchQuery,
          // 화면이 처음 채운 검색어 — 오너가 고쳐 조회했는지 서버가 근거에 남긴다.
          defaultQuery: item.searchQuery,
          // 표시하던 순간 화면에 보이던 판정 — 서버 재판정과 다를 때의 진단용 참고값.
          seen: {
            matchScore: candidate.matchScore,
            excludeReason: candidate.excludeReason ?? null,
            ownerLabel: candidate.ownerLabel ?? null,
          },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `저장 실패 (HTTP ${res.status})`);
      const savedRoot: string = data.rootDealId ?? root;
      setLabelState((prev) => {
        const others = (prev.labels[savedRoot] ?? []).filter((l) => l.nameKey !== data.nameKey);
        return {
          ...prev,
          roots: { ...prev.roots, [item.id]: savedRoot },
          labels: {
            ...prev.labels,
            [savedRoot]: [...others, { nameKey: data.nameKey, urlKey: candidateUrlKey(candidate.url), label }],
          },
          accuracy: data.accuracy ?? prev.accuracy,
        };
      });
      warnIfNotReevaluated(data.reevaluateError);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "표시를 저장하지 못했습니다.");
    } finally {
      setPendingLabelKey(null);
    }
  };

  const removeLabel = async (item: MonitorItem, candidate: EvaluatedPriceItem) => {
    const root = rootOf(item.id);
    const stored = findStoredLabel(root, candidate);
    if (!stored) return;
    setPendingLabelKey(`${root}|${candidateNameKey(candidate.mall, candidate.productName)}`);
    try {
      const res = await fetch("/api/price-monitoring/labels", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: item.id, nameKey: stored.nameKey }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `취소 실패 (HTTP ${res.status})`);
      setLabelState((prev) => ({
        ...prev,
        labels: { ...prev.labels, [root]: (prev.labels[root] ?? []).filter((l) => l.nameKey !== stored.nameKey) },
        accuracy: data.accuracy ?? prev.accuracy,
      }));
      warnIfNotReevaluated(data.reevaluateError);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "표시를 취소하지 못했습니다.");
    } finally {
      setPendingLabelKey(null);
    }
  };

  const saveAliases = async (item: MonitorItem) => {
    const root = rootOf(item.id);
    const draft = aliasDrafts[root];
    if (draft === undefined) return;
    setSavingAliasRoot(root);
    try {
      const res = await fetch("/api/price-monitoring/brand-aliases", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: item.id, aliases: parseBrandAliases(draft) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `저장 실패 (HTTP ${res.status})`);
      const savedRoot: string = data.rootDealId ?? root;
      setLabelState((prev) => ({
        ...prev,
        roots: { ...prev.roots, [item.id]: savedRoot },
        aliases: { ...prev.aliases, [savedRoot]: data.aliases ?? [] },
      }));
      setAliasDrafts((prev) => {
        const next = { ...prev };
        delete next[root];
        return next;
      });
      toast.success("같은 회사로 볼 이름을 저장했습니다.");
      warnIfNotReevaluated(data.reevaluateError);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "이름을 저장하지 못했습니다.");
    } finally {
      setSavingAliasRoot(null);
    }
  };

  const fetchAll = async () => {
    setLoadingAll(true);
    await Promise.allSettled(items.map(item => fetchSingleItem(item)));
    setLoadingAll(false);
  };

  /**
   * 아래 자동 조회 effect 가 "구독하지 않고 최신값만 읽어야 하는" 두 값의 통로다.
   * ⚠️ `results` 를 effect 의존성에 넣으면 안 된다 — effect 가 `fetchSingleItem` 으로
   * `results` 를 갱신하므로 자기 자신을 재트리거한다(첫 setResults 가 loading:true 를
   * 심어 필터에 걸리긴 하지만, 조회 완료·재조회마다 effect 가 계속 깨어난다).
   * `fetchSingleItem` 도 매 렌더 새 함수라 같은 문제를 만든다. 따라서 두 값은 ref 로
   * 끊고, effect 는 원래 의도대로 "열림 · 대상 목록"에만 반응한다.
   */
  const latestRef = useRef({ results, fetchSingleItem });
  useEffect(() => {
    latestRef.current = { results, fetchSingleItem };
  });

  useEffect(() => {
    if (isOpen) {
      // Auto-fetch all items that don't have results yet
      const { results: latestResults, fetchSingleItem: fetchLatest } = latestRef.current;
      const itemsToFetch = items.filter(item => !latestResults[item.id]);
      if (itemsToFetch.length > 0) {
        setLoadingAll(true);
        Promise.allSettled(itemsToFetch.map(item => fetchLatest(item))).then(() => {
          setLoadingAll(false);
        });
      }
    }
  }, [isOpen, items]);

  // 소스 실패는 딜마다 같은 값으로 반복되므로(같은 키·같은 API) 딜별로 붙이지 않고
  // 목록 위 한 곳에 모은다 — 17줄에 같은 경고를 반복하면 P8 §2대로 경고가 배경이 된다.
  const sourceObservations = items.map((i) => ({
    errors: results[i.id]?.sourceErrors,
    sources: results[i.id]?.sourceStates,
  }));
  const sourceFailure = summarizeSourceFailures(sourceObservations);
  const sourceStatus = summarizeSourceStatuses(sourceObservations);

  const sourceStatusLabel: Record<"ok" | "empty" | "error" | "disabled", string> = {
    ok: "정상",
    empty: "결과 없음",
    error: "실패",
    disabled: "비활성",
  };

  const formatCheckedAt = (checkedAt: string): string => {
    const date = new Date(checkedAt);
    return Number.isNaN(date.getTime())
      ? checkedAt
      : date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 rounded-lg px-3 text-xs shadow-soft-sm flex items-center gap-1.5 border-primary/30 bg-white text-primary hover:bg-primary-tint hover:text-primary transition-colors">
          <Search className="w-3.5 h-3.5" />
          {/* 「최저가 조회」 → 「가격조회」(오너 지시 2026-08-28) — 매출 상세 내역 헤더가
              한 줄에 들어가게 하는 폭 절감의 일부다. 다이얼로그 안 문구는 그대로 둔다
              (거기선 폭이 문제가 아니고 「시장 최저가」가 정확한 말이다). */}
          가격조회
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-[1000px] !max-w-[1000px] w-[95vw] max-h-[90vh] flex flex-col overflow-hidden p-0 sm:p-5 gap-0 sm:gap-3">
        <DialogHeader className="shrink-0 flex flex-row items-center justify-between p-3 sm:p-0 pb-2 border-b sm:border-0">
          <DialogTitle className="text-base">시장 최저가 일괄 모니터링</DialogTitle>
          <Button onClick={fetchAll} disabled={loadingAll || items.length === 0} className="w-24 h-8 text-xs">
            {loadingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <><RefreshCw className="w-3 h-3 mr-1"/> 전체 조회</>}
          </Button>
        </DialogHeader>

        {/*
          소스 결손 고지 — 아래 판정이 "무엇을 보고" 내려졌는지를 밝힌다(P2 Decision-Value:
          판정의 신뢰 조건이라 장식이 아니다). 색은 P8 §1 심각도 축의 caution 을 탄다.
          ⚠️ 텍스트에 opacity 를 얹지 말 것 — globals.css 의 --status-caution 주석대로 /70·/80 은
          AA 가 무너진다. 위계는 불투명 --status-caution-text + font-weight 로만 준다.
        */}
        {sourceFailure && (
          <div
            role="status"
            className="shrink-0 mx-3 sm:mx-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-status-caution/25 bg-status-caution-bg px-3.5 py-2.5 text-xs text-status-caution-text"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="font-semibold">
              {sourceFailure.failed.length > 0
                ? `${sourceFailure.failed.map((f) => f.label).join(" · ")} 소스 응답 실패`
                : sourceFailure.disabled.length > 0
                  ? `${sourceFailure.disabled.map((f) => f.label).join(" · ")} 소스 비활성`
                  : "소스 상태를 확인할 수 없습니다."}
            </span>
            <span className="font-normal">
              {sourceFailure.includedLabels.length > 0
                ? `아래 최저가와 판정은 ${sourceFailure.includedLabels.join(" · ")}만 보고 계산됐습니다.`
                : "판정 근거가 된 소스를 확인할 수 없습니다."}
            </span>
            {sourceFailure.failed.length > 0 && (
              <span className="w-full text-[11px] font-normal">
                {sourceFailure.failed.map((f) => `${f.label}: ${f.reason}`).join(" / ")}
              </span>
            )}
          </div>
        )}

        {sourceStatus && (
          <div className="shrink-0 mx-3 sm:mx-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <span className="font-semibold text-slate-600">소스별 조회</span>
            {sourceStatus.statuses.map((status) => (
              <span key={status.channel}>
                {MARKET_SOURCE_LABEL[status.channel]} {sourceStatusLabel[status.status]} · {formatCheckedAt(status.checkedAt)}
              </span>
            ))}
            {sourceStatus.unknown && <span>소스 상태 미확인</span>}
          </div>
        )}

        {labelLoadError && (
          <div
            role="status"
            className="shrink-0 mx-3 sm:mx-0 flex items-center gap-2 rounded-xl border border-status-caution/25 bg-status-caution-bg px-3.5 py-2 text-xs text-status-caution-text"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="font-semibold">내 표시를 불러오지 못해 자동 판정만 보입니다.</span>
            <span className="font-normal">{labelLoadError}</span>
          </div>
        )}

        {labelState.accuracy && labelState.accuracy.total > 0 && (
          <div className="shrink-0 mx-3 sm:mx-0 text-[11px] text-slate-500">
            <span className="font-semibold text-slate-600">자동 판정 정확도</span>{" "}
            내가 표시한 {labelState.accuracy.total}건 중 {labelState.accuracy.agreed}건이 자동 판정과 같음
            ({Math.round((labelState.accuracy.agreed / labelState.accuracy.total) * 100)}%)
            {/* 어긋난 표시의 원인과 「다른 상품」을 가른 낱말 — 판정 기준을 고칠 근거(오너 지시 2026-11-13). */}
            {labelState.accuracy.causes && labelState.accuracy.causes.length > 0 && (
              <div>
                <span className="font-semibold text-slate-600">어긋난 원인</span>{" "}
                {labelState.accuracy.causes.map((c, index) => (
                  <span key={c.cause}>
                    {index > 0 && " · "}
                    {c.examples?.length ? (
                      // 예시 상품명은 설명창으로 — 마우스·키보드 포커스·터치로 열린다(UI Copy Standard ②).
                      <StatusDot
                        tone="neutral"
                        showDot={false}
                        label={`${c.label} ${c.count}건`}
                        hint={`예: ${c.examples.join(", ")}`}
                        className="whitespace-normal text-[11px] font-normal text-slate-500"
                      />
                    ) : (
                      <span>
                        {c.label} {c.count}건
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}
            {labelState.accuracy.differentWords && labelState.accuracy.differentWords.length > 0 && (
              <div>
                <span className="font-semibold text-slate-600">다른 상품에만 있던 낱말</span>{" "}
                {labelState.accuracy.differentWords.map((w) => `${w.word} ${w.count}`).join(" · ")}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 space-y-3 p-3 sm:p-0">
          {items.map(item => {
            const res = results[item.id];
            const isLoading = res?.loading;
            const evaluation = evaluateItem(item, res);
            const minItem = evaluation.minItem;
            const fetchedItems = evaluation.items;
            const validItems = fetchedItems.filter((i) => !i.excludeReason);
            const isSearched = !!res;
            const verdict: PriceVerdict = res && !res.loading ? evaluation.verdict : "NO_DATA";
            const root = rootOf(item.id);
            const savedAliases = labelState.aliases[root] ?? [];
            const aliasDraft = aliasDrafts[root];

            const ourShipping = getOurShipping(item.sellingPrice);
            const ourTotalPrice = item.sellingPrice + ourShipping;

            const secondItem = validItems.length > 1 ? validItems[1] : null;

            let gapAmount = 0;
            let diffText = "";
            if (minItem) {
              if (verdict === "TIE") {
                diffText = "시장가와 사실상 동일(±1%)";
              } else if (verdict === "OK") {
                if (secondItem) {
                  gapAmount = secondItem.totalPrice - ourTotalPrice;
                  diffText = `2위보다 ${formatCurrency(gapAmount)}원 저렴`;
                } else {
                  diffText = "단독 최저가";
                }
              } else if (verdict === "VIOLATED") {
                gapAmount = ourTotalPrice - minItem.totalPrice;
                diffText = `1위보다 ${formatCurrency(gapAmount)}원 비쌈`;
              } else if (verdict === "REVIEW") {
                diffText = "더 싼 후보가 같은 상품인지 확인 필요";
              }
            }

            const isExpanded = expandedItems[item.id];

            return (
              <div key={item.id} className="border rounded-lg bg-white overflow-hidden shadow-soft-sm">
                {/* Header row (summary) */}
                <div 
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-3 cursor-pointer hover:bg-slate-50 transition-colors gap-2 sm:gap-0"
                  onClick={() => toggleExpand(item.id)}
                >
                  <div className="flex-1 min-w-0">
                    {/* 머리 줄 클릭은 포인터 편의이고, 키보드 도달·aria-expanded 계약은 품목명의 실제
                        button 이 진다(interfaces 점검 묶음 G2). stopPropagation — 머리 줄 onClick 과
                        겹치면 토글이 두 번 돌아 원위치된다. */}
                    <h4 className="text-xs font-semibold text-slate-800 truncate" title={item.name}>
                      <button
                        type="button"
                        aria-expanded={Boolean(isExpanded)}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpand(item.id);
                        }}
                        className="max-w-full truncate rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        {item.name}
                      </button>
                    </h4>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      우리 판매가: <span className="font-medium text-slate-700">{formatCurrency(ourTotalPrice)}원</span>
                      {evaluation.ourUnitPrice != null && (
                        <span className="text-slate-500"> ({formatCurrency(Math.round(evaluation.ourUnitPrice))}원/{item.unit ?? "단위"})</span>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 flex sm:justify-center items-center">
                    {isLoading ? (
                      <div className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" /> 조회 중...
                      </div>
                    ) : isSearched ? (
                      <div>
                        {VERDICT_BADGE[verdict].tone ? (
                          // 머리 줄 전체가 펼치기 클릭 영역이라 설명창 트리거의 클릭이 줄을 접고 펴지 않게 막는다
                          // (트리거가 있을 때만 — 「—」 주변 클릭은 그대로 줄을 편다).
                          <div className="flex items-center" onClick={(event) => event.stopPropagation()}>
                            <StatusDot
                              tone={VERDICT_BADGE[verdict].tone}
                              label={VERDICT_BADGE[verdict].label}
                              hint={VERDICT_BADGE[verdict].hint}
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">{VERDICT_BADGE[verdict].label}</span>
                        )}
                        {diffText && <div className={`text-[9px] mt-0.5 ${VERDICT_BADGE[verdict].className}`}>{diffText}</div>}
                        {verdict === "NO_DATA" && (
                          <div className="text-[9px] mt-0.5 text-slate-500">
                            {fetchedItems.length > 0 ? "남은 후보가 모두 배제돼 비교할 수 없음" : "검색 결과 없음"}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">대기 중</div>
                    )}
                  </div>

                  <div className="flex-1 flex items-center justify-between sm:justify-end gap-3">
                    <div className="text-left sm:text-right">
                      <div className="text-[11px] text-slate-500 mb-0.5">시장 유효 최저가</div>
                      {isLoading ? (
                        <div className="text-sm font-bold text-slate-500">...</div>
                      ) : minItem ? (
                        <div>
                          <div className="text-sm font-bold text-primary">{formatCurrency(minItem.totalPrice)}원</div>
                          {minItem.unitPrice != null && (
                            <div className="text-[9px] text-slate-500">{formatCurrency(Math.round(minItem.unitPrice))}원/{item.unit ?? "단위"}</div>
                          )}
                        </div>
                      ) : (
                        <div className="text-sm font-bold text-slate-500">-</div>
                      )}
                    </div>
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
                  </div>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="border-t bg-slate-50 p-3">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        <input
                          type="text"
                          value={res?.searchedQuery ?? item.searchQuery}
                          onChange={(e) => {
                            const val = e.target.value;
                            setResults(prev => ({
                              ...prev,
                              [item.id]: { ...prev[item.id], searchedQuery: val }
                            }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              fetchSingleItem(item, res?.searchedQuery ?? item.searchQuery);
                            }
                          }}
                          className="w-full h-8 pl-8 pr-3 rounded-md border text-xs bg-white"
                          placeholder="검색어 입력..."
                        />
                      </div>
                      <Button 
                        size="sm" 
                        variant="secondary"
                        onClick={() => fetchSingleItem(item, res?.searchedQuery ?? item.searchQuery)} 
                        disabled={isLoading}
                        className="h-8 text-[11px] px-3"
                      >
                        {isLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1"/>} 재조회
                      </Button>
                    </div>

                    {/* 브랜드·회사 축의 이름 목록. 상품명에 브랜드만·제조사만·둘 다 적히는 경우가 섞여 있어
                        (오너 관찰 2026-11-13) 판매 조건 브랜드명 외에 같은 회사로 볼 이름을 더 받는다. */}
                    <div className="mb-3">
                      <div className="flex items-center gap-2">
                        <label htmlFor={`brand-aliases-${item.id}`} className="shrink-0 text-[11px] font-medium text-slate-600">
                          같은 회사로 볼 이름
                        </label>
                        <input
                          id={`brand-aliases-${item.id}`}
                          type="text"
                          value={aliasDraft ?? savedAliases.join(", ")}
                          onChange={(e) => {
                            const val = e.target.value;
                            setAliasDrafts((prev) => ({ ...prev, [root]: val }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveAliases(item);
                          }}
                          className="h-8 min-w-0 flex-1 rounded-md border bg-white px-3 text-xs"
                          placeholder="제조사·공식몰 이름 (쉼표로 구분)"
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => saveAliases(item)}
                          disabled={aliasDraft === undefined || savingAliasRoot === root}
                          className="h-8 text-[11px] px-3"
                        >
                          {savingAliasRoot === root ? <Loader2 className="w-3 h-3 animate-spin" /> : "저장"}
                        </Button>
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500">
                        {item.brandName ? `브랜드명 「${item.brandName}」` : "브랜드명"}이나 이 이름 중 하나가 상품명·판매처에 있으면 같은 회사 제품으로 봅니다. 이 판매 조건의 모든 옵션에 적용됩니다. 표에서 「{BRAND_AXIS_LABEL.missing}」으로 빠진 후보가 같은 회사 제품이면 그 회사 이름을 여기 더하세요.
                      </p>
                    </div>

                    <div className="border rounded-lg bg-white overflow-x-auto">
                      <table className="w-full text-xs text-slate-600">
                        <thead>
                          <tr className="border-b">
                            <th className="font-semibold px-2 py-2 text-left w-[9%]">채널</th>
                            <th className="font-semibold px-2 py-2 text-left w-[13%]">판매처</th>
                            <th className="font-semibold px-2 py-2 text-left w-[24%]">수집된 상품명</th>
                            <th className="font-semibold px-2 py-2 text-center w-[12%]">분석</th>
                            <th className="font-semibold px-2 py-2 text-right w-[9%]">상품가</th>
                            <th className="font-semibold px-2 py-2 text-right w-[7%]">배송비</th>
                            <th className="font-semibold px-2 py-2 text-right w-[10%]">최종가</th>
                            <th className="font-semibold px-2 py-2 text-left w-[16%]">비고</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fetchedItems.map((fetchedItem, idx) => {
                            const isExcluded = !!fetchedItem.excludeReason;
                            const isLowest = !isExcluded && minItem?.url === fetchedItem.url;
                            const labelBusy = pendingLabelKey === `${root}|${candidateNameKey(fetchedItem.mall, fetchedItem.productName)}`;
                            const cheaperThanOurs = isLowest && fetchedItem.totalPrice < ourTotalPrice;
                            // 확정 위반만 빨강, 같은 상품인지 확인 전(검토)이면 주의색 — 다른 상품일 수 있는 후보를 확정 위험으로 칠하지 않는다.
                            const isDanger = cheaperThanOurs && verdict === "VIOLATED";
                            const isUnconfirmed = cheaperThanOurs && verdict === "REVIEW";
                            // 상품명은 거의 같은데 회사 이름만 안 보여 빠진 후보는 흐리게 두지 않는다(오너가 되살릴 행).
                            const isRescuable =
                              fetchedItem.excludeReason === "BRAND_MISMATCH" && fetchedItem.matchScore >= RESCUABLE_PRODUCT_SCORE;

                            let scoreColor = "text-slate-500";
                            if (fetchedItem.matchScore >= 80) scoreColor = "text-status-success font-medium";
                            else if (fetchedItem.matchScore >= 50) scoreColor = "text-status-caution-text font-medium";
                            else scoreColor = "text-status-urgent-text font-medium";

                            return (
                              <tr
                                key={idx}
                                className={`border-b last:border-0 ${isDanger ? 'bg-status-urgent-bg' : isUnconfirmed ? 'bg-status-caution-bg' : isExcluded && !isRescuable ? 'bg-slate-50/70 opacity-60' : isExcluded ? 'bg-slate-50/70' : 'hover:bg-slate-50'}`}
                              >
                                <td className="px-2 py-2.5">
                                  <Badge variant="secondary" className="bg-slate-100 text-slate-600 font-normal shadow-none px-1.5 py-0 text-[10px]">
                                    {displayLabel(MARKET_SOURCE_LABEL, fetchedItem.channel)}
                                  </Badge>
                                </td>
                                <td className="px-2 py-2.5 truncate max-w-[100px]">{fetchedItem.mall}</td>
                                <td className={`px-2 py-2.5 truncate max-w-[200px] ${isDanger ? 'font-medium text-status-urgent-text' : ''}`} title={fetchedItem.productName}>
                                  {fetchedItem.productName || "-"}
                                </td>
                                <td className="px-2 py-2.5 text-center">
                                  {/* 세 축을 섞지 않고 따로 보인다(오너 지적 2026-11-13): 상품 일치율 · 브랜드 · 수량. */}
                                  <div className={`text-[11px] ${scoreColor}`}>
                                    상품명 {fetchedItem.matchScore}%
                                  </div>
                                  {fetchedItem.brandMatch && fetchedItem.brandMatch !== "unknown" && (
                                    <div className={`text-[10px] ${fetchedItem.brandMatch === "missing" ? "font-medium text-slate-700" : "text-slate-500"}`}>
                                      {BRAND_AXIS_LABEL[fetchedItem.brandMatch]}
                                    </div>
                                  )}
                                  {item.unit && (
                                    <div className="text-[10px] text-slate-500">
                                      {fetchedItem.extractedQuantity != null
                                        ? `${fetchedItem.extractedQuantity}${item.unit}`
                                        : `수량(?)`}
                                    </div>
                                  )}
                                  {fetchedItem.unitPrice != null && (
                                    <div className="text-[9px] text-slate-500">{formatCurrency(Math.round(fetchedItem.unitPrice))}원/{item.unit ?? "단위"}</div>
                                  )}
                                </td>
                                <td className="px-2 py-2.5 text-right">{formatCurrency(fetchedItem.price)}</td>
                                <td className="px-2 py-2.5 text-right text-slate-500">{formatCurrency(fetchedItem.shippingFee)}</td>
                                <td className={`px-2 py-2.5 text-right font-semibold ${isDanger ? 'text-status-urgent-text' : 'text-slate-700'}`}>
                                  <a href={fetchedItem.url} target="_blank" rel="noreferrer" className="flex items-center justify-end gap-1 hover:underline">
                                    {formatCurrency(fetchedItem.totalPrice)}
                                    <ExternalLink className="w-3 h-3 text-slate-400" />
                                  </a>
                                </td>
                                <td className="px-2 py-2.5">
                                  <div className="flex flex-col items-start gap-1">
                                    {fetchedItem.excludeReason && (
                                      <span className="text-[10px] text-slate-500">
                                        배제: {EXCLUDE_REASON_LABEL[fetchedItem.excludeReason]}
                                      </span>
                                    )}
                                    {fetchedItem.ownerLabel === "SAME" && (
                                      <span className="text-[10px] font-medium text-slate-700">같은 상품으로 표시함</span>
                                    )}
                                    {fetchedItem.ownerLabel ? (
                                      <Button
                                        size="xs"
                                        variant="ghost"
                                        disabled={labelBusy}
                                        onClick={() => removeLabel(item, fetchedItem)}
                                        title="이 판매 조건의 모든 옵션에서 표시를 지웁니다"
                                        className="h-6 px-1.5 text-[10px] text-slate-600"
                                      >
                                        표시 취소
                                      </Button>
                                    ) : fetchedItem.productName ? (
                                      <div className="flex gap-1">
                                        <Button
                                          size="xs"
                                          variant={isExcluded ? "ghost" : "outline"}
                                          disabled={labelBusy}
                                          onClick={() => submitLabel(item, fetchedItem, "SAME", res?.fetchedQuery ?? item.searchQuery)}
                                          aria-label={`${fetchedItem.productName}: 우리 상품과 같은 상품으로 표시`}
                                          title="우리 상품과 같은 상품"
                                          className={`h-6 px-1.5 text-[10px] ${isExcluded ? "text-slate-500" : ""}`}
                                        >
                                          같은 상품
                                        </Button>
                                        <Button
                                          size="xs"
                                          variant={isExcluded ? "ghost" : "outline"}
                                          disabled={labelBusy}
                                          onClick={() => submitLabel(item, fetchedItem, "DIFFERENT", res?.fetchedQuery ?? item.searchQuery)}
                                          aria-label={`${fetchedItem.productName}: 우리 상품과 다른 상품으로 표시`}
                                          title="우리 상품과 다른 상품"
                                          className={`h-6 px-1.5 text-[10px] ${isExcluded ? "text-slate-500" : ""}`}
                                        >
                                          다른 상품
                                        </Button>
                                      </div>
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                          {!isLoading && fetchedItems.length === 0 && isSearched && (
                            <tr>
                              <td colSpan={8} className="px-3 py-6 text-center text-slate-500 text-[11px]">
                                검색 결과 없음
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          
          {items.length === 0 && (
            <div className="py-12 text-center text-slate-500 text-sm">
              모니터링할 품목이 없습니다. 하위 품목을 먼저 추가해주세요.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

