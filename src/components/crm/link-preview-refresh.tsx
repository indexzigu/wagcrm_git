"use client";

import { useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRelativeSavedAt } from "@/lib/format";
import { buildPreviewRefreshUrl } from "@/lib/short-link";

/**
 * 공유 미리보기 새로고침 — 캐시 우회 링크 복사 + 목적지 OG 재수집.
 *
 * 캠페인 사이드패널 카드와 유입 리포트 상세 시트가 **이 한 벌을 공유한다.** 손으로
 * 다시 만들면 두 표면의 문구·상태가 갈린다(이 레포의 상습 결함).
 *
 * ⚠️ **두 개의 시간축을 한 텍스트로 말하지 않는다.** 복사는 즉시 끝나고 수집은 최대
 * 20초다. 버튼 라벨은 복사 확인만, 캡션 슬롯은 수집 진행·결과만 말한다.
 */

export type LinkPreviewSnapshot = {
  ogTitle?: string | null;
  ogImage?: string | null;
  ogFetchedAt?: string | Date | null;
};

type Phase = "idle" | "running" | "done" | "failed" | "copyFailed";

const CAPTION: Record<Exclude<Phase, "idle">, string> = {
  running: "미리보기를 다시 읽는 중…",
  // ⚠️ "카톡 캐시 우회용" 은 장식이 아니다 — 같은 카드의 `복사` 버튼은 **정본**
  // 단축링크를 복사한다. 두 문구가 같으면 트러블슈팅으로 누른 꼬리 링크를 그대로
  // 셀러 안내에 붙여넣어, 설명할 수 없는 URL 이 영구히 배포된다.
  done: "카톡 캐시 우회용 링크를 복사했습니다 · 미리보기를 새로 읽었습니다",
  failed: "카톡 캐시 우회용 링크를 복사했습니다 · 목적지에서 미리보기를 읽지 못했습니다",
  copyFailed: "링크 복사에 실패했습니다. 브라우저의 클립보드 권한을 확인해 주세요.",
};

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

export function LinkPreviewRefresh({
  code,
  shortUrl,
  preview,
}: {
  code: string;
  shortUrl: string;
  preview: LinkPreviewSnapshot;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [copied, setCopied] = useState(false);
  const [snapshot, setSnapshot] = useState<LinkPreviewSnapshot>(preview);
  const [imageFailed, setImageFailed] = useState(false);
  // 재진입 가드는 `phase` state 가 아니라 ref 로 잡는다 — state 갱신은 클립보드
  // await 뒤(비동기 경계 너머)에야 반영되므로, 클릭 시점부터 그 await 이 끝날
  // 때까지는 phase 도 `disabled` 도 무장되지 않는 창이 생긴다. 그 창에서 Enter
  // 연타나 권한 프롬프트가 뜬 채로의 재클릭이 들어오면 핸들러가 통째로 다시
  // 돌아 클립보드 2회 쓰기 + POST 2회가 난다. ref 는 동기라 그 창을 없앤다.
  const busyRef = useRef(false);

  async function handleRefresh() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      // ⚠️ **복사가 먼저다.** 수집은 최대 20초(5초 × 4홉)라, 순서를 뒤집으면
      // 클립보드가 사용자 제스처 창을 벗어나 브라우저가 거부한다. 이 순서 덕분에
      // 수집이 실패해도 복사는 유효하다 — 캐시 우회는 URL 이 하고, 스냅샷이 비면
      // 리다이렉터가 지금처럼 실시간으로 긁는다.
      try {
        await navigator.clipboard.writeText(buildPreviewRefreshUrl(shortUrl));
      } catch {
        // 복사가 실패했으면 공유할 것이 없다 — 재수집만 돌리면 운영자는 아무것도
        // 손에 쥐지 못한 채 기다린다.
        setPhase("copyFailed");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);

      setPhase("running");
      try {
        const res = await fetch(
          `/api/tracked-links/${encodeURIComponent(code)}/preview-refresh`,
          { method: "POST" },
        );
        const body = (await res.json()) as {
          refreshed?: boolean;
          ogTitle?: string | null;
          ogImage?: string | null;
          ogFetchedAt?: string | null;
        };
        if (res.ok && body.refreshed) {
          setSnapshot({
            ogTitle: body.ogTitle,
            ogImage: body.ogImage,
            ogFetchedAt: body.ogFetchedAt,
          });
          setImageFailed(false);
          setPhase("done");
          return;
        }
        setPhase("failed");
      } catch {
        // 요청 자체의 실패(네트워크·5xx·404)도 수집 실패와 같은 문구로 흡수한다 —
        // 원인이 달라도 운영자가 할 일이 같다(복사된 링크를 그대로 공유). 원인
        // 분해는 화면이 아니라 서버 로그의 몫이다.
        setPhase("failed");
      }
    } finally {
      // 성공·실패·클립보드 거부·예외 등 모든 종료 경로에서 해제한다.
      busyRef.current = false;
    }
  }

  const fetchedIso = toIso(snapshot.ogFetchedAt);

  return (
    <div className="flex items-start gap-3">
      {/* 자리를 항상 예약한다 — 조건부 마운트하면 이미지가 붙는 순간 아래가 밀린다
          (P8 Layout Stability). */}
      <div className="size-10 shrink-0 overflow-hidden rounded-md bg-muted/40">
        {snapshot.ogImage && !imageFailed ? (
          // 브랜드사 원본 URL 이라 호스트가 런타임에 정해진다 — next/image 원격
          // 패턴을 고정할 수 없다(`content-guide-references.tsx` 선례). 제3자
          // 서버 직결이므로 referrer 는 보내지 않는다.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={snapshot.ogImage}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="size-full object-cover"
          />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        {/* 1줄 고정 — line-clamp 로 2줄을 허용하면 제목 길이가 행 높이를 흔든다. */}
        <p className="truncate text-xs text-foreground">
          {snapshot.ogTitle || "미리보기를 아직 읽지 않았습니다"}
        </p>
        {/* 캡션 슬롯 — 타임스탬프·진행 중·결과를 모두 담으므로 가장 크게 변한다.
            자리를 예약해 두지 않으면 누를 때마다 아래가 튄다.

            ⚠️ 예약은 **가장 좁은 표면의 최악 상태**에 맞춘다(`min-h-12` = 3줄).
            이 컴포넌트는 폭이 다른 두 곳에 붙는데 — 캠페인 사이드패널 720px,
            유입 리포트 상세 시트 `sm:max-w-xl`(576px) — 썸네일·버튼을 뺀 텍스트
            열이 각각 약 486px·390px 다. 실패 문구는 본문 한 줄 + 보조 한 줄인데,
            좁은 쪽에서는 본문이 2줄로 접혀 **총 3줄**이 된다. 2줄로 잡으면 그
            표면에서만 아래가 밀린다(P8 Layout Stability). 넓은 쪽에 생기는 여백은
            그 대가다 — 표면별로 값을 가르지 말 것(두 화면이 같은 것을 봐야 한다). */}
        {/* 최대 20초 뒤에야 내용이 바뀌고 그 사이 버튼이 disabled 로 포커스를
            잃으므로, 보조공학이 변화를 알 수 있게 aria-live/aria-busy 를 단다. */}
        <div
          className="min-h-12 pt-0.5 text-[11px] leading-4 text-slate-500"
          aria-live="polite"
          aria-busy={phase === "running"}
        >
          {phase === "idle" ? (
            fetchedIso ? `마지막 수집: ${formatRelativeSavedAt(fetchedIso)}` : null
          ) : (
            <span className="flex items-start gap-1">
              {/* 성공·실패를 색이 아니라 **모양**으로 가른다 — 미리보기 유무는
                  좋고 나쁨이 없는 범주라 색 5개 의미축 밖이다(P8 §4). */}
              {phase === "done" ? (
                <Check className="mt-px size-3 shrink-0" />
              ) : (
                // 감축 모드에서는 회전을 뺀다 — 진행 중임은 옆 캡션 텍스트와 버튼
                // disabled 가 이미 말한다.
                <RefreshCw
                  className={`mt-px size-3 shrink-0 ${phase === "running" ? "motion-safe:animate-spin" : ""}`}
                />
              )}
              <span>
                {CAPTION[phase]}
                {phase === "failed" ? (
                  <span className="block text-slate-500">
                    그대로 공유해도 됩니다. 카톡이 열 때 다시 읽습니다.
                  </span>
                ) : null}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* 주 액션인 `복사`(outline)와 경쟁하지 않게 한 급 아래. 간헐적 수리 도구다. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleRefresh()}
        disabled={phase === "running"}
        className="shrink-0"
      >
        {copied ? <Check className="mr-1 size-3" /> : <RefreshCw className="mr-1 size-3" />}
        {copied ? "복사됨" : "새로고침"}
      </Button>
    </div>
  );
}
