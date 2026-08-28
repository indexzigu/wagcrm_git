import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { recordCampaignActivity } from "@/lib/campaign-activity";
import { selectPromoteCopyFields } from "@/lib/campaign-content";
import { isSerializationConflict, isUniqueViolation } from "@/lib/prisma-errors";
import { findDuplicateAsset } from "@/lib/reference-inbox";
import { revalidateCrmTags, ASSET_INVALIDATION_TAGS } from "@/lib/cache-tags";

type Context = {
  params: Promise<{ id: string }>;
};

const bodySchema = z.object({
  assetId: z.string().min(1),
});

type PromoteTxResult =
  | { kind: "asset_not_found" }
  | { kind: "not_link" }
  | { kind: "duplicate"; assetId: string }
  | { kind: "created"; assetId: string; fileName: string };

/**
 * POST /api/campaigns/[id]/promote-content — 캠페인 셀러 게시물을 딜 레퍼런스로 복사(R5).
 *
 * 흐름: 캠페인 dealId 확인(연결 딜 없으면 400) → [트랜잭션] 자산 소속 검증 → 같은 딜에 동일
 * externalUrl Asset이 이미 있으면 alreadyExists=true(에러 아님, R2a assign의 중복 승격 방지
 * 계약과 동일) → 아니면 Asset 복제 생성(entityType=DEAL, entityId=dealId,
 * thumbnailUrl·notes·fileName 복사). 원본 캠페인 Asset은 건드리지 않는다(링크 재등록일 뿐).
 *
 * 동시성(TOCTOU): 중복판정(findMany)과 create를 Serializable 트랜잭션으로 묶고, DB 방어선으로
 * H1 부분 유니크 인덱스(Asset_entity_externalUrl_active_key — 활성+externalUrl 행 한정)가 있다.
 * 동시 요청이 충돌하면 진 쪽이 P2034(직렬화) 또는 P2002(유니크 위반)로 실패하므로, 바깥에서
 * 재조회해 기존 Asset이 있으면 alreadyExists 200으로 폴백(에러 아님)하고 없으면 1회 재시도한다.
 * sqlite(로컬 검증)는 단일 라이터라 자연 직렬화되고 Serializable이 sqlite의 유일한 격리
 * 수준이라 provider 분기 불필요(부분 인덱스는 sqlite push 경로에 없어 앱 레벨 방어가 커버).
 */
export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: campaignId } = await context.params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { assetId } = parsed.data;

  const prisma = getPrisma();
  const uploadedBy = auth.context.userId;

  try {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, dealId: true },
    });
    if (!campaign) {
      return NextResponse.json({ error: "캠페인을 찾을 수 없습니다." }, { status: 404 });
    }

    // dealId가 비었거나 참조 딜이 실제로 없으면(데이터 드리프트 포함) 복사 대상 딜이 없다 → 400.
    const deal = campaign.dealId
      ? await prisma.deal.findUnique({
          where: { id: campaign.dealId },
          select: { id: true },
        })
      : null;
    if (!deal) {
      return NextResponse.json(
        { error: "캠페인에 연결된 딜이 없어 레퍼런스로 복사할 수 없습니다." },
        { status: 400 },
      );
    }
    const dealId = deal.id;

    // 자산 소속 검증 조회부터 create까지 전부 트랜잭션 내부(tx 클라이언트 일관 사용).
    const runPromote = () =>
      prisma.$transaction(
        async (tx): Promise<PromoteTxResult> => {
          const asset = await tx.asset.findUnique({ where: { id: assetId } });
          if (!asset || asset.entityType !== "CAMPAIGN" || asset.entityId !== campaignId) {
            return { kind: "asset_not_found" };
          }

          const copy = selectPromoteCopyFields(asset);
          if (!copy) {
            return { kind: "not_link" };
          }

          // 같은 딜에 같은 externalUrl Asset이 이미 있으면 새로 만들지 않는다(중복 생성 방지 — 에러 아님).
          const existingAssets = await tx.asset.findMany({
            where: {
              entityType: "DEAL",
              entityId: dealId,
              externalUrl: copy.externalUrl,
              archivedAt: null,
            },
            select: { id: true, externalUrl: true },
          });
          const duplicate = findDuplicateAsset(existingAssets, copy.externalUrl);
          if (duplicate) {
            return { kind: "duplicate", assetId: duplicate.id };
          }

          // R2a assign 승격 경로와 동일한 규약: provider=EXTERNAL_LINK, section=SNS_CREATIVE.
          // thumbnailUrl·notes는 R3 보강 결과를 그대로 물려받아 R4 콘텐츠 가이드 재료가 된다.
          const created = await tx.asset.create({
            data: {
              provider: "EXTERNAL_LINK",
              section: "SNS_CREATIVE",
              entityType: "DEAL",
              entityId: dealId,
              fileName: copy.fileName,
              externalUrl: copy.externalUrl,
              thumbnailUrl: copy.thumbnailUrl ?? undefined,
              notes: copy.notes ?? undefined,
              uploadedBy,
            },
          });
          return { kind: "created", assetId: created.id, fileName: created.fileName };
        },
        { isolationLevel: "Serializable" },
      );

    let result: PromoteTxResult;
    try {
      result = await runPromote();
    } catch (error) {
      if (!isSerializationConflict(error) && !isUniqueViolation(error)) throw error;
      // P2034(직렬화 충돌) 또는 P2002(H1 부분 유니크 인덱스 위반 — 다른 라우트와의 경쟁 포함):
      // 경쟁 요청이 방금 커밋했을 가능성이 높다 — 재조회해서
      // 같은 딜에 동일 externalUrl Asset이 이미 있으면 alreadyExists로 폴백(에러 아님).
      // P2002는 tx 안 create에서 나더라도 여기(tx 바깥)서 잡으므로 트랜잭션은 전체 롤백된
      // 상태다(부분 커밋 없음).
      const sourceAsset = await prisma.asset.findUnique({
        where: { id: assetId },
        select: { externalUrl: true },
      });
      const externalUrl = sourceAsset?.externalUrl ?? null;
      const winner = externalUrl
        ? findDuplicateAsset(
            await prisma.asset.findMany({
              where: { entityType: "DEAL", entityId: dealId, externalUrl, archivedAt: null },
              select: { id: true, externalUrl: true },
            }),
            externalUrl,
          )
        : null;
      if (winner) {
        return NextResponse.json({ ok: true, alreadyExists: true, assetId: winner.id });
      }
      // 기존 Asset이 없으면(경쟁이 이 URL 생성으로 끝나지 않은 경우) 1회 재시도.
      result = await runPromote();
    }

    if (result.kind === "asset_not_found") {
      return NextResponse.json(
        { error: "해당 캠페인의 자산을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    if (result.kind === "not_link") {
      return NextResponse.json(
        { error: "외부 링크 자산만 딜 레퍼런스로 복사할 수 있습니다." },
        { status: 400 },
      );
    }
    if (result.kind === "duplicate") {
      return NextResponse.json({ ok: true, alreadyExists: true, assetId: result.assetId });
    }

    // 캠페인 타임라인 기록 — /api/assets POST의 recordCampaignActivity 패턴 재사용
    // (action은 자유 문자열이나 신규 타입 발명 금지 규칙에 따라 기존 ASSET_LINKED 재사용).
    await recordCampaignActivity({
      campaignId,
      action: "ASSET_LINKED",
      label: "Reference promoted",
      details: `딜 레퍼런스로 복사 · ${result.fileName}`,
    });

    revalidateCrmTags(ASSET_INVALIDATION_TAGS);
    return NextResponse.json({ ok: true, assetId: result.assetId }, { status: 201 });
  } catch (error) {
    // P0: 실패를 삼키지 않고 노출한다. 트랜잭션은 throw 시 전체 롤백된다.
    console.error("[/api/campaigns/[id]/promote-content] promote failed:", error);
    return NextResponse.json(
      { error: "딜 레퍼런스 복사에 실패했습니다." },
      { status: 500 },
    );
  }
}
