import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import {
  callGeminiWithTools,
  GeminiClientError,
} from "@/lib/agent/gemini-client";
import {
  buildContentGuidePrompt,
  findMissingGuideSections,
  parseSupplementaryInfo,
  rankGuideReferences,
  buildProofCard,
  explainProofCardAbsence,
  DEFAULT_GUIDE_KIND,
  isGuideKind,
  type GuideClaims,
  type GuideDealContext,
  type GuideKind,
  type GuideSellerChannel,
} from "@/lib/content-guide";
import { fetchNaverBlogVoc } from "@/lib/content-guide-voc";
import { parseStoredSketches } from "@/lib/guide-sketch";
import { checkText, type GateResult } from "@/lib/claims/claim-gate";
import {
  loadDealClaimContext,
  selectPromptClaims,
  toGateClaims,
} from "@/lib/claims/deal-claim-context";

// Gemini 호출은 per-fetch 60s 타임아웃 × 키 로테이션 2개 = 호출당 최악 ~120s.
// 병렬 2발이 동시에 돌아 총 최악도 ~120s — 여유를 두고 300 (LLM 라우트 선례: sellers/[id]/analyze).
export const maxDuration = 300;

type Context = {
  params: Promise<{ id: string }>;
};

/** 필수 섹션이 누락된(잘린) 생성 결과 — Promise.any 레이싱의 개별 거부 사유로 쓴다. */
class IncompleteGuideError extends Error {
  constructor(public readonly missing: string[]) {
    super(`불완전한 가이드 (누락: ${missing.join(", ")})`);
    this.name = "IncompleteGuideError";
  }
}

/**
 * 생성물이 금지 표현 게이트에 걸린 경우(C3 M1) — 레이싱의 개별 거부 사유.
 *
 * ⚠️ **운영자에게 내보내지 않는다**(오너 결정 §9-Q1). 프롬프트에 제약을 넣어도
 * 모델은 지시를 어기므로, 생성 후 검사가 최종 방어선이다. 레이싱 2발 중 하나가
 * 통과하면 그것을 쓰고, 둘 다 걸리면 위반 목록과 함께 실패로 끝낸다 —
 * 이것이 "1회 재생성 후 실패"의 실체다(추가 재시도 루프를 만들지 않는다).
 */
class ClaimBlockedError extends Error {
  constructor(public readonly violations: GateResult["violations"]) {
    super(`금지 표현 검출 (${violations.length}건)`);
    this.name = "ClaimBlockedError";
  }
}

/**
 * 요청의 가이드 유형(`?kind=`)을 판정한다. POST·GET 이 같은 규칙을 쓴다.
 *
 * ⚠️ **미지의 값을 기본값으로 삼키지 않는다**(P0 — 에러를 삼키지 말 것). 오타 하나가
 * 조용히 셀러형으로 떨어지면 브랜드형 초안을 요청했는데 셀러형 행이 덮어써진다
 * (`@@unique([dealId, kind])` 라 같은 자리다). 없을 때만 종전 동작으로 떨어진다.
 */
function resolveGuideKind(request: Request): GuideKind | null {
  const raw = new URL(request.url).searchParams.get("kind");
  if (raw === null || raw === "") return DEFAULT_GUIDE_KIND;
  return isGuideKind(raw) ? raw : null;
}

const INVALID_KIND_RESPONSE = () =>
  NextResponse.json({ error: "알 수 없는 가이드 유형입니다." }, { status: 400 });

/** Prisma Decimal(unknown 수신)을 number로. null·0 이하는 "미설정"으로 보고 null. */
function toPositiveNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * POST /api/deals/[id]/content-guide
 * 딜 정보 + 레퍼런스 캡션(R3 자동수집)을 Gemini에 넣어 셀러용 콘텐츠 가이드 초안을 생성한다.
 *
 * ⛔ 종전 서술 "Stateless — DB에 저장하지 않는다(R4 스펙)"는 **SUPERSEDED**
 * (2026-08-01, 오너 요청). 생성 결과를 `DealGuideDraft` 에 **딜당 1행 upsert** 한다 —
 * 재방문 시 `GET` 으로 복원해 재생성(Gemini 2발)과 결과 표류를 없앤다. 저장 실패는
 * 생성을 막지 않는다(아래 upsert 블록 참조).
 */
export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const kind = resolveGuideKind(request);
  if (kind === null) return INVALID_KIND_RESPONSE();

  const { id } = await context.params;
  const prisma = getPrisma();

  const deal = await prisma.deal.findUnique({
    where: { id },
    select: {
      dealName: true,
      brandName: true,
      partnerCompanyName: true,
      sourcingMemo: true,
      sellingPrice: true,
      listPrice: true,
      discountRate: true,
      unit: true,
      unitQuantity: true,
      supplementaryInfo: true,
      // category·parentDealId 는 읽지 않는다 — 카테고리·부모 상속은
      // `loadDealClaimContext` 가 정본이다(여기서 또 읽으면 규약이 갈라진다).
    },
  });
  if (!deal) {
    return NextResponse.json(
      { error: "딜을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  // 직전 초안 — 구조 반복 금지 재료 (오너 방향 2026-08-02: N차마다 동일 포맷 금지).
  // 발행 이력은 수집되지 않는 환경이라, 우리가 아는 유일한 이력인 저장 초안을 쓴다.
  const previousDraft = await prisma.dealGuideDraft.findUnique({
    where: { dealId_kind: { dealId: id, kind } },
    select: { body: true },
  });

  // 레퍼런스: 딜에 링크로 등록된 SNS 레퍼런스만 (cron/enrich-references의 where 절 관례)
  const assets = await prisma.asset.findMany({
    where: {
      entityType: "DEAL",
      entityId: id,
      provider: "EXTERNAL_LINK",
      section: "SNS_CREATIVE",
      archivedAt: null,
    },
    select: {
      fileName: true,
      externalUrl: true,
      notes: true,
      // 표시용 — 프롬프트에는 들어가지 않는다. 운영자가 "이 가이드가 무엇을 보고
      // 나왔나"를 확인하는 검수 재료다(썸네일은 크론이 우리 스토리지로 재호스팅한 것).
      thumbnailUrl: true,
      mediaType: true,
    },
  });

  // 좋아요 내림차순 상위 12건만 프롬프트에 넣는다. 정렬·절단은 `rankGuideReferences`가
  // 프롬프트 입력(refs)과 화면 타일(cards)을 **함께** 만든다 — 여기서 다시 정렬하지 말 것.
  const { refs, cards: referenceCards } = rankGuideReferences(assets);

  const { searchKeyword, modelName } = parseSupplementaryInfo(
    deal.supplementaryInfo,
  );
  const dealContext: GuideDealContext = {
    dealName: deal.dealName,
    brandName: deal.brandName,
    partnerCompanyName: deal.partnerCompanyName,
    sourcingMemo: deal.sourcingMemo,
    // sellingPrice는 스키마 default 0 — 0은 "미입력"이므로 프롬프트에서 제외
    sellingPrice: toPositiveNumberOrNull(deal.sellingPrice),
    listPrice: toPositiveNumberOrNull(deal.listPrice),
    discountRate: toPositiveNumberOrNull(deal.discountRate),
    unit: deal.unit,
    unitQuantity: deal.unitQuantity,
    searchKeyword,
    modelName,
  };

  // 소비자 VOC(네이버 블로그 후기)를 요청 시 실시간 조회해 소구점 근거로 넣는다.
  // searchKeyword 우선(정밀 쿼리) — 브랜드명 단독은 동음이의 노이즈. 실패·0건이면 [](비차단).
  const vocQuery =
    dealContext.searchKeyword ??
    [dealContext.brandName, dealContext.dealName].filter(Boolean).join(" ");
  const consumerVoc = await fetchNaverBlogVoc(vocQuery);

  /**
   * C1 게이트 입력 조회 (C3 M1).
   *
   * 상속 규약은 `loadDealClaimContext` 가 정본이다 — 여기서 손으로 다시 쓰면
   * `/api/deals/[id]/claims` 와 갈라진다. 실제로 갈라져 있었다(2026-07-30 실측):
   * 이 라우트가 `parentDealId ?? id` 로 **부모 치환**을 해서 **옵션 딜의 자기
   * 전용 금지 표현이 게이트에서 무시**됐고, 카테고리도 `parent ?? deal` 로
   * **부모 우선**이라 옵션에 지정한 카테고리가 덮였다. 둘 다 게이트가 헐거워지는
   * 방향이라 정본 함수로 수렴시킨다.
   */
  const [claimContext, activeRules, sellerRows] = await Promise.all([
    loadDealClaimContext(id),
    prisma.bannedPhraseRule.findMany({
        where: { active: true },
        select: {
          id: true,
          phrase: true,
          pattern: true,
          category: true,
          severity: true,
          legalBasis: true,
          note: true,
        },
      }),
      /**
       * 이 딜에 붙은 셀러 채널 (C3 M5) — 포맷 추천을 실제 올릴 채널로 좁힌다.
       * 연결 경로는 캠페인(확정된 것)과 영업 테스크(제안 단계) 둘 다다 —
       * 가이드는 캠페인 확정 전에도 만들므로 테스크 쪽 셀러도 봐야 한다.
       */
      prisma.seller.findMany({
        where: {
          OR: [
            { campaigns: { some: { dealId: id } } },
            { salesTasks: { some: { dealId: id } } },
          ],
        },
        select: { snsType: true, currentFollowers: true, category: true },
        take: 5,
      }),
    ]);

  const claimRows = claimContext?.claims ?? [];
  const category = claimContext?.category ?? null;

  // ⚠️ `loadDealClaimContext` 는 **모든 status** 를 준다(관리 화면이 검토 대기도
  // 봐야 해서). 게이트·프롬프트에는 반드시 아래 두 함수를 거쳐 **승인분만**
  // 넣는다 — 원본 배열을 그대로 쓰면 PROPOSED(AI 추출 미검수)가 승인된 소구점처럼
  // 취급된다(C1 M3 가 막은 함정).
  const promptClaims = selectPromptClaims(claimRows);
  const gateClaims = toGateClaims(claimRows);

  const claims: GuideClaims = {
    approved: promptClaims.approved.map((c) => ({
      text: c.text,
      evidence: c.evidence,
      evidenceType: c.evidenceType,
    })),
    banned: promptClaims.banned.map((c) => c.text),
    disclosures: promptClaims.disclosures.map((c) => c.text),
  };

  /**
   * 같은 채널 셀러가 여럿이면 한 줄로 합친다 — 포맷 추천은 채널 단위이고,
   * 같은 채널을 반복해 넣으면 프롬프트만 길어진다. 팔로워는 최대값을 쓴다
   * (톤 판단 기준이 "이 채널에서 기대되는 반응 규모"이므로).
   */
  const sellersByChannel = new Map<string, GuideSellerChannel>();
  for (const row of sellerRows) {
    const existing = sellersByChannel.get(row.snsType);
    if (!existing || row.currentFollowers > existing.followers) {
      sellersByChannel.set(row.snsType, {
        snsType: row.snsType,
        followers: row.currentFollowers,
        category: row.category,
      });
    }
  }

  const { system, user } = buildContentGuidePrompt(
    kind,
    dealContext,
    refs,
    consumerVoc,
    claims,
    [...sellersByChannel.values()],
    previousDraft?.body ?? null,
  );

  // gemini-client의 maxOutputTokens에 2.5-flash thinking 토큰이 포함돼 출력이 잘리는
  // 케이스가 실측됨(#광고·주의사항 누락) — 8192로 넉넉히 상향(타이트 금지)하고,
  // 완전성 검사는 방어심층으로 유지한다. 속도 우선: 2개 생성을 동시에 발사해
  // 먼저 도착한 "완전한" 응답을 채택(Promise.any). 둘 다 불완전하면 부분 가이드를
  // 조용히 내보내지 않고 502로 명시한다(P0 — #광고는 공정위 표기).
  const attemptGuide = async (
    label: string,
  ): Promise<{ guide: string; gate: GateResult; model: string }> => {
    let result;
    try {
      result = await callGeminiWithTools(
        system,
        [{ role: "user", parts: [{ text: user }] }],
        [],
        { maxOutputTokens: 8192 },
      );
    } catch (err) {
      // Promise.any가 개별 거부를 삼키므로 throw 전에 각 시도의 실패를 남긴다(P0)
      console.error(`[content-guide] Gemini 호출 실패 (${label})`, {
        dealId: id,
        err,
      });
      throw err;
    }
    const guide = result.text.trim();
    const missing =
      guide.length === 0 ? ["(빈 응답)"] : findMissingGuideSections(guide, kind);
    if (missing.length > 0) {
      console.error(`[content-guide] 불완전 응답 (${label})`, {
        dealId: id,
        missing,
        guideLength: guide.length,
        usage: result.usage,
      });
      throw new IncompleteGuideError(missing);
    }

    // ── C1 게이트 (C3 M1) — 프롬프트 제약을 어긴 생성물을 여기서 잡는다.
    const gate = checkText(guide, {
      category,
      rules: activeRules,
      dealClaims: gateClaims,
    });
    if (gate.verdict === "BLOCK") {
      console.error(`[content-guide] 금지 표현 검출 (${label})`, {
        dealId: id,
        violations: gate.violations.map((v) => ({
          severity: v.severity,
          matched: v.matched,
          legalBasis: v.legalBasis,
        })),
      });
      throw new ClaimBlockedError(gate.violations);
    }
    // 모델명은 **채택된 시도의 것**을 쓴다(C3 §6 — 평가 루프가 모델 교체 전후를
    // 가른다). 두 레그가 같은 주모델을 요청하더라도 실제 서빙된 모델은 갈릴 수 있고
    // (gemini-client 가 응답의 modelVersion 을 우선한다), 폴백 사다리가 붙으면 레그마다
    // 달라진다 — 그래서 상수를 다시 읽지 않고 이긴 레그의 결과에서 가져온다.
    return { guide, gate, model: result.model };
  };

  try {
    const { guide, gate, model } = await Promise.any([
      attemptGuide("race-1"),
      attemptGuide("race-2"),
    ]);

    /**
     * 근거 카드는 **게이트 통과 후에** 붙인다 (C3 M2).
     *
     * 게이트는 **모델 생성물**을 검사하는 장치다. 승인된 클레임의 근거는 이미
     * 운영자가 승인한 값이므로, 그것 때문에 생성이 실패하면 앞뒤가 안 맞는다.
     * 그래서 검사 대상은 모델 출력이고, 근거 카드는 그 뒤에 조립해 덧붙인다.
     */
    const proofCard = buildProofCard(claims);
    const finalGuide = proofCard ? `${guide}\n\n${proofCard}` : guide;

    /**
     * 초안 스냅샷 — 딜당 1행 upsert (2026-08-01).
     *
     * ⛔ 종전 이 라우트는 **stateless** 였다(R4 스펙). 그래서 딜을 잠깐 바꿨다
     * 돌아오면 초안이 사라지고, 다시 누르면 **다른 결과**가 나왔다(모델 비결정성).
     * 재생성은 Gemini 2발이라 비용도 매번 든다. 오너 요청으로 최신 1건만 보존한다.
     *
     * ⚠️ **`DealAssetDraft`(보낸 자료)와 다른 테이블이다.** 저쪽은 감사 기록이고
     * `launch-readiness` 가 그 행의 존재로 "가이드를 보냈는가"를 판정한다 — 초안을
     * 거기 넣으면 안 보낸 것이 보냄 완료로 집힌다.
     *
     * ⚠️ **저장 실패가 생성을 깨뜨리지 않는다.** 초안은 편의 기능이고 본 산출물은
     * 응답이다 — 계측(`recordGeminiFailure`)과 같은 규율로 콘솔에만 남긴다.
     */
    try {
      const draftData = {
        body: finalGuide,
        gateVerdict: gate.verdict,
        claimIds: gateClaims.map((claim) => claim.id).join(",") || null,
        proofCardIncluded: proofCard !== null,
        model,
        referenceCount: refs.length,
        vocCount: consumerVoc.length,
      };
      await prisma.dealGuideDraft.upsert({
        where: { dealId_kind: { dealId: id, kind } },
        create: { dealId: id, kind, ...draftData },
        update: draftData,
      });
    } catch (draftErr) {
      console.error("[content-guide] 초안 스냅샷 저장 실패(생성은 정상):", {
        dealId: id,
        err: draftErr,
      });
    }

    return NextResponse.json({
      guide: finalGuide,
      referenceCount: refs.length,
      /**
       * 모델에 실제로 들어간 레퍼런스(좋아요 내림차순). 화면이 썸네일로 보여준다 —
       * 훅·포맷 추천이 무엇에서 나왔는지 추적 가능해야 운영자가 검수할 수 있다.
       * ⚠️ 캡션은 싣지 않는다. 프롬프트 재료일 뿐이고, 스크래핑 원문이라 화면에
       * 노출할 값이 아니다(셀러가 그대로 베낄 위험 — 프롬프트도 표절을 금한다).
       */
      references: referenceCards,
      vocCount: consumerVoc.length,
      // WARN 은 통과시키되 무엇이 걸렸는지 함께 준다 — 운영자가 판단한다(§4-2).
      gate: {
        verdict: gate.verdict,
        violations: gate.violations,
        missingDisclosures: gate.missingDisclosures,
      },
      /**
       * 승인 표현이 0건이면 모델 자유 생성이었다는 사실을 밝힌다
       * (오너 결정 §9-Q3 — 생성은 허용하되 숨기지 않는다).
       */
      claimGuided: claims.approved.length > 0,
      approvedClaimCount: claims.approved.length,
      /**
       * 근거 카드를 못 만든 경우를 숨기지 않는다 — 근거가 붙은 승인 소구점이
       * 없으면 셀러는 "왜 좋은지"를 설명할 재료 없이 콘텐츠를 만들게 되고,
       * 그 공백을 과장으로 메우는 것이 법령 리스크의 출발점이다(C3 §3).
       */
      proofCardIncluded: proofCard !== null,
      /**
       * 못 만든 **이유**까지 준다(§5) — `proofCardIncluded: false` 만으로는 운영자가
       * 할 일을 모른다. 승인 소구점이 없으면 **승인**을, 있는데 근거가 없으면
       * **근거 입력**을 해야 하는데 조치가 서로 다르다. 판정은 `buildProofCard` 와
       * 같은 입력을 쓰는 순수 함수가 한다(화면이 재추론하면 조건이 갈라진다).
       */
      proofCardAbsenceReason: explainProofCardAbsence(claims),
      /**
       * 채택분 저장(C3 M4)의 **출처 기록**. 스펙 §6 이 "생성에 쓰인 승인 클레임
       * id 목록 · 게이트 판정 · 모델명"을 요구하는 이유는 소구점 A/B 실험과 평가
       * 루프다 — "이 브리프가 어떤 표현을 근거로 만들어졌나"를 되짚을 수 없으면
       * 실험이 성립하지 않는다.
       *
       * ⚠️ **소급 복원이 안 되는 값이라 생성 시점에 실어 보낸다.** 승인 클레임
       * 집합은 그 뒤 승인·거절로 바뀌므로, 저장 시점에 DB 를 다시 읽으면 "그때
       * 무엇을 썼나"가 아니라 "지금 무엇이 승인돼 있나"가 된다.
       *
       * `DealAssetDraft` 는 컬럼이 이미 있었고 `asset-drafts` 라우트도 받게 돼
       * 있었는데 **아무도 보내지 않아 항상 null 이었다**(2026-07-31 실측) —
       * 스키마·라우트가 준비돼도 호출부가 안 채우면 데이터는 안 쌓인다.
       */
      claimIds: gateClaims.map((claim) => claim.id),
      model,
    });
  } catch (error) {
    // Promise.any는 두 시도 모두 거부됐을 때만 AggregateError로 떨어진다
    const causes = error instanceof AggregateError ? error.errors : [error];
    /**
     * 금지 표현을 **가장 먼저** 본다.
     *
     * 한 발은 Gemini 호출이 실패하고 다른 발은 게이트에 걸린 경우, 문제는 생성
     * 경로가 아니라 **내용**이다. 이때 502("생성 실패")를 돌려주면 운영자는
     * 무엇이 걸렸는지 모른 채 재시도만 반복하고 **같은 금지 표현에 계속 걸린다** —
     * 고칠 수 없는 것을 숨기는 응답이다. 그래서 검출 표현을 실은 422 가 우선이다.
     */
    const blocked = causes.find(
      (e): e is ClaimBlockedError => e instanceof ClaimBlockedError,
    );
    if (blocked) {
      return NextResponse.json(
        {
          error:
            "생성물에 금지 표현이 포함돼 내보내지 않았습니다. 딜 표현 관리에서 승인 소구점을 보강한 뒤 다시 시도해주세요.",
          violations: blocked.violations,
        },
        { status: 422 },
      );
    }

    const geminiError = causes.find(
      (e): e is GeminiClientError => e instanceof GeminiClientError,
    );
    if (geminiError) {
      console.error(
        "[POST /api/deals/[id]/content-guide] Gemini 호출 실패:",
        geminiError,
      );
      return NextResponse.json(
        { error: `가이드 생성에 실패했습니다: ${geminiError.message}` },
        { status: 502 },
      );
    }

    const missing = [
      ...new Set(
        causes.flatMap((e) =>
          e instanceof IncompleteGuideError ? e.missing : [],
        ),
      ),
    ];
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `가이드가 완성되지 못했습니다(누락: ${missing.join(", ")}). 다시 시도해주세요.`,
        },
        { status: 502 },
      );
    }
    console.error(
      "[POST /api/deals/[id]/content-guide] 예기치 못한 오류:",
      error,
    );
    return NextResponse.json(
      { error: "가이드 생성 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}

/**
 * GET /api/deals/[id]/content-guide
 * 저장된 **초안 스냅샷**을 돌려준다. 없으면 `{ draft: null }`.
 *
 * 왜 필요한가: 생성은 Gemini 2발이고 모델은 비결정적이라, 딜을 잠깐 바꿨다 돌아왔을 때
 * 재생성하면 **다른 초안**이 나온다. 운영자가 방금 검수하던 것을 잃는다.
 *
 * ⚠️ **`dealChangedAfter` 를 함께 준다.** 초안 저장 후 딜 정보(가격·구성 등)가 바뀌었으면
 * 그 초안은 낡은 근거로 쓰인 것이다. 화면이 시각으로만 판단하면 "3일 전"이 낡았는지
 * 알 수 없다 — 임의의 일수 문턱 대신 **딜이 그 뒤 실제로 바뀌었는가**라는 사실을 준다.
 */
export async function GET(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const kind = resolveGuideKind(request);
  if (kind === null) return INVALID_KIND_RESPONSE();

  const { id } = await context.params;
  const prisma = getPrisma();

  const [draft, deal, existingKinds] = await Promise.all([
    prisma.dealGuideDraft.findUnique({
      where: { dealId_kind: { dealId: id, kind } },
      select: {
        body: true,
        gateVerdict: true,
        claimIds: true,
        proofCardIncluded: true,
        model: true,
        referenceCount: true,
        vocCount: true,
        sketches: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.deal.findUnique({ where: { id }, select: { updatedAt: true } }),
    /**
     * 이 딜에 **어느 유형의 초안이 존재하는가** — 화면의 유형 탭이 "생성됨/미생성"을
     * 표시하는 근거다.
     *
     * 왜 여기서 함께 주는가: 탭마다 상태를 보이려면 비활성 유형의 존재도 알아야
     * 하는데, 그걸 위해 화면이 GET 을 유형 수만큼 호출하면 **딜을 열 때마다** 게이트
     * 재계산(클레임 조회 + 금지어 사전 전량)이 배로 든다. 존재 여부만 필요하므로
     * `kind` 열 하나짜리 조회 1건을 얹는 쪽이 압도적으로 싸다.
     */
    prisma.dealGuideDraft.findMany({
      where: { dealId: id },
      select: { kind: true },
    }),
  ]);

  /** 알 수 없는 값이 DB 에 있어도 화면 어휘 밖으로 새지 않게 거른다. */
  const availableKinds = existingKinds
    .map((row) => row.kind)
    .filter(isGuideKind);

  if (!draft) return NextResponse.json({ draft: null, availableKinds });

  /**
   * 표현 검사는 **저장값을 쓰지 않고 다시 계산한다.**
   *
   * 저장돼 있는 건 생성 시점의 판정 문자열(`gateVerdict`)뿐이라 지적 목록이 없고,
   * 무엇보다 **금지어 사전(`BannedPhraseRule`)과 딜 클레임은 그 뒤에 바뀔 수 있다.**
   * 낡은 판정을 되살리면 "지금 이 문안을 보내도 되는가"라는 물음에 어제 답을 준다.
   * `checkText` 는 순수 함수라 비용도 조회 2건뿐이다.
   */
  const [claimContext, activeRules] = await Promise.all([
    loadDealClaimContext(id),
    prisma.bannedPhraseRule.findMany({
      where: { active: true },
      select: {
        id: true,
        phrase: true,
        pattern: true,
        category: true,
        severity: true,
        legalBasis: true,
        note: true,
      },
    }),
  ]);
  const gate = checkText(draft.body, {
    category: claimContext?.category ?? null,
    rules: activeRules,
    dealClaims: toGateClaims(claimContext?.claims ?? []),
  });

  return NextResponse.json({
    availableKinds,
    draft: {
      body: draft.body,
      /** 지금 기준 재판정 — 화면의 지적 strip 이 이 값을 쓴다. */
      gate: {
        verdict: gate.verdict,
        violations: gate.violations,
        missingDisclosures: gate.missingDisclosures,
      },
      /** 재판정 결과. 저장된 생성 시점 값(`draft.gateVerdict`)은 감사용이라 안 쓴다. */
      gateVerdict: gate.verdict,
      // 저장은 쉼표 문자열, 화면·재저장은 배열 — 경계에서 한 번만 변환한다.
      claimIds: draft.claimIds ? draft.claimIds.split(",").filter(Boolean) : [],
      proofCardIncluded: draft.proofCardIncluded,
      model: draft.model,
      referenceCount: draft.referenceCount,
      vocCount: draft.vocCount,
      /** 저장된 촬영 컷 시안 — 복원 시 프레임에 그대로 다시 채운다(재생성 비용 0). */
      sketches: parseStoredSketches(draft.sketches),
      /** 초안이 만들어진(마지막으로 갱신된) 시각 — 화면이 "N일 전"으로 쓴다. */
      savedAt: draft.updatedAt.toISOString(),
      /** 이 초안 이후 딜이 바뀌었는가 = 근거가 낡았는가. */
      dealChangedAfter: deal ? deal.updatedAt > draft.updatedAt : false,
    },
  });
}
