// reference-enrich-proxy — R3 레퍼런스 보강의 부수효과 어댑터(로컬 Proxy Fetch + 썸네일 재호스팅).
// 단건 링크(Reference Inbox) 보강을 위해 무과금 Proxy Fetch(/embed/captioned)를 활용한다.
// 기존 Apify 단건 호출(~$0.002)을 0원으로 절감하는 Phase 3 교체 구현체.

import { proxyFetch } from "@/lib/order-converter/fetch-client";
import { assertPublicHttpUrl } from "@/lib/ssrf-guard";
import {
  extFromContentType,
  isSellerMediaStorageConfigured,
  publicMediaUrl,
  uploadBytes,
} from "@/lib/seller-analysis/seller-media-storage";
import { rapidApiFetch } from "@/lib/rapidapi-keys";
import {
  mapRapidApiUserInfo,
  type InstagramPostMeta,
  type InstagramProfileMeta,
} from "./reference-enrich";

/**
 * 인스타 게시물 1건의 메타(캡션·썸네일 URL·비디오 URL)를 공식 /embed/captioned/ 엔드포인트에서 로컬 파싱한다.
 * 프록시 풀을 활용해 차단을 방지하며 비용은 0원. 실패 시 throw.
 */
export async function fetchInstagramPostMeta(postUrl: string): Promise<InstagramPostMeta | null> {
  // Normalize URL to get the shortcode
  const match = postUrl.match(/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error("Invalid Instagram post URL: " + postUrl);
  const shortcode = match[1];

  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  const res = await proxyFetch(embedUrl, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    // proxyFetch 자체적으로 타임아웃/재시도를 처리하므로 timeout은 적당히
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Instagram embed fetch failed: ${res.status}`);

  const html = await res.text();

  // Extract thumbnail image (EmbeddedMediaImage)
  const thumbMatch = html.match(/class="[^"]*EmbeddedMediaImage[^"]*"[^>]+src="([^"]+)"/);
  const thumbnailUrl = thumbMatch ? thumbMatch[1].replace(/&amp;/g, '&') : null;

  // Extract video URL if present (Phase 1 호환)
  // 릴스의 경우 <video> 태그나 EmbeddedMediaVideo 클래스에 소스가 존재함
  const videoMatch = html.match(/class="[^"]*EmbeddedMediaVideo[^"]*"[^>]+src="([^"]+)"/) || html.match(/<video[^>]+src="([^"]+)"/);
  const videoUrl = videoMatch ? videoMatch[1].replace(/&amp;/g, '&') : null;

  // Extract caption from JSON __additionalData or HTML
  let caption: string | null = null;
  const captionMatch = html.match(/"caption":"([^"]+)"/);
  if (captionMatch) {
    try {
      caption = JSON.parse(`"${captionMatch[1]}"`); // unescape json string
    } catch {
      caption = captionMatch[1];
    }
  }

  // Fallback caption from <div class="Caption">
  if (!caption) {
    const captionHtmlMatch = html.match(/<div class="Caption"[^>]*>([\s\S]*?)<\/div>/);
    if (captionHtmlMatch) {
      caption = captionHtmlMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  // /embed/captioned 에서는 좋아요 수를 쉽게 파싱하기 어렵거나 제공되지 않음
  // Likes는 캡션 자동 메모에 부가 정보로만 쓰이므로 무과금 파싱을 위해 null 반환 허용
  const likes: number | null = null;

  // videoUrl은 파싱만 하고 반환에서 누락돼 있었다(호출부는 as any로 읽어 항상 null 저장) — 반환 포함으로 교정.
  return { caption, thumbnailUrl, videoUrl, likes };
}

/**
 * 인스타 계정 프로필 메타(이름·bio·팔로워·프로필 사진)를 RapidAPI /userinfo로 조회한다.
 * 셀러분석(scraper.ts Tier1/2)과 같은 엔드포인트·키 로테이션을 재사용한다 —
 * 스토리 수집·셀러분석과 쿼터를 공유하므로 호출부(enrich-inbox)는 미보강 항목에만 쓴다.
 * HTTP 실패 시에만 throw(호출부가 failed 집계) — 응답은 왔으나 계정을 못 찾은 경우
 * (삭제·비공개 등)는 username이 null인 메타를 그대로 반환한다. 이 둘은 재시도 시
 * 결과가 달라질 여지(전자)와 달라지지 않는 영구 상태(후자)로 성격이 달라 호출부가
 * 갈라서 판단해야 한다.
 */
export async function fetchInstagramProfileMeta(username: string): Promise<InstagramProfileMeta> {
  const res = await rapidApiFetch(
    `https://instagram-scraper-20251.p.rapidapi.com/userinfo/?username_or_id=${encodeURIComponent(username)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`RapidAPI /userinfo failed: ${res.status}`);
  return mapRapidApiUserInfo(await res.json());
}

// mediaRehost.ts와 동일한 wsrv 파라미터 — 원본 ~300KB를 360px WebP ~16KB로 줄여 저장(실측 1/20).
const RESIZE_PREFIX = "https://wsrv.nl/?w=360&h=360&fit=cover&output=webp&q=75&url=";

const SAFE_PATH_ID = /^[a-zA-Z0-9_-]+$/;

export async function rehostReferenceThumbnail(
  originUrl: string,
  assetId: string,
  entityId: string
): Promise<string | null> {
  if (!SAFE_PATH_ID.test(assetId) || !SAFE_PATH_ID.test(entityId)) {
    throw new Error(
      `저장 경로에 쓸 수 없는 id: entityId=${entityId} assetId=${assetId}`
    );
  }
  if (!isSellerMediaStorageConfigured()) return null;

  assertPublicHttpUrl(originUrl);

  const fetchOpts: RequestInit = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(15_000),
  };

  let res = await fetch(RESIZE_PREFIX + encodeURIComponent(originUrl), fetchOpts).catch(() => null);
  if (!res || !res.ok) {
    res = await fetch(originUrl, fetchOpts);
  }
  if (!res.ok) throw new Error(`썸네일 fetch ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength < 100) throw new Error("응답 바이트 비정상(<100B)");

  const path = `deals/${entityId}/refs/${assetId}.${extFromContentType(contentType)}`;
  await uploadBytes(path, bytes, contentType);
  return publicMediaUrl(path);
}
