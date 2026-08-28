import { createHash } from 'node:crypto';
import { prisma } from './prisma';
import { findDealsNeedingReviewLink } from './review-link';
import {
  getGoogleDriveConnectionStatus,
  putDriveJsonFile,
  getDriveJsonFile,
} from '../asset-storage';

/** 수동 임포트 지원 채널(스크랩 불가·협조 브랜드 몰 리뷰의 오너 직접 적재 경로 — 계획서 §2-C/D3). */
export const VOC_CHANNELS = ['SMARTSTORE_OWN', 'SMARTSTORE_EXTERNAL', 'CAFE24', 'MANUAL'] as const;
export type VocChannel = (typeof VOC_CHANNELS)[number];

/**
 * 상품 리뷰(VOC) 저장소 — SSOT: REVIEW_QNA_COLLECTION_PLAN.md (Phase 2).
 *
 * Supabase 의존 최소화(오너 지시): 리뷰 **코퍼스 본문은 Google Drive 파일**에 저장하고,
 * Postgres(DealVocSource)에는 **집계·포인터·프리뷰**만 둔다. 리뷰 텍스트가 Supabase
 * egress/스토리지를 소모하지 않는다. 이 파일은 (1) 순수 로직(merge/dedup/aggregate — 테스트
 * 대상)과 (2) Drive+Postgres I/O 오케스트레이션을 분리한다.
 *
 * 단일 writer 계약: 리뷰 코퍼스 파일은 수집 크론(일 1회, 딜당 순차)만 write-modify-read 한다.
 * Drive는 트랜잭션이 없으므로 동시 writer가 있으면 통짜 파일이 덮어써져 유실된다 — 호출부가
 * 직렬 실행을 보장한다.
 */

/** 정규화된 리뷰 1건(스크랩/수동입력 소스 무관 공통 형태). Drive 코퍼스의 요소. */
export type VocReview = {
  externalId: string; // 페이지 리뷰 id 또는 (작성자+날짜+본문) 해시 — dedup 키
  rating: number; // 1~5
  content: string;
  writtenAt: string; // ISO — Drive는 Date 직렬화가 없어 문자열 보관
  writerMasked?: string | null;
  optionText?: string | null;
  isRepurchase?: boolean | null;
  imageUrls?: string[]; // URL만(원본 blob 미저장 — egress 가드)
  helpCount?: number | null;
};

/** Drive 코퍼스 파일의 최상위 형태. */
export type VocReviewCorpus = {
  v: 1;
  dealId: string;
  channel: string;
  reviews: VocReview[];
};

/** DealVocSource 얇은 행에 반영할 집계(Postgres 즉시표시용 — Drive 왕복 불요). */
export type VocAggregate = {
  reviewCount: number;
  ratingSum: number;
  ratingCounts: Record<string, number>; // "1".."5"
  photoCount: number;
  latestReviewAt: Date | null;
  preview: VocReview[]; // 최신 N건
};

const PREVIEW_LIMIT = 10;

// ─────────────────────────── 순수 로직(테스트 대상) ───────────────────────────

/** ISO 문자열의 시간값(ms). 파싱 불가/빈값은 0(정렬 시 맨 뒤로 밀리지 않게 호출부가 처리). */
function timeOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 기존 코퍼스와 신규 리뷰를 externalId로 dedup 병합한다(신규가 기존을 갱신 — 답변/도움수 변동 반영).
 * 결과는 writtenAt 내림차순 정렬(최신 우선). externalId 빈 항목은 버린다(dedup 불가 → 무한 증식 방지).
 */
export function mergeReviews(existing: VocReview[], incoming: VocReview[]): VocReview[] {
  const byId = new Map<string, VocReview>();
  for (const r of existing) {
    const id = (r.externalId ?? '').trim();
    if (id) byId.set(id, r);
  }
  for (const r of incoming) {
    const id = (r.externalId ?? '').trim();
    if (id) byId.set(id, { ...r, externalId: id }); // 신규가 우선(갱신)
  }
  return Array.from(byId.values()).sort((a, b) => timeOf(b.writtenAt) - timeOf(a.writtenAt));
}

/** 리뷰 내용으로 결정론적 externalId를 만든다(수동 임포트가 id를 안 줄 때 — 재임포트 dedup용). */
function stableReviewId(r: { writtenAt?: unknown; content?: unknown; writerMasked?: unknown }): string {
  const basis = `${String(r.writtenAt ?? '')}|${String(r.content ?? '')}|${String(r.writerMasked ?? '')}`;
  return `h_${createHash('sha256').update(basis).digest('hex').slice(0, 16)}`;
}

/**
 * 임의 입력(수동 임포트·CSV 파싱 결과)을 VocReview[]로 정규화한다(순수). rating이 없거나 범위 밖,
 * content가 비면 버린다. externalId가 없으면 내용 해시로 채운다(재임포트 멱등). writtenAt 파싱 불가는
 * 버린다(귀속 창 계산이 작성일에 의존 — 계획서 §3-1).
 */
export function normalizeImportedReviews(raw: unknown): VocReview[] {
  if (!Array.isArray(raw)) return [];
  const out: VocReview[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const rating = Math.round(Number(r.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) continue;
    const content = typeof r.content === 'string' ? r.content.trim() : '';
    if (content.length === 0) continue;
    // writtenAt은 ISO 문자열 또는 epoch 숫자(밀리초) 둘 다 허용 — 숫자를 String()으로 캐스팅하면
    // new Date("1720000000000")가 Invalid Date가 돼 조용히 버려지는 실사고(코드리뷰 HIGH)를 방지.
    const wt =
      typeof r.writtenAt === 'number'
        ? new Date(r.writtenAt)
        : r.writtenAt != null
          ? new Date(String(r.writtenAt))
          : null;
    if (!wt || Number.isNaN(wt.getTime())) continue;
    const externalId =
      typeof r.externalId === 'string' && r.externalId.trim().length > 0
        ? r.externalId.trim()
        : stableReviewId({ writtenAt: wt.toISOString(), content, writerMasked: r.writerMasked });
    const images = Array.isArray(r.imageUrls) ? r.imageUrls.filter((u): u is string => typeof u === 'string') : [];
    out.push({
      externalId,
      rating,
      content,
      writtenAt: wt.toISOString(),
      writerMasked: typeof r.writerMasked === 'string' ? r.writerMasked : null,
      optionText: typeof r.optionText === 'string' ? r.optionText : null,
      isRepurchase: typeof r.isRepurchase === 'boolean' ? r.isRepurchase : null,
      imageUrls: images,
      helpCount: Number.isFinite(Number(r.helpCount)) ? Number(r.helpCount) : null,
    });
  }
  return out;
}

/** 리뷰 배열에서 DealVocSource 집계를 계산한다(순수). ratingCounts는 1~5만 카운트. */
export function computeVocAggregate(reviews: VocReview[]): VocAggregate {
  const ratingCounts: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let ratingSum = 0;
  let photoCount = 0;
  let latest = 0;
  for (const r of reviews) {
    const rt = Math.round(Number(r.rating));
    if (rt >= 1 && rt <= 5) {
      ratingCounts[String(rt)] += 1;
      ratingSum += rt;
    }
    if (Array.isArray(r.imageUrls) && r.imageUrls.length > 0) photoCount += 1;
    const t = timeOf(r.writtenAt);
    if (t > latest) latest = t;
  }
  // 정렬은 mergeReviews가 이미 최신순으로 해두므로 상위 N건이 프리뷰.
  const preview = reviews.slice(0, PREVIEW_LIMIT);
  return {
    reviewCount: reviews.length,
    ratingSum,
    ratingCounts,
    photoCount,
    latestReviewAt: latest > 0 ? new Date(latest) : null,
    preview,
  };
}

// ─────────────────────────── Drive + Postgres 오케스트레이션 ───────────────────────────

function corpusFileName(dealId: string, channel: string): string {
  return `reviews_${dealId}_${channel}.json`;
}

/** Drive 미연결이면 리뷰 수집은 진행 불가(코퍼스 저장처가 없음) — 명확한 에러(침묵 실패 금지). */
export async function assertDriveReady(): Promise<void> {
  const status = await getGoogleDriveConnectionStatus();
  if (!status.connected) {
    throw new Error(
      'Google Drive 미연결: 리뷰 코퍼스 저장처가 없습니다. /settings 통합에서 Google Drive를 연결하세요(Supabase 대체 저장소).',
    );
  }
}

/** 딜+채널의 기존 코퍼스를 Drive에서 로드한다. driveFileId 없으면 빈 코퍼스. */
export async function loadCorpus(
  dealId: string,
  channel: string,
  driveFileId: string | null | undefined,
): Promise<VocReviewCorpus> {
  if (!driveFileId) return { v: 1, dealId, channel, reviews: [] };
  const raw = await getDriveJsonFile<Partial<VocReviewCorpus>>(driveFileId);
  const reviews = Array.isArray(raw?.reviews) ? (raw!.reviews as VocReview[]) : [];
  return { v: 1, dealId, channel, reviews };
}

// 딜+채널당 read-modify-write 직렬화(인메모리 in-flight 락 — 같은 인스턴스 내 더블클릭/재시도가
// 코퍼스 통짜 파일을 동시에 덮어 유실되는 것을 막는다). naver-return-delivery의 in-flight 선례와 동형.
// ⚠️ 서버리스 인스턴스 간 동시성은 못 막는다 — 수집 크론이 딜당 순차 실행(단일 writer)이라는 계약이
// 근본 방어이고, 이 락은 라우트 재시도 등 인스턴스 내 경합만 커버한다.
const inFlightByKey = new Map<string, Promise<{ reviewCount: number; added: number }>>();

/**
 * 신규 리뷰를 딜+채널 코퍼스에 병합해 Drive에 저장하고, Postgres 얇은 행(집계·포인터·프리뷰)을 갱신한다.
 * 실패는 삼키지 않고 status=ERROR로 강등 기록(행이 없으면 생성) 후 rethrow.
 */
export async function persistDealReviews(input: {
  dealId: string;
  channel: string;
  productUrl?: string | null;
  originProductNo?: string | null;
  channelProductNo?: string | null;
  incoming: VocReview[];
}): Promise<{ reviewCount: number; added: number }> {
  const key = `${input.dealId}:${input.channel}`;
  const prior = inFlightByKey.get(key);
  // 진행 중인 같은 키 작업이 있으면 그 뒤에 직렬로 이어붙인다(성공/실패 무관하게 순차 실행).
  const run = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(() =>
    persistDealReviewsUnlocked(input),
  );
  inFlightByKey.set(
    key,
    run.finally(() => {
      if (inFlightByKey.get(key) === run) inFlightByKey.delete(key);
    }) as Promise<{ reviewCount: number; added: number }>,
  );
  return run;
}

async function persistDealReviewsUnlocked(input: {
  dealId: string;
  channel: string;
  productUrl?: string | null;
  originProductNo?: string | null;
  channelProductNo?: string | null;
  incoming: VocReview[];
}): Promise<{ reviewCount: number; added: number }> {
  await assertDriveReady();

  const source = await prisma.dealVocSource.findUnique({
    where: { dealId_channel: { dealId: input.dealId, channel: input.channel } },
  });

  try {
    const existingCorpus = await loadCorpus(input.dealId, input.channel, source?.driveFileId);
    const before = existingCorpus.reviews.length;
    const merged = mergeReviews(existingCorpus.reviews, input.incoming);
    const agg = computeVocAggregate(merged);

    const corpus: VocReviewCorpus = { v: 1, dealId: input.dealId, channel: input.channel, reviews: merged };
    const { fileId } = await putDriveJsonFile({
      fileName: corpusFileName(input.dealId, input.channel),
      data: corpus,
      existingFileId: source?.driveFileId ?? null,
    });

    const data = {
      dealId: input.dealId,
      channel: input.channel,
      productUrl: input.productUrl ?? source?.productUrl ?? null,
      originProductNo: input.originProductNo ?? source?.originProductNo ?? null,
      channelProductNo: input.channelProductNo ?? source?.channelProductNo ?? null,
      driveFileId: fileId,
      reviewCount: agg.reviewCount,
      ratingSum: agg.ratingSum,
      ratingCounts: JSON.stringify(agg.ratingCounts),
      photoCount: agg.photoCount,
      latestReviewAt: agg.latestReviewAt,
      previewJson: JSON.stringify(agg.preview),
      status: 'ACTIVE',
      lastError: null,
      lastCollectedAt: new Date(),
    };
    await prisma.dealVocSource.upsert({
      where: { dealId_channel: { dealId: input.dealId, channel: input.channel } },
      create: data,
      update: data,
    });

    return { reviewCount: agg.reviewCount, added: agg.reviewCount - before };
  } catch (err) {
    // 강등 기록 — 침묵 실패 금지(P0). 최초 수집 실패로 행이 아직 없어도 ERROR 마커를 남긴다
    // (upsert) 그래야 감시 표면(status=ERROR)에서 실패가 보인다. 그 후 rethrow(호출부도 인지).
    const lastError = err instanceof Error ? err.message.slice(0, 500) : 'unknown';
    await prisma.dealVocSource
      .upsert({
        where: { dealId_channel: { dealId: input.dealId, channel: input.channel } },
        create: {
          dealId: input.dealId,
          channel: input.channel,
          productUrl: input.productUrl ?? null,
          originProductNo: input.originProductNo ?? null,
          channelProductNo: input.channelProductNo ?? null,
          status: 'ERROR',
          lastError,
        },
        update: { status: 'ERROR', lastError },
      })
      .catch(() => undefined);
    throw err;
  }
}

/** 딜+채널의 전체 리뷰 코퍼스를 Drive에서 로드한다(AI 분석·전체보기·회차 귀속 필터용). */
export async function loadDealCorpus(dealId: string, channel: string): Promise<VocReviewCorpus> {
  const source = await prisma.dealVocSource.findUnique({
    where: { dealId_channel: { dealId, channel } },
  });
  return loadCorpus(dealId, channel, source?.driveFileId);
}

// ─────────────────────────── 딜 상세 뷰(Phase 1b) ───────────────────────────

// AI 인사이트 payload의 **타입 정본은 여기다**(생성 로직은 인사이트 엔진 모듈). 이유: 읽기
// 경로(이 파일·/voc 라우트)는 I1 계약상 인사이트 엔진을 import할 수 없는데(모듈명 언급조차
// 계약 테스트에 걸린다 — 의도된 엄격함) 화면은 payload 형태를 알아야 한다 — 의존 방향이
// 엔진→store(loadCorpus)로 이미 존재하므로 타입을 이쪽에 두고 엔진이 re-export한다. §6-3.
export type VocInsightPayload = {
  summary: string;
  praises: { label: string; count: number; quotes: string[] }[];
  complaints: { label: string; count: number; severity: 'low' | 'mid' | 'high'; quotes: string[] }[];
  faq: { q: string; a: string | null }[];
  mismatchShare: number | null; // 기대불일치(광고·설명과 다름 취지) 비중 — 리뷰 없으면 null
  contentAngles: string[];
  brandFeedback: string[];
};

/** 첫 분석 최소 VOC(§6-2) — 정본. 인사이트 엔진(dirty 판정)과 화면 대기 문안이 공유한다. */
export const VOC_DIRTY_MIN_INITIAL = 5;

/** 딜 상세 "고객 반응" 섹션의 QnA 1건(화면 표시용 얇은 형태). */
export type DealVocQna = {
  questionId: string;
  question: string;
  answer: string | null;
  answered: boolean;
  createDate: string; // ISO
  productName: string | null;
};

/** 딜 상세 리뷰 요약(DealVocSource 얇은 행 파생 — Drive 왕복 없이 즉시 표시). */
export type DealVocReviewSummary = {
  channel: string;
  reviewCount: number;
  avgRating: number | null;
  ratingCounts: Record<string, number>;
  photoCount: number;
  latestReviewAt: string | null; // ISO
  preview: VocReview[];
  status: string;
  lastError: string | null;
};

/** AI 인사이트 스냅샷의 화면 표시용 형태(PR B). 조회는 스냅샷 행만 — LLM 무호출(I1). */
export type DealVocInsightView = {
  payload: VocInsightPayload | null; // null=성공 이력 없음
  generatedAt: string | null; // ISO — "N일 전 분석" 라벨
  lastError: string | null; // 직전 실패 사유(payload는 이전 성공본 보존)
  totalVoc: number; // 현재 문의+리뷰 총량 — 분석 대기(minInitial 미만) 판정
  minInitial: number; // VOC_DIRTY_MIN_INITIAL — 대기 문안용
};

export type DealVocView = {
  qnas: DealVocQna[];
  unansweredQnaCount: number;
  reviewSummaries: DealVocReviewSummary[]; // 채널별(보통 0~1개)
  insight: DealVocInsightView;
  /** 리뷰 소스 부재 신호 — 오너가 캠페인 상품 링크(공구 단축링크)를 채우면 다음 크론이 수집(오너 데이터 경로 ②). */
  reviewSource: { needsLink: boolean };
};

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 딜 상세 "고객 반응" 섹션 데이터. ProductQna(dealId 매칭분)와 DealVocSource(리뷰 집계)를 읽는다.
 * 리뷰 코퍼스 본문(Drive)은 읽지 않는다 — 얇은 행의 집계·프리뷰만(즉시 표시·egress 0).
 */
export async function loadDealVocView(dealId: string): Promise<DealVocView> {
  const [qnaRows, sources, qnaTotal, snapshot, reviewLinkGaps] = await Promise.all([
    prisma.productQna.findMany({
      where: { dealId },
      orderBy: { createDate: 'desc' },
      take: 50,
      select: { questionId: true, question: true, answer: true, answered: true, createDate: true, productName: true },
    }),
    prisma.dealVocSource.findMany({ where: { dealId } }),
    // qnas는 take:50 캡이라 총량은 별도 count(분석 대기 판정이 총량 기준 — §6-2).
    prisma.productQna.count({ where: { dealId } }),
    prisma.vocInsightSnapshot.findUnique({ where: { dealId } }),
    // 리뷰 소스 부재 판정(순수 신호 집계 — LLM·Drive 무접촉이라 I1 안전). 위 dealVocSource 조회와
    // reviewCount가 겹치지만 의도적 중복 — 헬퍼를 sources 이후로 직렬화하면 왕복이 한 번 늘어,
    // 딜 1건 인덱스 조회의 중복 제거보다 비싸다(ss-ux P1-1 검토 후 유지 결정).
    findDealsNeedingReviewLink([dealId]),
  ]);

  const qnas: DealVocQna[] = qnaRows.map((q) => ({
    questionId: q.questionId,
    question: q.question,
    answer: q.answer,
    answered: q.answered,
    createDate: q.createDate.toISOString(),
    productName: q.productName,
  }));

  const reviewSummaries: DealVocReviewSummary[] = sources.map((s) => ({
    channel: s.channel,
    reviewCount: s.reviewCount,
    avgRating: s.reviewCount > 0 ? Math.round((s.ratingSum / s.reviewCount) * 10) / 10 : null,
    ratingCounts: safeJsonParse<Record<string, number>>(s.ratingCounts, {}),
    photoCount: s.photoCount,
    latestReviewAt: s.latestReviewAt ? s.latestReviewAt.toISOString() : null,
    preview: safeJsonParse<VocReview[]>(s.previewJson, []),
    status: s.status,
    lastError: s.lastError,
  }));

  const reviewTotal = sources.reduce((sum, s) => sum + (s.reviewCount || 0), 0);
  // payload는 upsert 시 parseInsightPayload로 검증된 형태만 저장된다 — 읽기에선 객체 여부만 방어.
  const rawPayload = snapshot?.payload;
  const payload =
    rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? (rawPayload as unknown as VocInsightPayload)
      : null;

  return {
    qnas,
    unansweredQnaCount: qnas.filter((q) => !q.answered).length,
    reviewSummaries,
    reviewSource: { needsLink: reviewLinkGaps.has(dealId) },
    insight: {
      payload,
      generatedAt: snapshot?.generatedAt ? snapshot.generatedAt.toISOString() : null,
      lastError: snapshot?.lastError ?? null,
      totalVoc: qnaTotal + reviewTotal,
      minInitial: VOC_DIRTY_MIN_INITIAL,
    },
  };
}
