"use client";

// InstagramEmbed — 인스타 퍼머링크를 공식 embed.js 카드(영상·릴스 인라인 재생)로 렌더한다(③b).
// 표시 전용(약관 리스크 최소, 조사보고서 §42). CSP 설정 변경 불요(next.config에 CSP 헤더 없음,
// X-Frame-Options: DENY는 우리 페이지가 프레임되는 것만 막지 외부 iframe 삽입엔 무관).
//
// embed.js는 blockquote.instagram-media를 스캔해 iframe으로 "DOM을 교체"한다. React가 그 자식을
// 재조정하면 임베드가 깨지므로, 컨테이너 div 안에 blockquote를 imperative(innerHTML)로 주입하고
// React는 빈 컨테이너만 관리한다. 언마운트 시 컨테이너를 비운다.
import { useEffect, useRef, useState } from "react";
import { toEmbedPermalink } from "@/lib/instagram-embed";

const EMBED_SRC = "https://www.instagram.com/embed.js";

type Instgrm = { Embeds?: { process?: () => void } };
function getInstgrm(): Instgrm | undefined {
  return (window as unknown as { instgrm?: Instgrm }).instgrm;
}

// embed.js는 페이지당 한 번만 로드한다(싱글턴 프로미스). 이미 로드됐으면 즉시 resolve.
let scriptPromise: Promise<void> | null = null;
function loadEmbedScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (getInstgrm()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${EMBED_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("embed.js load failed")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.src = EMBED_SRC;
    script.async = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => {
        scriptPromise = null; // 재시도 가능하도록 실패 시 프로미스 리셋
        reject(new Error("embed.js load failed"));
      },
      { once: true },
    );
    document.body.appendChild(script);
  });
  return scriptPromise;
}

export function InstagramEmbed({ permalink }: { permalink: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // embed.js 스크립트 로드 대기 표시(첫 임베드 1회성 네트워크 비용 구간만 커버 — 스크립트가 이미
  // 로드돼 있으면 프로미스가 즉시 resolve돼 사실상 안 보인다). 실제 iframe 렌더 완료까지는 추적 불가
  // (Embeds.process()는 콜백을 주지 않음) — 과설계 방지, 스크립트 로드까지만 정직하게 커버.
  const [loading, setLoading] = useState(true);
  const embedUrl = toEmbedPermalink(permalink);

  useEffect(() => {
    const el = containerRef.current;
    if (!embedUrl) {
      setFailed(true);
      setLoading(false);
      return;
    }
    if (!el) return;
    setFailed(false);
    setLoading(true);
    // embedUrl은 toEmbedPermalink가 검증·정규화한 IG 퍼머링크(shortcode=[A-Za-z0-9_-]+)라 인젝션 안전.
    el.innerHTML = `<blockquote class="instagram-media" data-instgrm-permalink="${embedUrl}" data-instgrm-version="14" style="margin:0;width:100%;min-width:0;max-width:100%"></blockquote>`;
    let cancelled = false;
    loadEmbedScript()
      .then(() => {
        if (!cancelled) {
          getInstgrm()?.Embeds?.process?.();
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      el.innerHTML = "";
    };
  }, [embedUrl]);

  if (failed) {
    return (
      <p className="text-[11px] text-muted-foreground">
        임베드를 불러오지 못했습니다.{" "}
        <a
          href={embedUrl ?? permalink}
          target="_blank"
          rel="noreferrer"
          className="rounded-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          원본 열기
        </a>
      </p>
    );
  }
  return (
    <>
      {loading ? <p className="text-[11px] text-muted-foreground">불러오는 중...</p> : null}
      <div ref={containerRef} />
    </>
  );
}
