// 셀러 스토리 스냅샷 수집 (2026-07-10 오너 지시) — 행사 기간 중 셀러의 **모든** 스토리를
// 매일 자정 수집한다. 멘션/태그 여부와 무관하게 전량 캡처하고, 우리 캠페인 홍보인지는
// 나중에 썸네일을 보고 분류한다(/admin/stories에서 사람이, 추후 LLM 배치 가능).
//
// 소스: 무료 익명 스토리 뷰어(storiesig.info 계열)를 실제 브라우저로 조작해 받아온다
// (story-viewer-fetch.ts). **유료 API키·계정·쿠키 전부 없음**(오너 지시: 외부 API키 의존
// 최소화 — Apify·RapidAPI 다 배제). 뷰어 응답은 인스타 표준 미디어 포맷(pk·taken_at·
// image_versions2.candidates·video_versions·user.username)이라 parseStoryItems 가
// 정규화한다. 뷰어마다 필드명이 다를 수 있어 방어적으로 픽. 비공개 계정은 수집 불가(한계).
//
// 썸네일은 24시간 내 만료되는 CDN URL이므로 전용 버킷(seller-media)으로 즉시 리호스팅한다.
// 영상 원본은 용량상 리호스팅하지 않는다 — ponytail: 분류·증빙은 썸네일로 충분, 필요해지면
// rehost-seller-media 패턴대로 확장.
import type { PrismaClient } from "@prisma/client";
import { fetchStoriesForHandles } from "@/lib/story-viewer-fetch";
import {
  extFromContentType,
  isSellerMediaStorageConfigured,
  publicMediaUrl,
  uploadBytes,
} from "@/lib/seller-analysis/seller-media-storage";
import { assertPublicHttpUrl } from "@/lib/ssrf-guard";

/** 행사 시작 며칠 전부터 수집할지 — 공구 사전 홍보 스토리가 시작 직전에 가장 활발하다.
 *  추천 피드(campaign-suggested-posts.leadDays)와 통일(시작 −7일, 오너 2026-07-11). */
export const STORY_CAPTURE_PREROLL_DAYS = 7;

/** 행사 종료 며칠 후까지 수집할지 — 마감 직후 후기·마감 임박 스토리 포착.
 *  추천 피드(campaign-suggested-posts.trailDays)와 통일(마감 +1일). */
export const STORY_CAPTURE_TRAIL_DAYS = 1;

/** 스토리 수명 — 인스타 스토리는 게시 24시간 후 소멸. 뷰어가 expiring_at 을 안 주면 이걸로 계산. */
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

/** fbcdn 이미지 다운로드용 UA — 없으면 fbcdn 이 연결을 거부한다(2026-07-10 실측) */
const STORY_IMAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// 리사이즈 프록시(wsrv.nl) — mediaRehost.ts와 동일 패턴. fbcdn 지역 엣지(iev 등)가 특정
// 네트워크에서 도달 불가한 문제를 프록시 서버가 대신 받아 우회하고, 원본을 360px WebP로
// 축소해 저장한다(실측 ~18KB). 스토리는 세로형이라 폭만 고정하고 높이는 비율 유지.
const STORY_RESIZE_PREFIX = "https://wsrv.nl/?w=360&output=webp&q=80&url=";

/**
 * 스토리 썸네일 확보 — 1차 wsrv 리사이즈 프록시(도달성·축소), 실패 시 원본 직접(UA 필수).
 * 둘 다 실패하면 null 반환(호출부가 원본 URL만 보존하고 계속 진행).
 */
async function fetchStoryThumb(imageUrl: string): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const viaProxy = STORY_RESIZE_PREFIX + encodeURIComponent(imageUrl);
  const proxied = await fetch(viaProxy, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (proxied?.ok) {
    return { bytes: await proxied.arrayBuffer(), contentType: proxied.headers.get("content-type") || "image/webp" };
  }
  const direct = await fetch(imageUrl, {
    headers: { "User-Agent": STORY_IMAGE_UA },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (direct?.ok) {
    return { bytes: await direct.arrayBuffer(), contentType: direct.headers.get("content-type") || "image/jpeg" };
  }
  return null;
}

export type ParsedStory = {
  username: string;
  storyPk: string;
  takenAtMs: number;
  expiringAtMs: number | null;
  mediaType: number; // 1=사진 2=영상
  imageUrl: string | null;
  videoUrl: string | null;
  caption: string | null;
};

/** 이미지 썸네일 URL — provider별 필드명(thumbnail_url · image_versions.items · image_versions2.candidates)을 순서대로 시도 */
function pickImageUrl(it: Record<string, any>): string | null {
  if (typeof it.thumbnail_url === "string" && it.thumbnail_url) return it.thumbnail_url;
  const itemsUrl = it.image_versions?.items?.[0]?.url; // RapidAPI instagram-scraper-20251
  if (typeof itemsUrl === "string" && itemsUrl) return itemsUrl;
  const candUrl = it.image_versions2?.candidates?.[0]?.url; // 인스타 표준/타 provider
  if (typeof candUrl === "string" && candUrl) return candUrl;
  return null;
}

/** 영상 원본 URL — video_versions[0].url 우선, 폴백 video_url */
function pickVideoUrl(it: Record<string, any>): string | null {
  const vv = it.video_versions;
  if (Array.isArray(vv) && typeof vv[0]?.url === "string" && vv[0].url) return vv[0].url;
  if (typeof it.video_url === "string" && it.video_url) return it.video_url;
  return null;
}

/**
 * 스토리 항목 배열(RapidAPI data.items 또는 유사 포맷) → 정규화. provider마다 식별자·미디어
 * 필드명이 달라(pk vs id, image_versions vs image_versions2 등) 방어적으로 픽한다. 최소
 * 식별자(pk/id · username)나 taken_at 이 없을 때만 제외 — 나머지 필드 결손은 null 로 보존.
 */
export function parseStoryItems(raw: unknown): ParsedStory[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedStory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, any>;
    const username = it.user?.username ? String(it.user.username) : it.owner?.username ? String(it.owner.username) : null;
    const storyPk =
      it.pk != null ? String(it.pk) : it.id != null ? String(it.id) : it.fbid != null ? String(it.fbid) : null;
    if (!username || !storyPk) continue;

    const takenAt = Number(it.taken_at);
    if (!Number.isFinite(takenAt) || takenAt <= 0) continue;
    const takenAtMs = takenAt * 1000;
    const expiring = Number(it.expiring_at);

    const captionRaw = it.caption;
    const caption =
      typeof captionRaw === "string"
        ? captionRaw
        : captionRaw && typeof captionRaw === "object" && captionRaw.text
          ? String(captionRaw.text)
          : null;

    const videoUrl = pickVideoUrl(it);
    // media_type 을 안 주는 뷰어(storiesig)가 있어 video_versions 유무로 영상 판정
    const mediaType = Number(it.media_type) === 2 || videoUrl ? 2 : 1;

    out.push({
      username,
      storyPk,
      takenAtMs,
      // expiring_at 미제공 시 게시 24h 후로 계산(스토리 수명 고정)
      expiringAtMs: Number.isFinite(expiring) && expiring > 0 ? expiring * 1000 : takenAtMs + STORY_TTL_MS,
      mediaType,
      imageUrl: pickImageUrl(it),
      videoUrl,
      caption,
    });
  }
  return out;
}

/** 지금 수집 대상인 캠페인 날짜창인지 — 시작 preroll일 전 ~ 종료 trail일 후 */
export function isWithinCaptureWindow(
  startDate: Date,
  endDate: Date,
  now: Date,
  prerollDays = STORY_CAPTURE_PREROLL_DAYS,
  trailDays = STORY_CAPTURE_TRAIL_DAYS,
): boolean {
  const from = startDate.getTime() - prerollDays * 24 * 60 * 60 * 1000;
  const to = endDate.getTime() + trailDays * 24 * 60 * 60 * 1000;
  return now.getTime() >= from && now.getTime() <= to;
}

/** 인스타 핸들 정규화 — @ 제거·소문자(뷰어 입력·매칭 키 공용) */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

/**
 * 오늘(KST) 자정을 UTC Date로 — 일일 수집 중복 방지 게이트의 하한.
 * capturedAt >= startOfKstDay(now) 이면 "오늘 이미 수집됨"으로 본다. 스토리는 24h 휘발이라
 * 하루 1회 캡처면 그날 스토리는 이미 잡힌 것과 사실상 동치(오너 2026-07-13, 뷰어 조작 비용 절감).
 */
export function startOfKstDay(now: Date): Date {
  const KST = 9 * 60 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const kstMidnight = Math.floor((now.getTime() + KST) / DAY) * DAY;
  return new Date(kstMidnight - KST);
}

export type StoryCaptureResult = {
  activeSellers: number;
  handles: string[];
  storiesSeen: number;
  storiesNew: number;
  thumbnailsRehosted: number;
  /** 오늘(KST) 이미 수집돼 뷰어 조작을 건너뛴 셀러 수(일일 중복 방지 게이트). 선택 필드. */
  handlesSkipped?: number;
  /**
   * 뷰어 조회 자체가 실패한 핸들 수. **"산출 0"과 "전량 실패"를 가르는 유일한 신호**다 —
   * 셀러가 그날 스토리를 안 올리면 조회는 성공하고 `storiesSeen`만 0이므로, 산출량만 보면
   * 정상과 장애를 구분할 수 없다(오탐하면 매일 빨강이 되어 신호를 잃는다).
   */
  handlesFailed: number;
  errors: string[];
};

/**
 * 이번 실행이 **통째로 헛돌았는가**를 선언한다 — 크론 라우트와 로컬 러너가 공유하는 SSOT.
 *
 * ⚠️ **"산출 0"을 기준으로 삼지 않는다.** 셀러가 그날 스토리를 안 올리면 조회는 성공하고
 * `storiesSeen` 만 0이므로, 산출량으로 판정하면 정상까지 빨강이 되어 습관화로 신호를 잃는다.
 * 반대로 이 선언이 없으면 전량 실패가 200 SUCCESS 로 묻힌다(2026-07-13~22 실사고: 11일간
 * 매일 SUCCESS 를 남기며 수집 0건).
 *
 * ⛔ 개별 항목 실패(썸네일 1건 등)를 승격하지 않는 것이 설계의 핵심이다 — 되돌리지 말 것.
 *
 * 두 실행 경로가 각자 이 판정을 복사하면 갈라진다(서버는 빨강인데 로컬은 초록 같은 상태).
 * 그래서 함수 하나로 두고 라우트·러너가 같이 부른다.
 */
export function declareStoryCaptureOutcome(result: StoryCaptureResult): {
  failed: boolean;
  failureReason?: string;
} {
  const attempted = result.handles.length;
  // 수집창에 셀러가 없으면 액터 호출 없이 무비용 종료 — 정상이다(attempted 0 = 실패 아님).
  const totalFailure = attempted > 0 && result.handlesFailed === attempted;
  return totalFailure
    ? { failed: true, failureReason: `대상 ${attempted}명 전원 스토리 조회 실패(수집 0건)` }
    : { failed: false };
}

export type CaptureWindowSeller = {
  id: string;
  name: string;
  alias: string | null;
  snsHandle: string;
  /** normalizeHandle 적용값 — 뷰어 입력·매칭 키 */
  handle: string;
};

/**
 * 지금 수집창(시작 preroll일 전 ~ 종료 trail일 후) 안 캠페인을 가진 인스타 셀러 목록 — 셀러 id로
 * dedup. 크론/수동 수집의 대상 산정과 /admin/stories 일괄 수집 버튼의 대상 표시가 공유하는 SSOT.
 */
export async function listCaptureWindowSellers(
  prisma: PrismaClient,
  now = new Date(),
): Promise<CaptureWindowSeller[]> {
  // DB에서는 느슨하게 거르고 정확한 창은 JS에서 판정(기존 captureActiveCampaignStories 동작 보존).
  const prerollMs = STORY_CAPTURE_PREROLL_DAYS * 24 * 60 * 60 * 1000;
  const trailMs = STORY_CAPTURE_TRAIL_DAYS * 24 * 60 * 60 * 1000;
  const campaigns = await prisma.salesCampaign.findMany({
    where: {
      startDate: { lte: new Date(now.getTime() + prerollMs) },
      endDate: { gte: new Date(now.getTime() - trailMs) },
    },
    select: {
      startDate: true,
      endDate: true,
      seller: { select: { id: true, name: true, alias: true, snsType: true, snsHandle: true } },
    },
  });

  const byId = new Map<string, CaptureWindowSeller>();
  for (const c of campaigns) {
    if (!isWithinCaptureWindow(c.startDate, c.endDate, now)) continue;
    const s = c.seller;
    // snsType 은 데이터상 "INSTAGRAM"(대문자) — 대소문자 무시 비교
    if (!s || String(s.snsType).toLowerCase() !== "instagram" || !s.snsHandle) continue;
    const handle = normalizeHandle(s.snsHandle);
    if (!handle || byId.has(s.id)) continue;
    byId.set(s.id, { id: s.id, name: s.name, alias: s.alias, snsHandle: s.snsHandle, handle });
  }
  return [...byId.values()];
}

/**
 * 파싱된 스토리들을 한 셀러에 저장한다 — 멱등 dedup + 썸네일 리호스팅 + insert.
 * 브라우저 크론과 ingest 엔드포인트(수동 러너·북마클릿)가 공유하는 저장 코어. result 카운터를
 * 누적 갱신한다. 리호스팅 실패는 스냅샷 저장을 막지 않는다(원본 URL 보존, P0 무음 실패 금지).
 */
export async function storeStorySnapshots(
  prisma: PrismaClient,
  sellerId: string,
  handle: string,
  stories: ParsedStory[],
  result: StoryCaptureResult,
): Promise<void> {
  for (const story of stories) {
    // 뷰어가 요청 외 계정을 섞어 반환해도 무시 — 요청한 핸들의 스토리만 귀속
    if (normalizeHandle(story.username) !== handle) continue;

    const existing = await prisma.sellerStorySnapshot.findUnique({
      where: { sellerId_storyPk: { sellerId, storyPk: story.storyPk } },
      select: { id: true },
    });
    if (existing) continue;

    let thumbnailUrl: string | null = null;
    if (story.imageUrl && isSellerMediaStorageConfigured()) {
      try {
        assertPublicHttpUrl(story.imageUrl);
        const thumb = await fetchStoryThumb(story.imageUrl);
        if (!thumb) throw new Error("이미지 다운로드 실패(프록시·직접 모두)");
        const path = `sellers/${sellerId}/stories/${story.storyPk}.${extFromContentType(thumb.contentType)}`;
        await uploadBytes(path, thumb.bytes, thumb.contentType);
        thumbnailUrl = publicMediaUrl(path);
        result.thumbnailsRehosted += 1;
      } catch (e) {
        result.errors.push(`thumb ${story.storyPk}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await prisma.sellerStorySnapshot.create({
      data: {
        sellerId,
        storyPk: story.storyPk,
        takenAt: new Date(story.takenAtMs),
        expiringAt: story.expiringAtMs ? new Date(story.expiringAtMs) : null,
        mediaType: story.mediaType,
        thumbnailUrl,
        sourceImageUrl: story.imageUrl,
        sourceVideoUrl: story.videoUrl,
        caption: story.caption,
      },
    });
    result.storiesNew += 1;
  }
}

/**
 * 진입점 — 수집창 안의 캠페인을 가진 인스타 셀러 전원의 스토리를 캡처해 저장한다.
 * 멱등: (sellerId, storyPk) unique — 같은 스토리는 재수집돼도 1행. 읽기 외 부작용은
 * SellerStorySnapshot insert 와 썸네일 업로드뿐(네이버 동기화 등 트리거 없음).
 *
 * sellerIds 를 주면 창 안 셀러와의 **교집합**으로만 좁힌다(캠페인 상세 셀러별 수동 수집).
 * 창 판정 자체는 우회하지 않는다 — 창 밖 셀러는 대상 0으로 정직하게 끝나야, 저장은 됐는데
 * 캠페인 화면(GET stories 가 수집창으로 재필터)엔 안 보이는 혼란을 만들지 않는다.
 */
export async function captureActiveCampaignStories(
  prisma: PrismaClient,
  now = new Date(),
  force = false,
  sellerIds?: string[],
): Promise<StoryCaptureResult> {
  const errors: string[] = [];

  const windowSellers = await listCaptureWindowSellers(prisma, now);
  const sellerFilter = sellerIds ? new Set(sellerIds) : null;
  const sellerByHandle = new Map<string, string>();
  for (const s of windowSellers) {
    if (sellerFilter && !sellerFilter.has(s.id)) continue;
    sellerByHandle.set(s.handle, s.id);
  }

  // 대상 셀러 총수(일일 게이트 스킵 전 기준 — 표기·관측용. sellerIds 필터는 반영된 값).
  const activeSellers = sellerByHandle.size;

  // 일일 중복 방지 게이트(오너 2026-07-13): 오늘(KST) 이미 수집된 셀러는 뷰어를 다시 열지 않는다.
  // 수동 재수집(force=true)은 우회. DB dedup((sellerId, storyPk) unique)은 그대로라 정확성엔 영향 없음.
  let handlesSkipped = 0;
  if (!force && sellerByHandle.size > 0) {
    const sellerIds = [...new Set(sellerByHandle.values())];
    const capturedToday = await prisma.sellerStorySnapshot.findMany({
      where: { sellerId: { in: sellerIds }, capturedAt: { gte: startOfKstDay(now) } },
      select: { sellerId: true },
      distinct: ["sellerId"],
    });
    const capturedIds = new Set(capturedToday.map((r) => r.sellerId));
    for (const [handle, sellerId] of [...sellerByHandle]) {
      if (capturedIds.has(sellerId)) {
        sellerByHandle.delete(handle);
        handlesSkipped += 1;
      }
    }
  }

  const handles = [...sellerByHandle.keys()];
  const result: StoryCaptureResult = {
    activeSellers,
    handles,
    storiesSeen: 0,
    storiesNew: 0,
    thumbnailsRehosted: 0,
    handlesSkipped,
    handlesFailed: 0,
    errors,
  };
  if (handles.length === 0) return result;

  // 브라우저 1회 기동으로 전 핸들 순회 수집(뷰어 조작). 핸들별 에러는 격리됨.
  const perHandle = await fetchStoriesForHandles(handles);
  for (const { handle, items, error } of perHandle) {
    if (error) {
      errors.push(`fetch ${handle}: ${error}`);
      result.handlesFailed += 1;
    }
    const stories = parseStoryItems(items);
    result.storiesSeen += stories.length;
    const sellerId = sellerByHandle.get(handle);
    if (!sellerId) continue;
    await storeStorySnapshots(prisma, sellerId, handle, stories, result);
  }

  return result;
}
