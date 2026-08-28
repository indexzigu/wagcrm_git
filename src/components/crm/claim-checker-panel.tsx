"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ShieldCheckIcon,
  TriangleAlertIcon,
  OctagonAlertIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  checkText,
  groupViolations,
  type BannedRuleInput,
  type DealClaimInput,
} from "@/lib/claims/claim-gate";
import { cn } from "@/lib/utils";

/**
 * 표현 검사 패널 (C1 M2).
 *
 * 지원하는 판단: **"이 문구를 이대로 내보내도 되는가"** — 셀러에게 브리프를
 * 보내기 전, 셀러가 올린 초안을 승인하기 전. 지금까지 운영자 기억에 의존하던
 * 점검을 근거(법령 조문)와 함께 즉시 보여준다.
 *
 * 색은 심각도 축 하나만 탄다(P8 §1) — 카테고리 선택은 범주라 무채색(§4).
 * 캐리어는 배지 fill + 본문 하이라이트 + 목록 좌측 바를 겹친다(§3).
 */

const CATEGORY_OPTIONS = [
  { value: "GENERAL", label: "공통 (카테고리 미지정)" },
  { value: "FOOD", label: "식품" },
  { value: "SUPPLEMENT", label: "건강기능식품" },
  { value: "COSMETIC", label: "화장품" },
] as const;

/** 심각도 → 표면별 토큰. tint 배경 위에서는 `-text` 짝을 쓴다(P8 §5). */
const SEVERITY_STYLE = {
  BLOCK: {
    label: "사용 불가",
    chip: "bg-status-urgent-bg text-status-urgent-text",
    bar: "bg-status-urgent",
    // 본문 하이라이트에서 BLOCK/WARN이 색조로만 갈리면 색각 이상 사용자는
    // 스캔 중 구분하지 못한다. BLOCK에만 밑줄을 얹어 2차 인코딩한다.
    mark: "bg-status-urgent-bg text-status-urgent-text underline decoration-status-urgent decoration-2 underline-offset-2",
  },
  WARN: {
    label: "확인 필요",
    chip: "bg-status-caution-bg text-status-caution-text",
    bar: "bg-status-caution",
    mark: "bg-status-caution-bg text-status-caution-text",
  },
} as const;

type Segment = { text: string; severity: "BLOCK" | "WARN" | null };

/** `/api/deals/[id]/claims` 응답 행 중 게이트가 쓰는 부분. */
type RawClaim = {
  id: string;
  kind: DealClaimInput["kind"];
  text: string;
  status: string;
};

/**
 * 본문을 위반 구간 기준으로 쪼갠다.
 *
 * 겹치는 매치는 **버리지 않고 병합**한다 — 서로 다른 규칙이 겹쳐 걸릴 때
 * (예: "아토피" WARN 과 "아토피 치료" BLOCK) 뒤 매치를 건너뛰면 목록에는
 * 잡히는데 본문에서는 그 구간을 찾을 수 없어, 운영자가 "어디가 문제인지"를
 * 못 짚는다. 병합 구간의 심각도는 더 무거운 쪽(BLOCK)을 따른다.
 */
function toSegments(
  text: string,
  spans: { span: [number, number]; severity: "BLOCK" | "WARN" }[],
): Segment[] {
  const merged: { start: number; end: number; severity: "BLOCK" | "WARN" }[] =
    [];
  for (const { span, severity } of [...spans].sort(
    (a, b) => a.span[0] - b.span[0],
  )) {
    const [start, end] = span;
    const last = merged[merged.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      if (severity === "BLOCK") last.severity = "BLOCK";
      continue;
    }
    merged.push({ start, end, severity });
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const { start, end, severity } of merged) {
    if (start > cursor)
      segments.push({ text: text.slice(cursor, start), severity: null });
    segments.push({ text: text.slice(start, end), severity });
    cursor = end;
  }
  if (cursor < text.length)
    segments.push({ text: text.slice(cursor), severity: null });
  return segments;
}

export type CheckerDeal = {
  id: string;
  dealName: string;
  brandName: string | null;
  category: string | null;
};

const NO_DEAL = "__none__";

export function ClaimCheckerPanel({
  rules,
  deals = [],
}: {
  rules: BannedRuleInput[];
  deals?: CheckerDeal[];
}) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState<string>("GENERAL");
  const [dealId, setDealId] = useState<string>(NO_DEAL);
  const [dealClaims, setDealClaims] = useState<DealClaimInput[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimsError, setClaimsError] = useState<string | null>(null);

  // 딜을 고르면 그 딜의 **승인된** 클레임만 게이트에 넣는다 — 검토 대기·거절
  // 상태가 검사에 반영되면 승인 규율(C1 §2-3)이 무의미해진다. 옵션 딜의 부모
  // 상속은 API가 처리한다.
  useEffect(() => {
    if (dealId === NO_DEAL) {
      setDealClaims([]);
      setClaimsError(null);
      return;
    }
    let cancelled = false;
    setClaimsLoading(true);
    setClaimsError(null);
    fetch(`/api/deals/${dealId}/claims`)
      .then((res) => {
        if (!res.ok) throw new Error("딜 표현을 불러오지 못했습니다");
        return res.json();
      })
      .then((data: { category: string | null; claims: RawClaim[] }) => {
        if (cancelled) return;
        setDealClaims(
          (data.claims ?? [])
            .filter((claim) => claim.status === "APPROVED")
            .map((claim) => ({
              id: claim.id,
              kind: claim.kind,
              text: claim.text,
            })),
        );
        if (data.category) setCategory(data.category);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDealClaims([]);
        setClaimsError(
          err instanceof Error ? err.message : "딜 표현 로드 실패",
        );
      })
      .finally(() => {
        if (!cancelled) setClaimsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  const result = useMemo(() => {
    if (!text.trim()) return null;
    // GENERAL은 "카테고리 미지정" — 공통 규칙(category=null)만 적용된다.
    return checkText(text, {
      rules,
      category: category === "GENERAL" ? null : category,
      dealClaims,
    });
  }, [text, category, rules, dealClaims]);

  const segments = useMemo(() => {
    if (!result) return [];
    return toSegments(
      text,
      result.violations.map((v) => ({ span: v.span, severity: v.severity })),
    );
  }, [result, text]);

  /**
   * 목록은 접어서 세운다 — 본문 하이라이트(`segments`)는 위에서 span 전량을 쓰므로
   * 몇 곳에 걸렸는지는 이미 본문이 보여 준다. 아래 카드까지 같은 문구를 반복하면
   * 목록 길이만 늘고 새로 알게 되는 것이 없다.
   */
  const violationGroups = useMemo(
    () => groupViolations(result?.violations ?? []),
    [result],
  );

  const activeRuleCount = useMemo(
    () =>
      rules.filter(
        (r) =>
          !r.category ||
          r.category === (category === "GENERAL" ? null : category),
      ).length,
    [rules, category],
  );

  return (
    // 제목·설명과 스크롤러는 CrmShell 소유다(P8 Layout Stability) — 여기서
    // 페이지 프레임을 다시 만들지 않는다.
    <div className="mx-auto w-full max-w-5xl space-y-5 p-6">
      <Card className="space-y-4 p-5 shadow-soft-md">
        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor="claim-category"
            className="text-sm font-medium text-foreground"
          >
            상품 카테고리
          </label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger id="claim-category" className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            적용 규칙 {activeRuleCount}건
            {dealClaims.length > 0 ? ` · 딜 표현 ${dealClaims.length}건` : ""}
          </span>
        </div>

        {deals.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor="claim-deal"
              className="text-sm font-medium text-foreground"
            >
              딜 연결
            </label>
            <Select value={dealId} onValueChange={setDealId}>
              <SelectTrigger id="claim-deal" className="w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEAL}>
                  연결 안 함 (공통 사전만)
                </SelectItem>
                {deals.map((deal) => (
                  <SelectItem key={deal.id} value={deal.id}>
                    {deal.brandName ? `[${deal.brandName}] ` : ""}
                    {deal.dealName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              {claimsLoading
                ? "딜 표현 불러오는 중…"
                : dealId === NO_DEAL
                  ? "딜을 고르면 승인 소구점·전용 금지·필수 고지까지 함께 검사합니다"
                  : "승인된 표현만 검사에 반영됩니다"}
            </span>
          </div>
        ) : null}

        {claimsError ? (
          <p className="rounded-md bg-status-urgent-bg px-3 py-2 text-xs text-status-urgent-text">
            {claimsError}. 공통 사전만으로 검사 중입니다.
          </p>
        ) : null}

        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="검사할 문구를 붙여넣으세요. 입력하는 동안 실시간으로 검사합니다."
          className="min-h-40 resize-y text-sm leading-relaxed"
          aria-label="검사할 문구"
        />
      </Card>

      {/*
        실시간 검사를 표방하는 화면이라 판정 변화가 무음이면 스크린리더
        사용자에게는 아무 일도 일어나지 않는다(WCAG 4.1.3 Status Messages).
        결과 영역 자체를 polite 라이브 리전으로 둔다.
      */}
      <div aria-live="polite">
        {result ? (
          <Card className="space-y-4 p-5 shadow-soft-md">
            <div className="flex items-center gap-2">
              {result.verdict === "PASS" ? (
                <>
                  <ShieldCheckIcon
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="text-sm font-medium text-foreground">
                    지적 사항 없음
                  </span>
                </>
              ) : (
                <>
                  {result.verdict === "BLOCK" ? (
                    <OctagonAlertIcon
                      className="size-4 text-status-urgent"
                      aria-hidden
                    />
                  ) : (
                    <TriangleAlertIcon
                      className="size-4 text-status-caution"
                      aria-hidden
                    />
                  )}
                  <span className="text-sm font-medium text-foreground">
                    {/* 개수 단위는 아래 목록과 같은 **표현 종수**다 — 같은 표현이
                        본문 여러 곳에 걸린 것은 행이 "N곳"으로 말한다. */}
                    {result.violations.length > 0 &&
                      `표현 ${violationGroups.length}건`}
                    {result.violations.length > 0 &&
                      result.missingDisclosures.length > 0 &&
                      " · "}
                    {result.missingDisclosures.length > 0 &&
                      `고지 누락 ${result.missingDisclosures.length}건`}
                  </span>
                </>
              )}
            </div>

            {result.violations.length > 0 ? (
              <>
                <p
                  className="whitespace-pre-wrap rounded-md bg-muted/40 p-4 text-sm leading-relaxed"
                  aria-label="검사 결과 본문"
                >
                  {segments.map((segment, index) =>
                    segment.severity ? (
                      <mark
                        key={index}
                        className={cn(
                          "rounded-sm px-0.5 font-medium",
                          SEVERITY_STYLE[segment.severity].mark,
                        )}
                      >
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </p>

                <ul className="space-y-2">
                  {violationGroups.map((violation) => {
                    const style = SEVERITY_STYLE[violation.severity];
                    return (
                      <li
                        key={`${violation.sourceId}-${violation.matched}`}
                        className="flex gap-3 rounded-lg border border-slate-100 p-3"
                      >
                        <span
                          className={cn("w-1 shrink-0 rounded-full", style.bar)}
                          aria-hidden
                        />
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={cn(
                                "rounded-md px-1.5 py-0.5 text-xs font-medium",
                                style.chip,
                              )}
                            >
                              {style.label}
                            </span>
                            <span className="text-sm font-medium text-foreground">
                              “{violation.matched}”
                            </span>
                            {violation.occurrences > 1 ? (
                              <span className="text-xs text-muted-foreground">
                                {violation.occurrences}곳
                              </span>
                            ) : null}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {violation.legalBasis}
                            {violation.note ? ` · ${violation.note}` : ""}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}

            {result.missingDisclosures.length > 0 ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  필수 고지 누락
                </p>
                <ul className="list-inside list-disc text-xs text-muted-foreground">
                  {result.missingDisclosures.map((item) => (
                    <li key={item.id}>{item.text}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {result.verdict === "PASS" ? (
              <p className="text-xs text-muted-foreground">
                등록된 금지 표현과 필수 고지 기준으로는 걸리는 항목이 없습니다.
                사전에 없는 표현까지 보증하지는 않습니다.
              </p>
            ) : null}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
