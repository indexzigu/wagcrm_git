import { NextResponse } from "next/server";
import { after } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { scrapeSellerDataWaterfall } from "@/lib/seller-analysis/scraper";
import { computeSellerMetrics } from "@/lib/seller-analysis/metrics";
import { analyzeSellerData } from "@/lib/seller-analysis/gemini";
import { computeSubScores } from "@/lib/seller-analysis/scores";
import type { PostPreview } from "@/lib/seller-analysis/types";
import { recordSellerMetricsSnapshot } from "@/lib/seller-history";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { isMediaRehostConfigured, rehostSellerMedia } from "@/lib/seller-analysis/mediaRehost";
import { mergePostsPreview, toPostsPreview } from "@/lib/seller-analysis/posts-preview-merge";
import { buildFieldSuggestions } from "@/lib/seller-analysis/reviewMapping";
import { sellerService } from "@/services/sellerService";

/** 기존 aiTags(Json)에서 postsPreview 배열을 방어적으로 꺼낸다(형태 불일치 시 []). */
function extractExistingPreview(aiTags: unknown): PostPreview[] {
  if (!aiTags || typeof aiTags !== "object") return [];
  const preview = (aiTags as Record<string, unknown>).postsPreview;
  return Array.isArray(preview) ? (preview as PostPreview[]) : [];
}

// 재분석 시 postsPreview 보존 병합 상한 — fresh 30 + 이전 창내 후보 일부. 다운스트림(rehost sweep 등)
// 부하를 고려해 소폭만 상향(30→45).
const POSTS_PREVIEW_CAP = 45;

type Context = { params: Promise<{ id: string }> };

// 수집(워터폴 60~120s) + Gemini 분석이 Vercel 기본 함수 한도를 넘을 수 있어 명시 확장
// (미설정 시 프로덕션에서 "분석 시작"이 타임아웃 — 2026-07-06 재호스팅 작업 중 발견한 갭)
export const maxDuration = 300;

// POST /api/sellers/[id]/analyze
// 셀러 스크래핑 → 결정적 지표 → Gemini 정성 분석 → SellerAiProfile 저장 (방식 B: 서버측 Prisma).
// 지표 필드(평가 4종 + 미입력 카테고리)는 분석 완료 시 자동 반영한다(오너 확정 2026-07-16 —
// 구 "검토 후 확정" 사람 검수 게이트 폐기, 자동 대상 정책 SSOT는 reviewMapping.autoCheck).
// 객관 지표(팔로워·게시물수·bio·프로필 이미지·계정 이름)는 갱신 버튼·수집 크론과 동일 규약으로 Seller에 반영한다.
export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();

  const seller = await prisma.seller.findUnique({
    where: { id },
    select: {
      id: true,
      snsType: true,
      snsHandle: true,
      name: true,
      // 지표 자동반영의 현재값 대조용 (buildFieldSuggestions 입력)
      activityFrequency: true,
      adResponseScore: true,
      commentResponseScore: true,
      collaborationScore: true,
      category: true,
      fitLevel: true,
    },
  });
  if (!seller) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }
  if ((seller.snsType || "").toUpperCase() !== "INSTAGRAM") {
    return NextResponse.json(
      { error: `현재 인스타그램 계정만 분석 가능합니다 (요청 유형: ${seller.snsType})` },
      { status: 400 }
    );
  }

  try {
    // 1) 수집 (워터폴 — 실패는 throw, 빈 데이터를 성공처럼 저장하지 않음: P0 No Silent Failure)
    const losslessData = await scrapeSellerDataWaterfall(seller.snsHandle);

    // 2) 결정적 지표 (서버 계산 — 원본 기준, 클라이언트 값 신뢰 안 함)
    const metrics = computeSellerMetrics(losslessData);

    // 3) Gemini 정성 분석 (계산된 지표 주입, LLM은 해석·정성 판단 전담)
    const geminiResult = await analyzeSellerData(losslessData, metrics);

    // 4) 서브점수 → composite/confidence 캐시 (T1 정렬·필터용; 세부는 aiTags.metrics에서 렌더 시 재계산)
    const scores = computeSubScores(metrics);

    // 5) 확장 테이블 upsert. 코어 Seller는 건드리지 않음.
    // profileMeta: 리스크 플래그(허수 팔로워·브랜드 판별)의 근거. postsPreview: T3 피드 프리뷰 —
    // 캡션·댓글 원문 미저장(§8 개인정보 원칙), 광고/공구 판정은 수집 시점에 계산해 boolean만 남긴다.
    const profile = losslessData.profile ?? {};
    const profileMeta = {
      followerCount: Number(profile.follower_count) || null,
      followingCount: Number.isFinite(Number(profile.following_count)) ? Number(profile.following_count) : null,
      postsCountTotal: Number(profile.media_count ?? profile.posts_count) || null,
      bio: typeof profile.bio === "string" && profile.bio.trim() ? profile.bio : null,
      profilePicUrl:
        typeof profile.profilePicUrl === "string" && profile.profilePicUrl.trim() ? profile.profilePicUrl : null,
      fullName: typeof profile.fullName === "string" && profile.fullName.trim() ? profile.fullName : null,
    };
    // 매핑은 일간 캠페인 게시물 크론과 공유하는 SSOT(toPostsPreview) — 각자 매핑 시 필드 드리프트 재발
    const postsPreview: PostPreview[] = toPostsPreview(losslessData.raw_posts);
    // 재분석 유실 방지(오너 2026-07-13): 이전 프리뷰 중 fresh에 없는 항목을 permalink 기준 보존 병합.
    // 창 안 미리뷰 후보가 최근 30개 밖으로 밀려나도 다음 재분석까지 후보로 남는다. 홍보(Asset)·무관
    // (SellerPostClassification)은 독립 영속이라 이 병합과 무관.
    const existingProfile = await prisma.sellerAiProfile.findUnique({
      where: { sellerId: id },
      select: { aiTags: true },
    });
    const mergedPreview = mergePostsPreview(
      postsPreview,
      extractExistingPreview(existingProfile?.aiTags),
      POSTS_PREVIEW_CAP,
    );
    const aiTags = {
      ...geminiResult.analysis,
      metrics,
      interaction_id: geminiResult.interaction_id,
      profileMeta,
      postsPreview: mergedPreview,
    };
    const analyzedAt = new Date();
    const payload = {
      aiTags: aiTags as object,
      compositeScore: scores.composite,
      confidence: scores.confidence,
      sourceTier: losslessData.source_tier ?? null,
      analyzedAt,
    };
    await prisma.sellerAiProfile.upsert({
      where: { sellerId: id },
      create: { sellerId: id, ...payload },
      update: payload,
    });

    // 5.5) 지표 자동반영 (오너 확정 2026-07-16 — "검토 후 확정" 수동 게이트 제거).
    // 기계적 근거가 강한 필드만 자동으로 CRM에 쓴다 — buildFieldSuggestions의 autoCheck 정책을
    // 그대로 재사용하므로 어떤 필드가 자동 대상인지의 SSOT는 여전히 reviewMapping 한 곳이다:
    // 평가 4필드는 항상, 카테고리는 완전 미입력일 때만(운영자 큐레이션 보호), fitLevel은 직접
    // 쓰지 않는다(updateSeller의 합산 규칙 seller-fit SSOT가 재계산). 변경 이력은 updateSeller의
    // 감사 로그가 남긴다. 실패해도 분석 결과는 유효 — 삼키지 않고 응답에 사유를 실어 표면화한다.
    let applied: { fields: Record<string, string>; fitLevel: string | null } | null = null;
    let autoApplyError: string | null = null;
    try {
      const analysisCategory = (geminiResult.analysis as Record<string, unknown> | null)?.category;
      const suggestions = buildFieldSuggestions(
        {
          activityFrequency: seller.activityFrequency ?? null,
          adResponseScore: seller.adResponseScore ?? null,
          commentResponseScore: seller.commentResponseScore ?? null,
          collaborationScore: seller.collaborationScore ?? null,
          category: seller.category ?? null,
          fitLevel: seller.fitLevel ?? null,
        },
        metrics,
        scores,
        { category: typeof analysisCategory === "string" ? analysisCategory : null },
      );
      const patch: Record<string, string> = {};
      for (const s of suggestions) {
        if (s.autoCheck && s.suggested !== null) patch[s.field] = s.suggested;
      }
      if (Object.keys(patch).length > 0) {
        // 분석은 60~300초 걸린다 — 그 사이 운영자가 평가 카드에서 수동 정정한 값을, 요청 시작
        // 시점 스냅샷 기준으로 계산한 patch가 조용히 되돌릴 수 있다(code-review HIGH). 반영
        // 직전 재조회해서 스냅샷과 달라진 필드(=분석 중 사람이 만진 필드)는 이번 자동반영에서
        // 제외한다 — 이번 회차 한정 사람 > AI. 다음 재분석은 그 값을 기준으로 다시 제안한다.
        const fresh = await prisma.seller.findUnique({
          where: { id },
          select: {
            activityFrequency: true,
            adResponseScore: true,
            commentResponseScore: true,
            collaborationScore: true,
            category: true,
          },
        });
        if (fresh) {
          const snapshot = seller as unknown as Record<string, string | null>;
          const latest = fresh as unknown as Record<string, string | null>;
          for (const field of Object.keys(patch)) {
            if ((snapshot[field] ?? null) !== (latest[field] ?? null)) delete patch[field];
          }
        }
        if (fresh && Object.keys(patch).length > 0) {
          const updated = await sellerService.updateSeller(id, patch, "AI 분석 자동반영");
          applied = { fields: patch, fitLevel: updated.fitLevel ?? null };
        }
      }
    } catch (e) {
      autoApplyError = e instanceof Error ? e.message : "지표 자동반영 실패";
      console.warn("[analyze-seller] 지표 자동반영 실패(분석 결과는 유효):", autoApplyError);
    }

    // 프로필 지표 스냅샷 적립 — 기존 SellersHistory·성장 차트가 그대로 소비 (스냅샷 이중 용도, 스펙 §8).
    // ER 파생 스칼라도 함께 적립해 ER 추이 차트의 점이 된다 (§11-3).
    // 실패해도 분석 결과는 유효하므로 경고만 남긴다 (0/실패 센티넬은 적립하지 않음).
    if (profileMeta.followerCount && profileMeta.followerCount > 0) {
      try {
        await recordSellerMetricsSnapshot(
          id,
          profileMeta.followerCount,
          "AI_ANALYZE",
          {
            // 분석이 이미 확보한 객관 지표를 갱신 버튼(channel-info)과 동일하게 Seller에 반영 —
            // 값이 없으면 undefined로 생략해 기존 값을 지우지 않는다 (0/실패 센티넬 미적립과 같은 원칙)
            postsCount: profileMeta.postsCountTotal ?? undefined,
            profileBio: profileMeta.bio ?? undefined,
            // 프로필 이미지는 헬퍼가 내부에서 Blob 미러링 후 Seller.profilePicUrl까지 갱신
            profilePicUrl: profileMeta.profilePicUrl ?? undefined,
          },
          {
            er: metrics.engagement.er,
            avgLikes: metrics.engagement.avgLikes,
            avgComments: metrics.engagement.avgComments,
          },
        );
        // 계정 이름도 채널정보 갱신(channel-info)과 동일 의미론으로 반영 — 변경 시에만 갱신
        if (profileMeta.fullName && profileMeta.fullName !== seller.name) {
          await prisma.seller.update({ where: { id }, data: { name: profileMeta.fullName } });
        }
      } catch (e) {
        console.warn("[analyze-seller] 팔로워 스냅샷/이름 동기화 실패:", e instanceof Error ? e.message : e);
      }
    }

    // T1 목록(aiComposite 컬럼)이 warm 캐시(≤2h)라 즉시 반영되도록 무효화 — PATCH 라우트와 동일 관례
    revalidateMasterDataCaches();

    // 썸네일 즉시 재호스팅 (응답 반환 후 백그라운드, 스펙 §8 개정) — 인스타 CDN URL은 당일에도
    // 일부 만료되므로 신선할 때 바로 확보. Vercel Hobby는 크론이 일 1회뿐이라 after()가 1차 경로,
    // 일일 크론(rehost-seller-media)은 여기서 못 끝낸 잔여분 청소용. 실패해도 분석 결과는 유효.
    if (isMediaRehostConfigured()) {
      const rehostDeadline = Date.now() + 150_000; // maxDuration 300s 중 분석 소요분 제외 보수 예산
      after(async () => {
        try {
          const result = await rehostSellerMedia(prisma, id, {
            spacingMs: 1500,
            jitterMs: 1000,
            deadlineMs: rehostDeadline,
          });
          console.log("[analyze-seller] 썸네일 재호스팅:", JSON.stringify(result));
        } catch (e) {
          console.warn("[analyze-seller] 재호스팅 실패(분석 결과는 유효):", e instanceof Error ? e.message : e);
        }
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        analysis: geminiResult.analysis,
        metrics,
        scores,
        sourceTier: losslessData.source_tier ?? null,
        analyzedAt: analyzedAt.toISOString(),
        // 자동 반영 결과 — 클라이언트가 행/패널 상태를 낙관 갱신하는 근거. 실패 시 null + 사유.
        applied,
        autoApplyError,
      },
    });
  } catch (error: unknown) {
    // P0: 실패를 삼키지 않고 표면화
    const message = error instanceof Error ? error.message : "분석 중 오류가 발생했습니다";
    console.error("[analyze-seller] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
