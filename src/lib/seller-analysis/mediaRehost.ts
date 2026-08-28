// 피드 썸네일 재호스팅 (이식 스펙 §8 결정 개정 — 2026-07-06 실측: 인스타 CDN 서명 URL이
// 당일에도 일부 만료 → "URL 참조" 방식은 피드 프리뷰를 수일 내 전멸시킴. 레퍼런스 서비스의
// 관찰된 방식(백그라운드 큐 + 시간차 다운로드 + 자체 스토리지, 최초 계정 10~15분)을 채택).
//
// 원칙:
//  - analyze는 지금처럼 IG URL을 즉시 저장(수집 직후엔 원본 URL이 살아있어 화면 정상) —
//    이 모듈은 크론 sweep에서 뒤늦게 돌며 썸네일을 전용 공개 버킷으로 옮기고 URL을 교체한다.
//  - 다운로드는 시간차(기본 2.5s + jitter)로 — 한번에 몰아 받으면 차단될 수 있다는
//    레퍼런스 관찰 반영. CDN GET이라 민감도는 낮지만 보수적으로.
//  - 실패(만료 403 등)는 항목에 thumbFailed 마킹 후 재시도하지 않음(만료 URL은 영구 소실 —
//    재분석만이 새 URL을 공급). 원본 URL은 유지해 만료 전까지는 계속 뜨게 둔다.
//  - 산출물 내부용 한정 원칙(스펙 §4-1) 하의 공개 게시물 썸네일 사본 — 저장 경로는
//    sellers/{sellerId}/{shortcode}.{ext}. 키는 게시물 신원(shortcode)이어야 한다 —
//    과거 배열 인덱스 키(sellers/{sellerId}/{idx})는 일간 수집의 인덱스 드리프트마다 같은
//    URL이 다른 게시물 이미지로 덮여, 등록(Asset) 복사본 다수가 오염된 실사고(2026-07-16).
//    레거시 idx 파일은 더 이상 쓰지 않고 방치한다(백필 스크립트가 참조를 이관).

import type { PrismaClient } from "@prisma/client";
import type { PostPreview } from "./types";
import { shortcodeFromPermalink } from "./graphScraper";
import { assertPublicHttpUrl } from "@/lib/ssrf-guard";
import {
  extFromContentType,
  isRehostedUrl,
  isSellerMediaStorageConfigured,
  publicMediaUrl,
  uploadBytes,
} from "@/lib/seller-analysis/seller-media-storage";

// 셀러당 보존 썸네일 수 — 피드 프리뷰 목적("최근 뭐 올라오나")엔 12장이면 충분.
// 저장 비용이 개수에 비례하므로 캡(2026-07-06 사용자 결정: 수집 30·보존 12).
const REHOST_MAX_PER_SELLER = Number(process.env.SELLER_MEDIA_MAX_PER_SELLER ?? 12);

// 인제스트 리사이즈 프록시(wsrv.nl) — 원본 ~300KB를 360px WebP ~16KB로 줄여 저장(실측 1/20).
// 프록시는 "다운로드 시점 변환"에만 쓰고 보존은 우리 버킷(프록시 캐시는 아카이브가 아님).
// 프록시 실패 시 원본 직접 다운로드로 폴백(원본 크기 그대로 저장 — 가용성 우선).
const RESIZE_PREFIX = "https://wsrv.nl/?w=360&h=360&fit=cover&output=webp&q=75&url=";

// 저수준 스토리지 원시함수는 seller-media-storage로 통일(프로필 사진 미러링과 공유).
// 라우트가 소비하는 기존 이름은 유지한다.
export const isMediaRehostConfigured = isSellerMediaStorageConfigured;
export { publicMediaUrl };

type PreviewItem = PostPreview & { thumbFailed?: boolean };

/**
 * 게시물 썸네일의 안정 저장 파일명(확장자 제외) = IG shortcode. permalink가 없거나
 * shortcode를 못 뽑으면 null — 그 항목은 재호스팅 대상에서 제외한다(신원 키 없이 저장하면
 * 위치 키로 돌아가는 셈이라 금지).
 */
export function postThumbBasename(permalink: unknown): string | null {
  return shortcodeFromPermalink(permalink);
}

/**
 * thumb이 "이 permalink 게시물의" 안정(shortcode 키) 재호스팅 URL인지 판별한다.
 * 레거시 인덱스 키(sellers/{sid}/{idx}.{ext})는 basename이 숫자라 shortcode와 불일치 → false.
 * mergePostsPreview가 fresh(fbcdn)로 리셋하지 않고 보존할 수 있는 유일한 형태다 —
 * isRehostedUrl만으로 보존하면 레거시 오염 URL까지 보존되므로 반드시 이 판정을 쓴다.
 */
export function isStablePostThumb(thumb: unknown, permalink: unknown): boolean {
  if (typeof thumb !== "string" || !isRehostedUrl(thumb)) return false;
  const shortcode = postThumbBasename(permalink);
  if (!shortcode) return false;
  const basename = thumb.split("/").pop() ?? "";
  return basename.startsWith(`${shortcode}.`);
}

/**
 * 보존 대상 인덱스 선택 — taken_at 최신순 상위 REHOST_MAX_PER_SELLER개.
 * 캡 밖 항목은 재호스팅하지 않으며 pending에도 세지 않는다(원본 URL로 표시되다 만료 시 placeholder).
 * shortcode(=저장 키)를 못 뽑는 항목도 제외한다.
 */
function selectRehostTargets(posts: PreviewItem[]): number[] {
  return posts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p && typeof p.thumb === "string" && p.thumb && postThumbBasename(p.permalink))
    .sort((a, b) => {
      const ta = a.p.taken_at ? Date.parse(a.p.taken_at) : 0;
      const tb = b.p.taken_at ? Date.parse(b.p.taken_at) : 0;
      return tb - ta || a.i - b.i; // 최신순, 동률·시각없음은 수집 순서
    })
    .slice(0, REHOST_MAX_PER_SELLER)
    .map(({ i }) => i);
}

/** 재호스팅 대기 중인 썸네일 수 (크론이 처리 대상 셀러를 고르는 기준 — 보존 캡 적용) */
export function countPendingThumbs(aiTags: unknown): number {
  if (!aiTags || typeof aiTags !== "object") return 0;
  const posts = (aiTags as Record<string, unknown>).postsPreview;
  if (!Array.isArray(posts)) return 0;
  const items = posts as PreviewItem[];
  return selectRehostTargets(items).filter((i) => {
    const p = items[i];
    return !isRehostedUrl(p.thumb) && !p.thumbFailed;
  }).length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RehostOptions {
  /** 다운로드 간 기본 간격(ms). 기본 2500 — 레퍼런스식 시간차 */
  spacingMs?: number;
  /** 간격에 더해지는 랜덤 지터 상한(ms). 기본 2000 */
  jitterMs?: number;
  /** 이 시각(epoch ms)을 넘기면 남은 항목을 다음 sweep으로 미루고 중단 */
  deadlineMs?: number;
  /** 이번 호출에서 처리할 최대 항목 수 (테스트/분할용) */
  maxItems?: number;
}

export interface RehostResult {
  sellerId: string;
  attempted: number;
  ok: number;
  failed: number;
  /** 이번 호출 후에도 남은 대기 항목 (deadline/maxItems로 미룬 것) */
  pending: number;
  done: boolean;
  skipped?: string;
}

/**
 * 한 셀러의 postsPreview 썸네일을 시간차 다운로드 → 공개 버킷 업로드 → URL 교체.
 * 동시성 가드: 읽은 시점의 updatedAt 으로 조건부 update — 그 사이 재분석이 덮었으면
 * 이번 결과를 버린다(새 postsPreview가 다음 sweep에서 처리됨. 오래된 프리뷰로 덮어쓰기 방지).
 */
export async function rehostSellerMedia(
  prisma: PrismaClient,
  sellerId: string,
  opts: RehostOptions = {}
): Promise<RehostResult> {
  const spacingMs = opts.spacingMs ?? 2500;
  const jitterMs = opts.jitterMs ?? 2000;

  const base: RehostResult = { sellerId, attempted: 0, ok: 0, failed: 0, pending: 0, done: false };
  if (!isMediaRehostConfigured()) return { ...base, skipped: "storage env 미설정" };

  const profile = await prisma.sellerAiProfile.findUnique({
    where: { sellerId },
    select: { aiTags: true, updatedAt: true },
  });
  if (!profile || !profile.aiTags || typeof profile.aiTags !== "object") {
    return { ...base, skipped: "aiTags 없음" };
  }
  const tags = profile.aiTags as Record<string, unknown>;
  const posts = Array.isArray(tags.postsPreview) ? ([...tags.postsPreview] as PreviewItem[]) : [];
  // 보존 캡(최근 12장) 안에서만 재호스팅 — 나머지는 원본 URL 유지(만료 시 placeholder)
  const pendingIdx = selectRehostTargets(posts).filter((i) => {
    const p = posts[i];
    return !isRehostedUrl(p.thumb) && !p.thumbFailed;
  });

  if (pendingIdx.length === 0) {
    return { ...base, done: true, skipped: "대기 항목 없음" };
  }

  const targets = typeof opts.maxItems === "number" ? pendingIdx.slice(0, opts.maxItems) : pendingIdx;
  let processed = 0;
  for (const idx of targets) {
    if (opts.deadlineMs && Date.now() >= opts.deadlineMs) break;
    const item = { ...posts[idx] };
    base.attempted++;
    try {
      const originUrl = item.thumb as string;
      // SSRF 방어 — 비http 스킴·사설/내부 IP면 throw → 아래 catch가 thumbFailed 마킹(기존 실패 경로)
      assertPublicHttpUrl(originUrl);
      const fetchOpts: RequestInit = {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(15_000),
      };
      // 1차: wsrv 리사이즈 경유(360px WebP ~16KB — 실측 원본의 1/20). 실패 시 원본 직접 폴백.
      let res = await fetch(RESIZE_PREFIX + encodeURIComponent(originUrl), fetchOpts).catch(() => null);
      if (!res || !res.ok) {
        res = await fetch(originUrl, fetchOpts);
      }
      if (!res.ok) throw new Error(`원본 fetch ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength < 100) throw new Error("응답 바이트 비정상(<100B)");
      // 신원 키 저장 — selectRehostTargets가 basename 보유를 보장하지만 방어적으로 재확인.
      const basename = postThumbBasename(item.permalink);
      if (!basename) throw new Error("permalink에서 shortcode 파싱 불가");
      const path = `sellers/${sellerId}/${basename}.${extFromContentType(contentType)}`;
      await uploadBytes(path, bytes, contentType);
      item.thumb = publicMediaUrl(path);
      base.ok++;
    } catch (e) {
      // 만료(403)·타임아웃 등 — 재시도 무의미(만료 URL은 영구 소실), 마킹 후 원본 유지
      item.thumbFailed = true;
      base.failed++;
      console.warn(`[mediaRehost] ${sellerId}#${idx} 실패:`, e instanceof Error ? e.message : e);
    }
    posts[idx] = item;
    processed++;
    if (processed < targets.length) {
      await sleep(spacingMs + Math.floor(Math.random() * jitterMs));
    }
  }

  const remaining = selectRehostTargets(posts).filter((i) => {
    const p = posts[i];
    return !isRehostedUrl(p.thumb) && !p.thumbFailed;
  }).length;
  base.pending = remaining;
  base.done = remaining === 0;

  const nextTags = {
    ...tags,
    postsPreview: posts,
    mediaRehost: {
      ok: base.ok,
      failed: base.failed,
      pending: remaining,
      done: base.done,
      at: new Date().toISOString(),
    },
  };
  // 조건부 update: 읽은 후 재분석이 upsert했다면(updatedAt 변경) 이번 결과 폐기
  const updated = await prisma.sellerAiProfile.updateMany({
    where: { sellerId, updatedAt: profile.updatedAt },
    data: { aiTags: nextTags as object },
  });
  if (updated.count === 0) {
    return { ...base, skipped: "재분석과 경합: 결과 폐기(다음 sweep에서 재처리)" };
  }
  return base;
}
