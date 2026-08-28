import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getAuthContext } from "@/lib/auth-context";
import { getPrisma } from "@/lib/prisma";
import { PriceSheetRepository } from "@/repositories/priceSheetRepository";
import { applyPriceSheet, ApplyExecutorError } from "@/lib/price-sheet/apply-executor";
import { normalizePriceSheetForResponse } from "@/lib/price-sheet/serialize-response";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";

// 공백만 있는 값은 .min(1)을 통과하지만 딜명으로 저장되면 "   " 같은 유령 딜과
// "    - 제품A" 같은 옵션명이 나온다 — trim 후 빈 문자열이면 거부하고, 저장값도 trim된
// 값으로 정규화한다(클라이언트 가드가 trim 후 검사만 하고 원본을 그대로 보내는 경로 방지).
const trimmedNonEmptyString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: "필수 입력값입니다." });

const bundleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NEW"), parentDealName: trimmedNonEmptyString }),
  z.object({
    kind: z.literal("EXISTING"),
    dealId: z.string().min(1),
    // 아래 세 값은 클라이언트 표시용이며 서버가 DB 값으로 덮어쓴다(신뢰하지 않는다).
    // parentDealName은 NEW.parentDealName과 달리 .min(1)을 걸지 않는다 — 의도적이다:
    // 이 값은 route.ts의 가드가 항상 parent.dealName으로 치환하므로 내용은 무관하다.
    parentDealName: z.string(),
    parentBrandName: z.string().nullable(),
    parentPartnerId: z.string().nullable(),
  }),
]);

// 검수 화면이 확인·수정한 그룹별 브랜드·거래처(키 = grouping.ts의 groupKey).
// 본문 자체가 없어도 동작해야 한다(어시스턴트 등 기존 호출부 하위호환) — 그 경우
// 서버 기본값(브랜드=제품명 추출, 거래처=시트 거래처)이 적용된다.
const applyBodySchema = z.object({
  groupOverrides: z
    .record(
      z.string(),
      z.object({
        brandName: z.string().nullable().optional(),
        partnerId: z.string().nullable().optional(),
      })
    )
    .optional(),
  // 시트 단위 반영 방식. 미전달 = AUTO(기존 호출부 하위호환).
  bundle: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("AUTO") }),
      z.object({
        mode: z.literal("BUNDLE"),
        target: bundleTargetSchema,
        excludedRowIds: z.array(z.string()).default([]),
      }),
    ])
    .optional(),
});

/**
 * 검수 승인 = 반영 실행. ActionProposal(WRITE,'price_sheet_apply')을 DRAFT부터
 * EXECUTED까지 한 요청 안에서 순차 전이시킨다(apply-executor.ts).
 *
 * M2: 서버측 멱등 가드.
 * ① priceSheet.status === "APPLIED"면 이미 반영이 끝난 요청이므로 즉시 409.
 * ② 동시 요청 방어: updateMany({ where: { status: { notIn: [APPLIED, APPLYING] } } })의
 *    count로 CAS(compare-and-swap)한다 — count===0이면 이미 다른 요청이 반영 중이거나
 *    끝났다는 뜻이므로 409. count===1이면 이 요청만이 "APPLYING" 선점에 성공한 것이다.
 * ③ 반영된 행의 mappingStatus를 종료 상태 "APPLIED"로 전이해 재조회(다음 apply 시도의
 *    MAPPED/NEW_DEAL 조회) 대상에서 제외한다(buildApplyActionForRow는 애초에
 *    MAPPED/NEW_DEAL만 액션으로 변환하므로 APPLIED 행은 자연히 skip된다).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;

  // 본문 없는 POST(기존 호출부)도 허용 — JSON 파싱 실패는 빈 본문으로 간주한다.
  const rawBody = await request.json().catch(() => ({}));
  const parsedBody = applyBodySchema.safeParse(rawBody ?? {});
  if (!parsedBody.success) {
    return NextResponse.json({ error: parsedBody.error.flatten() }, { status: 400 });
  }
  const groupOverrides = parsedBody.data.groupOverrides;
  const prisma = getPrisma();
  const priceSheet = await PriceSheetRepository.findById(id, false);
  if (!priceSheet) {
    return NextResponse.json({ error: "가격표를 찾을 수 없습니다." }, { status: 404 });
  }

  if (priceSheet.status === "APPLIED") {
    return NextResponse.json({ error: "이미 반영된 가격표입니다" }, { status: 409 });
  }

  // 묶음 대상이 기존 딜이면 서버가 DB에서 재해석한다 — 클라이언트가 보낸 이름·브랜드·
  // 거래처를 그대로 믿으면 화면 표시와 실제 부모가 갈릴 수 있고, 2단 중첩도 통과한다.
  let bundle = parsedBody.data.bundle;
  if (bundle?.mode === "BUNDLE" && bundle.target.kind === "EXISTING") {
    const parent = await prisma.deal.findUnique({
      where: { id: bundle.target.dealId },
      select: {
        id: true,
        dealName: true,
        brandName: true,
        partnerId: true,
        parentDealId: true,
        dealType: true,
      },
    });
    if (!parent) {
      return NextResponse.json({ error: "지정한 상위딜을 찾을 수 없습니다." }, { status: 400 });
    }
    // parentDealId만 보면 dealType:"OPTION" + parentDealId:null인(현재 코드로는 생성되지
    // 않지만 조작된 요청으로는 가능한) 행이 통과한다 — dealType:"MAIN"까지 함께 확인한다.
    if (parent.parentDealId || parent.dealType !== "MAIN") {
      return NextResponse.json(
        { error: "하위품목딜에는 다시 하위품목을 붙일 수 없습니다. 상위딜을 선택하세요." },
        { status: 400 }
      );
    }
    bundle = {
      ...bundle,
      target: {
        kind: "EXISTING",
        dealId: parent.id,
        parentDealName: parent.dealName,
        parentBrandName: parent.brandName,
        parentPartnerId: parent.partnerId,
      },
    };
  }

  const authCtx = await getAuthContext();
  const actor = authCtx?.email ?? "SYSTEM";

  // CAS: APPLIED/APPLYING이 아닌 상태에서만 APPLYING으로 선점한다. count===0이면 그 사이
  // 다른 요청이 먼저 선점했거나 이미 반영을 끝냈다는 뜻 — 동시 요청 방어.
  const previousStatus = priceSheet.status;
  const claim = await prisma.priceSheet.updateMany({
    where: { id, status: { notIn: ["APPLIED", "APPLYING"] } },
    data: { status: "APPLYING" },
  });

  if (claim.count === 0) {
    return NextResponse.json({ error: "이미 반영 중이거나 반영이 완료된 가격표입니다." }, { status: 409 });
  }

  const rows = await prisma.priceSheetRow.findMany({
    where: {
      priceSheetId: id,
      mappingStatus: { in: ["MAPPED", "NEW_DEAL"] },
    },
  });

  if (rows.length === 0) {
    // 선점했던 APPLYING을 원래 상태로 되돌린다(가드가 상태를 갈아치운 채로 끝나면 안 됨).
    await prisma.priceSheet.update({ where: { id }, data: { status: previousStatus } });
    return NextResponse.json(
      { error: "반영할 매핑 확정 행이 없습니다 (검수표에서 MAPPED/NEW_DEAL로 확정한 행이 필요합니다)." },
      { status: 409 }
    );
  }

  try {
    const { proposal, results } = await applyPriceSheet({
      priceSheetId: id,
      partnerId: priceSheet.partnerId,
      actor,
      rows,
      groupOverrides,
      bundle,
    });

    // 반영된 행을 종료 상태 APPLIED로 전이 — 다음 apply 재조회(MAPPED/NEW_DEAL) 대상에서 제외.
    await prisma.priceSheetRow.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { mappingStatus: "APPLIED" },
    });

    const updatedSheet = await PriceSheetRepository.updateStatus(id, "APPLIED", {
      reviewedBy: actor,
      reviewedAt: new Date(),
    });

    // 딜 목록(getCachedDealsPageData = crm:deals 태그) 캐시 무효화 — 반영은 tx.deal.create로
    // 딜을 직접 만들어 /api/deals POST의 revalidate 경로를 안 타므로, 여기서 명시적으로 깬다.
    // 누락 시 "반영 완료"는 뜨는데 딜 관리 목록에 새 딜이 안 보이는 사고가 난다(오너 실보고).
    revalidateMasterDataCaches();

    // rowCount = 반영한 품목(행) 수 = 검수 모달의 rows.length와 일치. results.length는 실제
    // 생성/수정된 딜 수로, 그룹핑 시 상위딜이 추가되어 rowCount보다 클 수 있다(둘을 구분해 반환).
    return NextResponse.json({
      priceSheet: normalizePriceSheetForResponse(updatedSheet),
      proposal,
      results,
      rowCount: rows.length,
    });
  } catch (err) {
    const message = err instanceof ApplyExecutorError ? err.message : "가격표 반영 중 오류가 발생했습니다.";
    console.error(`[POST /api/price-sheets/${id}/apply] Error:`, err);
    // 실행 실패 — CAS로 선점했던 APPLYING을 원래 상태로 복원해 재시도 가능하게 한다.
    await prisma.priceSheet.update({ where: { id }, data: { status: previousStatus } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
