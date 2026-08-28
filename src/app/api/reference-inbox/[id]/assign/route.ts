import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/prisma-errors";
import { findDuplicateAsset } from "@/lib/reference-inbox";
import { revalidateCrmTags, ASSET_INVALIDATION_TAGS } from "@/lib/cache-tags";

type Context = {
  params: Promise<{ id: string }>;
};

const bodySchema = z.object({
  dealId: z.string().min(1),
});

/**
 * POST /api/reference-inbox/[id]/assign — 딜 배정(Asset 승격 + 인박스 아이템 삭제).
 *
 * 원자성: prisma.$transaction 안에서 조회→중복판정→(Asset 생성)→아이템 삭제를 한 번에 처리한다.
 * /api/assets를 HTTP로 재호출하지 않는다(트랜잭션 경계를 넘으면 원자성이 깨지므로 asset.create를
 * 트랜잭션 내에서 직접 호출). Asset은 R1 외부링크 경로와 동일하게
 * provider=EXTERNAL_LINK, section=SNS_CREATIVE, externalUrl=normalizedUrl로 만든다.
 *
 * 중복 승격 방지: 같은 딜(entityType=DEAL, entityId=dealId)에 같은 externalUrl Asset이 이미 있으면
 * Asset을 새로 만들지 않고 인박스 아이템만 삭제하고 alreadyExists=true로 응답한다.
 * DB 방어선(H1): 부분 유니크 인덱스 위반(P2002)은 tx 바깥 catch에서 alreadyExists로 폴백한다
 * — 이때 트랜잭션 전체 롤백으로 claim이 복원되어 아이템은 PENDING으로 남는다(아래 catch 주석).
 */
export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;

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
  const { dealId } = parsed.data;

  const prisma = getPrisma();

  // 배정 대상 딜 존재 확인(없는 딜에 승격하면 고아 Asset이 생기므로 선제 차단).
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true } });
  if (!deal) {
    return NextResponse.json({ error: "대상 딜을 찾을 수 없습니다." }, { status: 404 });
  }

  const uploadedBy = auth.context.userId;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.referenceInboxItem.findUnique({ where: { id } });
      if (!item) {
        return { kind: "not_found" as const };
      }
      if (item.status !== "PENDING") {
        return { kind: "conflict" as const };
      }

      // 같은 딜에 같은 externalUrl(normalizedUrl) Asset이 이미 있는지 확인(중복 승격 방지).
      const existingAssets = await tx.asset.findMany({
        where: {
          entityType: "DEAL",
          entityId: dealId,
          externalUrl: item.normalizedUrl,
          archivedAt: null,
        },
        select: { id: true, externalUrl: true },
      });
      const duplicate = findDuplicateAsset(existingAssets, item.normalizedUrl);

      if (duplicate) {
        // Asset 생성 생략 — 인박스 아이템만 조건부 삭제(status=PENDING)로 원자적으로 잡는다.
        // count===0이면 다른 요청이 방금 처리한 것이므로 conflict로 빠진다(중복 성공 응답 방지).
        const claimedDup = await tx.referenceInboxItem.deleteMany({
          where: { id, status: "PENDING" },
        });
        if (claimedDup.count === 0) {
          return { kind: "conflict" as const };
        }
        return { kind: "duplicate" as const, assetId: duplicate.id };
      }

      // 핵심(동시성): asset.create 직전에 아이템을 원자적으로 claim한다.
      // 조건부 WHERE(status=PENDING)가 대상 행에 배타 락을 걸어 동시 트랜잭션을 직렬화하므로,
      // 두 번째 트랜잭션은 첫 커밋 후 count===0을 보고 conflict로 빠져 asset.create에 도달하지
      // 않는다(같은 딜 중복 Asset 원천 차단). claim(deleteMany)은 반드시 create 앞에 둔다.
      const claimed = await tx.referenceInboxItem.deleteMany({
        where: { id, status: "PENDING" },
      });
      if (claimed.count === 0) {
        return { kind: "conflict" as const };
      }

      const asset = await tx.asset.create({
        data: {
          provider: "EXTERNAL_LINK",
          section: "SNS_CREATIVE",
          entityType: "DEAL",
          entityId: dealId,
          fileName: item.linkName,
          externalUrl: item.normalizedUrl,
          notes: item.note ?? undefined,
          uploadedBy,
        },
      });
      return { kind: "created" as const, assetId: asset.id };
    });

    if (result.kind === "not_found") {
      return NextResponse.json(
        { error: "해당 인박스 항목을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    if (result.kind === "conflict") {
      return NextResponse.json(
        { error: "이미 처리된 인박스 항목입니다." },
        { status: 409 },
      );
    }

    revalidateCrmTags(ASSET_INVALIDATION_TAGS);
    return NextResponse.json({
      ok: true,
      assetId: result.assetId,
      ...(result.kind === "duplicate" ? { alreadyExists: true } : {}),
    });
  } catch (error) {
    // H1: 부분 유니크 인덱스(Asset_entity_externalUrl_active_key) 위반(P2002)은 반드시
    // "tx 바깥"인 여기서 잡는다. P2002가 tx 안에서 throw되면 트랜잭션 전체가 롤백되어
    // claim(deleteMany)도 되살아난다 — 즉 인박스 아이템은 PENDING으로 남는다(sqlite 실증:
    // 롤백 후 아이템 재조회 성공 + 재시도 시 duplicate 경로로 아이템 삭제까지 수렴 확인).
    // 여기서는 경쟁 요청(다른 라우트 포함)이 방금 만든 기존 활성 Asset을 재조회해
    // alreadyExists로 응답하고, 아이템은 재시도 가능 상태로 남긴다 — 다음 assign 시도가
    // duplicate 경로(아이템만 삭제)로 자연 정리한다.
    if (isUniqueViolation(error)) {
      const item = await prisma.referenceInboxItem.findUnique({
        where: { id },
        select: { normalizedUrl: true },
      });
      const existing = item
        ? await prisma.asset.findFirst({
            where: {
              entityType: "DEAL",
              entityId: dealId,
              externalUrl: item.normalizedUrl,
              archivedAt: null,
            },
            select: { id: true },
          })
        : null;
      if (existing) {
        return NextResponse.json({ ok: true, assetId: existing.id, alreadyExists: true });
      }
      // 기존 활성 Asset을 못 찾으면(승자가 그새 보관되는 등) 폴백하지 않고 아래 500으로
      // 노출한다 — 아이템이 남아 있으므로 재시도 가능하다.
    }
    // P0: 실패를 삼키지 않고 노출한다. 트랜잭션은 위 throw 시 전체 롤백된다.
    console.error("[/api/reference-inbox/[id]/assign] assign failed:", error);
    return NextResponse.json({ error: "배정에 실패했습니다." }, { status: 500 });
  }
}
