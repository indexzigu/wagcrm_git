import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getAuthContext } from "@/lib/auth-context";
import { getPrisma } from "@/lib/prisma";
import {
  APPLY_CLAIM_STALE_MS,
  APPLY_LOCKED_STATUSES,
  PriceSheetRepository,
} from "@/repositories/priceSheetRepository";
import { applyPriceSheet, ApplyExecutorError } from "@/lib/price-sheet/apply-executor";
import { normalizePriceSheetForResponse } from "@/lib/price-sheet/serialize-response";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { parseStoredJson } from "@/lib/stored-json";

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
 * ② 동시 요청 방어: updateMany 의 count 로 CAS(compare-and-swap)한다 — 잠금 상태
 *    (APPLIED/APPLYING)가 아니거나 APPLY_CLAIM_STALE_MS 보다 오래된 APPLYING 일 때만 선점에
 *    성공한다. count===0이면 다른 요청이 반영 중이거나 끝났다는 뜻이므로 409.
 * ③ 반영된 행의 mappingStatus를 종료 상태 "APPLIED"로 전이해 재조회(다음 apply 시도의
 *    MAPPED/NEW_DEAL 조회) 대상에서 제외한다(buildApplyActionForRow는 애초에
 *    MAPPED/NEW_DEAL만 액션으로 변환하므로 APPLIED 행은 자연히 skip된다).
 * ④ T-310 — 선점이 영구히 걸리지 않게:
 *    - 선점 시각(updatedAt)이 이 요청의 토큰이다. 행·시트 마감(③ 포함)은 실행기의 딜 쓰기
 *      $transaction 안에서 그 토큰 조건부로 일어난다 → 딜 커밋과 시트 APPLIED 가 갈라지지 않는다.
 *    - 요청이 죽어 남은 오래된 APPLYING 은 다음 반영 클릭이 넘겨받는다. 그 선점 뒤에 EXECUTED
 *      기안이 있으면(= 이미 커밋됨) 다시 반영하지 않고 APPLIED 로 정리만 한다.
 *    - 딜이 커밋된 뒤에는 어떤 실패도 시트를 되돌리지 않는다.
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
      return NextResponse.json({ error: "지정한 상위 판매 조건을 찾을 수 없습니다." }, { status: 400 });
    }
    // parentDealId만 보면 dealType:"OPTION" + parentDealId:null인(현재 코드로는 생성되지
    // 않지만 조작된 요청으로는 가능한) 행이 통과한다 — dealType:"MAIN"까지 함께 확인한다.
    if (parent.parentDealId || parent.dealType !== "MAIN") {
      return NextResponse.json(
        { error: "하위품목 판매 조건에는 다시 하위품목을 붙일 수 없습니다. 상위 판매 조건을 선택하세요." },
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

  // T-310: 선점 시각을 updatedAt 에 직접 박아 이 요청만의 토큰으로 쓴다. 이후의 마무리·되돌리기는
  // 모두 "status=APPLYING AND updatedAt=claimedAt" 조건부 쓰기라, 이 요청이 죽은 줄 알고 다른
  // 요청이 넘겨받았으면(토큰이 바뀜) 늦게 깨어난 이 요청은 아무것도 덮어쓰지 못한다.
  const claimedAt = new Date();
  const staleBefore = new Date(claimedAt.getTime() - APPLY_CLAIM_STALE_MS);
  const previousStatus = priceSheet.status;
  const isStaleClaim = previousStatus === "APPLYING" && priceSheet.updatedAt < staleBefore;

  // 오래된 선점이 이미 커밋까지 끝난 경우(T-310 이전 코드는 딜 커밋 뒤 행·시트 마감을 트랜잭션
  // 밖에서 했다) — 다시 반영하면 같은 딜이 또 생기므로 반영 완료로 정리만 한다. 선점 이후에
  // 만들어진 EXECUTED 기안이 판정 근거다(EXECUTED 는 딜 쓰기와 한 트랜잭션에서 커밋된다).
  if (isStaleClaim) {
    const committed = await prisma.actionProposal.findFirst({
      where: {
        requestType: "price_sheet_apply",
        targetEntityType: "PRICE_SHEET",
        targetEntityId: id,
        status: "EXECUTED",
        createdAt: { gte: priceSheet.updatedAt },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, executionResult: true },
    });
    if (committed) {
      return rollForwardCommittedApply({ id, staleClaimAt: priceSheet.updatedAt, actor, proposal: committed });
    }
  }

  // CAS: 잠금 상태가 아니거나, 오래돼 죽은 것으로 보는 APPLYING 일 때만 선점한다. count===0 이면
  // 그 사이 다른 요청이 먼저 선점했거나(살아 있는 APPLYING) 이미 반영을 끝냈다는 뜻 — 409.
  const claim = await prisma.priceSheet.updateMany({
    where: {
      id,
      OR: [
        { status: { notIn: [...APPLY_LOCKED_STATUSES] } },
        { status: "APPLYING", updatedAt: { lt: staleBefore } },
      ],
    },
    data: { status: "APPLYING", updatedAt: claimedAt },
  });

  if (claim.count === 0) {
    return NextResponse.json(
      {
        error:
          `이미 반영 중이거나 반영이 완료된 가격표입니다. 반영 중이던 요청이 멈춘 것이라면 ${APPLY_CLAIM_STALE_MS / 60_000}분 뒤 다시 반영을 누르면 이어서 반영됩니다.`,
      },
      { status: 409 }
    );
  }

  const ownClaim = { id, status: "APPLYING" as const, updatedAt: claimedAt };
  // 반영이 커밋되지 않았을 때 돌아갈 상태. 넘겨받은 선점이면 직전 상태를 알 수 없으므로
  // 반영 직전 단계인 MAPPED 로 둔다 — APPLYING 으로 되돌리면 다시 선점 만료(APPLY_CLAIM_STALE_MS)를 기다려야 한다.
  const restoreStatus = previousStatus === "APPLYING" ? "MAPPED" : previousStatus;
  const releaseClaim = () =>
    prisma.priceSheet.updateMany({ where: ownClaim, data: { status: restoreStatus } });

  const rows = await prisma.priceSheetRow.findMany({
    where: {
      priceSheetId: id,
      mappingStatus: { in: ["MAPPED", "NEW_DEAL"] },
    },
  });

  if (rows.length === 0) {
    // 선점했던 APPLYING을 원래 상태로 되돌린다(가드가 상태를 갈아치운 채로 끝나면 안 됨).
    await releaseClaim();
    return NextResponse.json(
      { error: "반영할 매핑 확정 행이 없습니다 (검수표에서 MAPPED/NEW_DEAL로 확정한 행이 필요합니다)." },
      { status: 409 }
    );
  }

  let applied: Awaited<ReturnType<typeof applyPriceSheet>>;
  try {
    applied = await applyPriceSheet({
      priceSheetId: id,
      partnerId: priceSheet.partnerId,
      actor,
      rows,
      groupOverrides,
      bundle,
      // 행·시트를 APPLIED 로 닫는 일을 딜 쓰기와 같은 트랜잭션에서 한다(T-310) — 밖에서 하면
      // 딜은 커밋됐는데 마감이 실패해 시트가 되돌아가고, 재반영이 같은 딜을 또 만든다.
      finalize: async (tx) => {
        const fenced = await tx.priceSheet.updateMany({
          where: ownClaim,
          data: { status: "APPLIED", reviewedBy: actor, reviewedAt: new Date() },
        });
        if (fenced.count !== 1) {
          throw new ApplyExecutorError("다른 반영 요청이 이 가격표를 넘겨받아 이번 반영을 취소했습니다.");
        }
        // 반영된 행을 종료 상태 APPLIED로 전이 — 다음 apply 재조회(MAPPED/NEW_DEAL) 대상에서 제외.
        await tx.priceSheetRow.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { mappingStatus: "APPLIED" },
        });
      },
    });
  } catch (err) {
    const message = err instanceof ApplyExecutorError ? err.message : "가격표 반영 중 오류가 발생했습니다.";
    console.error(`[POST /api/price-sheets/${id}/apply] Error:`, err);
    // 딜 쓰기·마감이 한 트랜잭션으로 롤백된 상태 — 선점을 풀어 재시도 가능하게 한다. 이 요청이
    // 선점을 잃었으면(넘겨받음) 조건이 안 맞아 아무것도 바꾸지 않는다.
    await releaseClaim();
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // ⛔ 여기부터는 딜이 이미 커밋됐다 — 어떤 실패도 시트를 되돌리면 안 된다(T-310).
  invalidateDealCaches(id);
  const updatedSheet = await PriceSheetRepository.findById(id, false);

  // rowCount = 반영한 품목(행) 수 = 검수 모달의 rows.length와 일치. results.length는 실제
  // 생성/수정된 딜 수로, 그룹핑 시 상위딜이 추가되어 rowCount보다 클 수 있다(둘을 구분해 반환).
  return NextResponse.json({
    priceSheet: updatedSheet ? normalizePriceSheetForResponse(updatedSheet) : null,
    proposal: applied.proposal,
    results: applied.results,
    rowCount: rows.length,
  });
}

// 딜 목록(getCachedDealsPageData = crm:deals 태그) 캐시 무효화 — 반영은 tx.deal.create로
// 딜을 직접 만들어 /api/deals POST의 revalidate 경로를 안 타므로, 여기서 명시적으로 깬다.
// 누락 시 "반영 완료"는 뜨는데 딜 관리 목록에 새 딜이 안 보이는 사고가 난다(오너 실보고).
// 딜은 이미 커밋된 뒤라 실패해도 반영 결과는 그대로다 — 기록만 남기고 응답은 성공으로 둔다.
function invalidateDealCaches(id: string) {
  try {
    revalidateMasterDataCaches();
  } catch (err) {
    console.error(`[POST /api/price-sheets/${id}/apply] 캐시 무효화 실패(반영은 완료됨):`, err);
  }
}

/**
 * 오래된 APPLYING 선점인데 그 반영이 이미 커밋된 경우의 정리(T-310). 딜을 다시 만들지 않고
 * 시트·행만 APPLIED 로 닫는다. 선점 토큰(updatedAt)이 그대로일 때만 — 그 사이 다른 요청이
 * 넘겨받았으면 손대지 않는다.
 */
async function rollForwardCommittedApply(input: {
  id: string;
  staleClaimAt: Date;
  actor: string;
  proposal: { id: string; status: string; executionResult: unknown };
}) {
  const { id, staleClaimAt, actor, proposal } = input;
  const prisma = getPrisma();
  let rowCount = 0;
  try {
    rowCount = await prisma.$transaction(async (tx) => {
      const fenced = await tx.priceSheet.updateMany({
        where: { id, status: "APPLYING", updatedAt: staleClaimAt },
        data: { status: "APPLIED", reviewedBy: actor, reviewedAt: new Date() },
      });
      if (fenced.count !== 1) throw new ClaimLostError();
      const { count } = await tx.priceSheetRow.updateMany({
        where: { priceSheetId: id, mappingStatus: { in: ["MAPPED", "NEW_DEAL"] } },
        data: { mappingStatus: "APPLIED" },
      });
      return count;
    });
  } catch (err) {
    if (!(err instanceof ClaimLostError)) throw err;
    return NextResponse.json({ error: "이미 반영 중이거나 반영이 완료된 가격표입니다." }, { status: 409 });
  }

  invalidateDealCaches(id);
  const updatedSheet = await PriceSheetRepository.findById(id, false);
  const executionResult = parseStoredJson<{ results?: unknown[] }>(proposal.executionResult);
  return NextResponse.json({
    priceSheet: updatedSheet ? normalizePriceSheetForResponse(updatedSheet) : null,
    proposal: { id: proposal.id, status: proposal.status },
    results: executionResult?.results ?? [],
    rowCount,
    recovered: true,
  });
}

class ClaimLostError extends Error {}
