"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { hasConfirmedTargetLink, isPlaceholderTargetUrl } from "@/lib/campaign-link-surface";
import { patchCampaign } from "@/lib/campaign-patch";
import type { CampaignRow } from "@/lib/crm-types";
import { LinkPreviewRefresh, type LinkPreviewSnapshot } from "./link-preview-refresh";

/**
 * 셀러에게 배포할 `go.ygrd.kr` 단축링크 — 발급·복사·클릭 지표.
 *
 * 리다이렉트는 이 앱이 아니라 Cloudflare Worker(`ygrd-link/`)가 처리한다. 여기서는
 * 링크를 만들고 쌓인 클릭을 읽기만 한다.
 *
 * 지표는 **총 클릭·방문 연인원 둘뿐이다**(오너 확정 2026-07-31). 연인원인 이유는
 * `visitorHash` 에 KST 날짜가 섞여 있어 dedup 이 하루 안에서만 성립하기 때문이다. 채널·콘텐츠별 분해는
 * 캠페인 초반에 거의 비어 있고 사이드패널은 이미 정보량이 많아, P2 Decision-Value
 * Priority 에 따라 판단 가치가 확실한 두 숫자만 남긴다.
 */

type TrackedLinkRow = LinkPreviewSnapshot & {
  code: string;
  shortUrl: string;
  clickCount: number;
  visitDays: number;
};

type LoadState = "loading" | "ready" | "error";

export function CampaignShortLinkCard({
  campaign,
  channelUnassigned,
  onCampaignUpdated,
}: {
  campaign: CampaignRow;
  channelUnassigned: boolean;
  /** 목적지 저장 후 패널 상태를 미확정 → 확정으로 다시 그리게 한다. */
  onCampaignUpdated: (updated: CampaignRow) => void;
}) {
  const [link, setLink] = useState<TrackedLinkRow | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [isIssuing, setIsIssuing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const campaignId = campaign.id;
  // 목적지가 없으면 발급이 서버에서 실패한다. 눌러서 에러를 보기 전에 화면이 먼저
  // "미확정"을 말한다 (P2 Unconfirmed Link Guard).
  const hasTarget = hasConfirmedTargetLink(campaign);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`/api/tracked-links?campaignId=${encodeURIComponent(campaignId)}`);
      if (!res.ok) throw new Error("조회 실패");
      const rows = (await res.json()) as TrackedLinkRow[];
      setLink(rows[0] ?? null);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleIssue() {
    setIsIssuing(true);
    try {
      const res = await fetch("/api/tracked-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }),
      });
      const body = (await res.json()) as TrackedLinkRow & { error?: unknown };
      if (!res.ok) {
        toast.error(typeof body.error === "string" ? body.error : "단축링크 발급에 실패했습니다");
        return;
      }
      setLink({ ...body, clickCount: 0, visitDays: 0 });
      toast.success("단축링크를 발급했습니다");
    } catch {
      toast.error("단축링크 발급 중 네트워크 오류가 발생했습니다");
    } finally {
      setIsIssuing(false);
    }
  }

  async function handleCopy() {
    if (!link) return;
    await navigator.clipboard.writeText(link.shortUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  /**
   * 입력값을 검증한다. 통과하면 정규화된 URL, 아니면 null(오류는 화면에 남는다).
   *
   * 실패 모드를 뭉치지 않는다 — "스킴이 없다"와 "상품을 안 가리킨다"는 운영자가 할 일이
   * 다르다. `isPlaceholderTargetUrl` 은 파싱 실패도 true 로 돌려주므로 그것 하나만 쓰면
   * 경로가 멀쩡한 `brand.example.com/p/1` 에도 "도메인만 넣었다"는 엉뚱한 문구가 뜬다.
   */
  function validateTarget(): string | null {
    const trimmed = targetInput.trim();
    if (trimmed === "") {
      setInputError("상품 페이지 주소를 입력해 주세요");
      return null;
    }

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      setInputError("유효한 URL 형식이 아닙니다 (https:// 로 시작해야 합니다)");
      return null;
    }
    // 발급 시점에도 서버가 막지만(`assertHttpUrl`), 그 전에 캠페인 목적지로 저장되는 것을
    // 막는다 — 저장만 되고 발급은 거절되는 상태로 남으면 원인이 화면에 보이지 않는다.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      setInputError("http/https 주소만 등록할 수 있습니다");
      return null;
    }
    if (isPlaceholderTargetUrl(trimmed)) {
      setInputError(
        "상품 페이지 주소가 아닙니다. 도메인만 저장하면 팔로워가 상품이 아닌 스토어 홈으로 갑니다.",
      );
      return null;
    }

    setInputError(null);
    return trimmed;
  }

  /**
   * 저장과 발급을 한 버튼으로 묶는다 — 운영자 왕복을 1회로 유지한다.
   *
   * 저장 성공 토스트는 두지 않는다(P2 Toast Ownership) — 이 액션의 성공 토스트는
   * `handleIssue` 의 발급 토스트 하나가 소유한다.
   */
  async function handleSaveAndIssue() {
    // 가드는 버튼의 `disabled` 가 아니라 **여기**가 소유한다 — Enter 키 경로가 그
    // 가드를 우회해 동시 실행되면 발급 요청이 겹치고, 서버의 멱등 확인은
    // findFirst → create 라 트랜잭션 없이 경합해 캠페인에 링크가 2행 생긴다.
    if (isSaving || isIssuing) return;

    const target = validateTarget();
    if (target === null) return;

    setIsSaving(true);
    try {
      // ⚠️ preferServerError 를 켜지 않는다 — 이 라우트의 오류 본문은 영문이고
      // zod 실패 시엔 문자열도 아니다(`campaign-patch.ts` 의 옵션 주석).
      const result = await patchCampaign<CampaignRow>(
        campaign.id,
        { baseNaverLink: target },
        { fallbackError: "링크 저장에 실패했습니다" },
      );
      if (!result.ok) {
        setInputError(result.error);
        return;
      }
      if (result.data) onCampaignUpdated(result.data);
      // 저장이 커밋된 뒤에 발급한다 — 서버가 DB 에서 목적지를 다시 읽으므로
      // 순서가 뒤집히면 옛 목적지로 발급된다.
      await handleIssue();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex items-center gap-2">
        <Link2 className="mr-2 size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">셀러 배포용 링크</h3>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        팔로워가 누르면 클릭을 기록한 뒤 상품 페이지로 넘깁니다. 브랜드사 스토어 설정은
        필요하지 않습니다.
      </p>

      {channelUnassigned && (
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-[11px] leading-5 text-slate-600">
          판매채널이 미지정이라 이 링크를 기본으로 보여주고 있습니다. 채널을 지정하면 맞는
          링크 방식이 자동으로 선택됩니다.
        </p>
      )}

      <div className="space-y-3 border-t border-slate-100 pt-3">
        {state === "loading" ? (
          // 스켈레톤은 최종 레이아웃의 모양을 따른다 (URL 줄 + 지표 2칸).
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            {/* 높이를 Metric 실측(라벨 11px + 숫자 2xl + py-2)에 맞춘다 — 짧으면
                로딩이 끝나는 순간 카드 하단이 아래로 튄다. */}
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-[60px]" />
              <Skeleton className="h-[60px]" />
            </div>
          </div>
        ) : state === "error" ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">링크 정보를 불러오지 못했습니다.</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              다시 시도
            </Button>
          </div>
        ) : link ? (
          <>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs text-slate-600">
                {link.shortUrl}
              </code>
              <Button variant="outline" size="sm" onClick={() => void handleCopy()} className="shrink-0">
                <Copy className="mr-1 size-3" />
                {copied ? "복사됨" : "복사"}
              </Button>
            </div>

            {/* 링크 자체에 관한 정보라 링크 바로 아래에 붙고, 판단 지표(클릭·연인원)
                보다 앞선다. 상시 판단이 아니라 간헐적 수리 도구이므로 ghost 급이다. */}
            {/* key: 링크가 바뀌면 내부 snapshot state 를 새로 시작해야 한다 — prop
                은 마운트 시 1회만 소비되므로 없으면 이전 링크의 제목·썸네일이 남는다. */}
            <LinkPreviewRefresh key={link.code} code={link.code} shortUrl={link.shortUrl} preview={link} />

            {/* 지표 2개 — 판단축이 아니라 사실이므로 무채색이다 (P8 §4 범주는 색을 받지 않는다) */}
            <div className="grid grid-cols-2 gap-3">
              <Metric label="총 클릭" value={link.clickCount} unit="회" />
              <Metric label="방문 연인원" value={link.visitDays} unit="명" />
            </div>

            <p className="text-[11px] leading-5 text-slate-500">
              콘텐츠별로 나눠 보려면 링크 뒤에 <code className="font-mono">?s=story1</code> 처럼
              붙여 안내하세요. 안 붙여도 집계에는 문제가 없습니다.
            </p>
          </>
        ) : hasTarget ? (
          <div className="flex flex-col gap-3 rounded-lg border border-dashed bg-slate-50/50 p-4 text-center">
            <span className="text-xs text-slate-500">아직 발급된 링크가 없습니다.</span>
            <Button size="sm" onClick={() => void handleIssue()} disabled={isIssuing}>
              {isIssuing ? "발급중" : "단축링크 발급"}
            </Button>
          </div>
        ) : (
          // 입력행은 안내 박스 **밖**에 둔다 — dashed + 뮤트 배경은 "볼 것 없음" 신호라
          // 이 화면에서 유일하게 판단 가치가 있는 행동 지점을 그 안에 넣으면 위계가
          // 뒤집힌다(P2 Decision-Value Priority). 보더 박스 중첩도 함께 사라진다.
          <div className="space-y-3">
            <div className="space-y-1 rounded-lg border border-dashed bg-slate-50/50 p-3">
              <p className="text-xs font-medium text-slate-600">상품 링크 미확정</p>
              <p className="text-[11px] leading-relaxed text-slate-500">
                브랜드사에게 받은 <strong className="font-medium">상품 페이지</strong> 주소를
                붙여넣으면 바로 단축링크를 발급합니다. 도메인 주소만 저장하면 팔로워가 상품이
                아닌 스토어 홈으로 갑니다.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="url"
                aria-label="상품 페이지 주소"
                aria-invalid={inputError ? true : undefined}
                value={targetInput}
                onChange={(e) => {
                  setTargetInput(e.target.value);
                  setInputError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveAndIssue();
                }}
                placeholder="https://브랜드사스토어/상품페이지"
                // 검증 오류는 `aria-invalid` 가 지고 포커스 링은 중립 토큰을 유지한다
                // (P8 Focus Ring Standard — 두 상태를 한 캐리어에 이중 인코딩하지 않는다).
                className="h-8 flex-1 rounded-md border border-border bg-background px-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-focus-ring aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/40"
              />
              <Button
                size="sm"
                onClick={() => void handleSaveAndIssue()}
                disabled={isSaving || isIssuing}
                className="shrink-0"
              >
                {/* 저장과 발급 두 단계를 한 버튼이 덮으므로 라벨은 중립어다 —
                    저장 왕복 중에 "발급중"을 보여주면 저장 실패 시 앞뒤가 안 맞는다. */}
                {isSaving || isIssuing ? "처리중" : "저장하고 발급"}
              </Button>
            </div>
            {/* 오류 줄은 자리를 예약한다 — 마운트/언마운트로 아래 콘텐츠가 밀리지 않게
                (P8 Layout Stability). */}
            <p className="min-h-4 text-xs text-destructive">{inputError}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** 숫자와 단위를 2:1 크기로 — 값이 먼저 읽히고 단위가 따라붙게 한다. */
function Metric({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-foreground">
        <span className="text-2xl font-semibold tabular-nums">{value.toLocaleString("ko-KR")}</span>
        <span className="ml-1 text-xs text-muted-foreground">{unit}</span>
      </p>
    </div>
  );
}
