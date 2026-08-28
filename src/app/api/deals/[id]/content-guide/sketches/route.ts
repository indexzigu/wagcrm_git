import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import {
  parseGuideSections,
  DEFAULT_GUIDE_KIND,
  isGuideKind,
  type GuideKind,
} from "@/lib/content-guide";
import {
  planSketches,
  classifySketchFailure,
  SketchStepError,
  type SketchFailure,
  mergeSketches,
  buildSketchPrompt,
  cutSketchKey,
  parseStoredSketches,
  sketchStoragePath,
  MAX_SKETCHES_PER_GUIDE,
  type GuideSketch,
  type SketchProduct,
} from "@/lib/guide-sketch";
import { generateSketchImage } from "@/lib/agent/gemini-image";
import {
  isSellerMediaStorageConfigured,
  publicMediaUrl,
  uploadBytes,
} from "@/lib/seller-analysis/seller-media-storage";

// 이미지 최대 8장(`MAX_SKETCHES_PER_GUIDE`)을 병렬로 그린다 — 장당 수 초라 장수를
// 늘려도 벽시계는 거의 그대로다. 텍스트 라우트(300)보다는 짧게 잡는다.
export const maxDuration = 180;

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/deals/[id]/content-guide/sketches
 *
 * 저장된 초안의 촬영 컷마다 **구도 스케치**를 그려 프레임에 채운다.
 *
 * 왜 별도 라우트인가: 텍스트 가이드를 이미지가 끝날 때까지 붙잡아 두지 않기 위해서다.
 * 화면은 가이드를 **먼저 렌더**하고(점선 프레임이 그대로 자리표시자가 된다) 이 라우트를
 * 이어서 부른다. 실패해도 프레임은 지금 모습 그대로라 기능이 깨지지 않는다.
 *
 * ⚠️ **컷은 클라이언트가 보낸 값을 믿지 않고 저장된 초안에서 다시 파싱한다.**
 * 그리는 대상이 곧 비용이라, 입력을 그대로 받으면 임의 문자열로 이미지를 뽑는 통로가 된다.
 *
 * 비용 설계: 컷 키(`cutSketchKey`)로 캐시한다 — 초안을 다시 생성해도 컷이 그대로면
 * 이미지 호출이 **0건**이다. 폭주 차단은 `MAX_SKETCHES_PER_GUIDE` 한 곳.
 */
export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  // 유형 판정 규칙은 텍스트 라우트와 같다 — 미지의 값은 삼키지 않는다(오타가 조용히
  // 셀러형으로 떨어지면 남의 초안에 시안을 덮어쓴다).
  const rawKind = new URL(request.url).searchParams.get("kind");
  let kind: GuideKind;
  if (rawKind === null || rawKind === "") kind = DEFAULT_GUIDE_KIND;
  else if (isGuideKind(rawKind)) kind = rawKind;
  else {
    return NextResponse.json(
      { error: "알 수 없는 가이드 유형입니다." },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  const prisma = getPrisma();

  if (!isSellerMediaStorageConfigured()) {
    // 저장할 곳이 없으면 그리지 않는다 — 그려 놓고 버리면 돈만 나간다.
    return NextResponse.json(
      { error: "이미지 저장소가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  // 상품 정체를 그림에 넣기 위해 딜을 함께 읽는다. 없으면 모델이 카테고리를
  // 지어낸다 — 쥬얼리 딜 시안에 화장품이 그려진 실사고(2026-08-02)가 그 결과다.
  const [draft, deal] = await Promise.all([
    prisma.dealGuideDraft.findUnique({
      where: { dealId_kind: { dealId: id, kind } },
      select: { body: true, sketches: true },
    }),
    prisma.deal.findUnique({
      where: { id },
      select: { dealName: true, category: true },
    }),
  ]);
  if (!draft) {
    return NextResponse.json(
      { error: "저장된 초안이 없습니다. 가이드를 먼저 생성하세요." },
      { status: 404 },
    );
  }

  const cuts = parseGuideSections(draft.body)
    .flatMap((section) => section.lines)
    .map((line) => line.cut)
    .filter((cut): cut is NonNullable<typeof cut> => cut !== null);

  if (cuts.length === 0) {
    // 컷이 없는 초안은 정상이다(모델이 형식을 안 지켰거나 채널이 카톡뿐인 경우) —
    // 오류가 아니라 "그릴 게 없음"으로 답한다.
    return NextResponse.json({
      sketches: [],
      drawn: 0,
      reused: 0,
      skippedKeys: [],
      failures: [],
    });
  }

  const stored = parseStoredSketches(draft.sketches);
  const plan = planSketches(cuts, stored, MAX_SKETCHES_PER_GUIDE, kind);
  // 딜이 지워진 뒤 초안만 남은 경우에도 그리기는 계속한다 — 상품명이 없을 뿐이다.
  const product: SketchProduct = {
    name: deal?.dealName ?? "the product in this campaign",
    category: deal?.category ?? null,
  };

  /**
   * 컷 하나가 실패해도 나머지는 그린다(`allSettled`). 부분 성공이 정상 결과다 —
   * 한 장 실패로 전부 버리면 이미 쓴 돈까지 버리는 셈이다.
   */
  const results = await Promise.allSettled(
    plan.toDraw.map(async (cut): Promise<GuideSketch> => {
      const key = cutSketchKey(cut, kind);
      // 단계를 태그해 던진다 — 같은 오류 문자열이라도 "그리기 실패"와 "저장 실패"는
      // 운영자가 할 일이 다르다(전자는 모델·한도, 후자는 인프라).
      let image;
      try {
        image = await generateSketchImage(buildSketchPrompt(cut, product));
      } catch (err) {
        throw new SketchStepError("GENERATE", err);
      }
      try {
        const path = sketchStoragePath(id, key, kind);
        await uploadBytes(path, image.bytes, image.mimeType);
        return { key, url: publicMediaUrl(path) };
      } catch (err) {
        throw new SketchStepError("UPLOAD", err);
      }
    }),
  );

  const drawn: GuideSketch[] = [];
  const failures: SketchFailure[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      drawn.push(r.value);
      continue;
    }
    const failedCut = plan.toDraw[i];
    if (!failedCut) continue;
    // 어느 컷이 **왜** 실패했는지까지 남긴다 — 키만으로는 화면이 "실패"밖에 못 쓰고
    // 그러면 운영자가 다음에 뭘 해야 하는지 알 수 없다(오너 지적 2026-08-01).
    const step = r.reason instanceof SketchStepError ? r.reason.step : "GENERATE";
    const cause = r.reason instanceof SketchStepError ? r.reason.cause : r.reason;
    failures.push({
      key: cutSketchKey(failedCut, kind),
      reason: classifySketchFailure(step, cause),
    });
    // 원문은 서버 로그·ApiCallLog 에만 남긴다 — 화면에는 분류 라벨만 간다(P0:
    // 오류 본문에 요청 URL(`?key=`)이 에코될 수 있다).
    console.error("[guide-sketch] 컷 시안 생성 실패", {
      dealId: id,
      cut: failedCut.no,
      step,
      err: cause,
    });
  }

  const sketches = mergeSketches(cuts, plan.reused, drawn, kind);

  // 저장 실패가 이미 그린 그림을 무의미하게 만들지 않도록, 쓰기는 마지막에 한 번만.
  await prisma.dealGuideDraft.update({
    where: { dealId_kind: { dealId: id, kind } },
    data: { sketches: JSON.stringify(sketches) },
  });

  return NextResponse.json({
    sketches,
    drawn: drawn.length,
    reused: plan.reused.length,
    skippedKeys: plan.skippedKeys,
    failures,
  });
}
