import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { PriceSheetRepository } from "@/repositories/priceSheetRepository";
import { normalizePriceSheetForResponse } from "@/lib/price-sheet/serialize-response";
import { summarizeApplyProposal } from "@/lib/price-sheet/apply-summary";
import { parseStoredJson } from "@/lib/stored-json";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;
  // PriceSheetRepository.findById는 partner를 include하지 않으므로(Phase 1 리포지토리,
  // 소유 경로 밖) 여기서 별도 조회해 붙인다 — UI(가격표 상세 헤더)가 거래처명을 표시해야 함.
  const priceSheet = await PriceSheetRepository.findById(id, true);
  if (!priceSheet) {
    return NextResponse.json({ error: "가격표를 찾을 수 없습니다." }, { status: 404 });
  }

  const partner = priceSheet.partnerId
    ? await getPrisma().partner.findUnique({
        where: { id: priceSheet.partnerId },
        select: { id: true, name: true },
      })
    : null;

  // 마지막 반영 시도 — 실패해도 시트 상태는 재시도 가능하도록 되돌아가므로(오너 결정)
  // 실패 사실이 시트에는 남지 않는다. 검수 화면의 「반영 결과」 카드가 이 기록을 읽어
  // 진행중·완료·실패를 보여준다. 없으면 null(한 번도 반영을 시도하지 않은 시트).
  const lastApplyProposal = await getPrisma().actionProposal.findFirst({
    where: {
      requestType: "price_sheet_apply",
      targetEntityType: "PRICE_SHEET",
      targetEntityId: id,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      executedAt: true,
      errorMessage: true,
      executionResult: true,
    },
  });

  return NextResponse.json({
    priceSheet: { ...normalizePriceSheetForResponse(priceSheet), partner },
    lastApply: lastApplyProposal
      ? summarizeApplyProposal({
          ...lastApplyProposal,
          // 🪤 raw Prisma 로 읽은 Json 은 SQLite 에서 **문자열**이다(리포지토리가 이원화
          // 저장하고 역직렬화는 그쪽에만 있다). 그대로 넘기면 `results` 를 못 읽어
          // 성공한 반영이 "생성 0건 · 갱신 0건"으로 그려진다 — 실측 확인된 결함이다.
          executionResult: parseStoredJson(lastApplyProposal.executionResult),
        })
      : null,
  });
}
