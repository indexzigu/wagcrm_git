import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { decryptOrNull } from "@/lib/encryption";

/**
 * 셀러 1명의 정산 신원 정보(주민등록번호·계좌번호) 단건 조회.
 *
 * ⚠️ **별도 엔드포인트인 이유**: 주민등록번호를 `SellerSummary`(목록 페이로드)에 넣으면
 * 셀러 전원(160명 규모)의 주민번호가 목록 조회 한 번에 브라우저로 내려간다. 상세 패널을
 * 연 그 한 명만 필요하므로 요청 단위를 1명으로 좁힌다 — 목록 타입에 절대 얹지 말 것.
 *
 * 복호화 실패는 `decryptOrNull` 로 흡수한다(값 대신 null). 한 셀러의 값이 안 열린다고
 * 상세 패널 전체가 죽으면 피해가 원인보다 크고, 암호문이 화면에 새지도 않는다.
 */
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const seller = await getPrisma().seller.findUnique({
    where: { id },
    select: { id: true, realName: true, residentNumber: true, accountNumber: true, agencyId: true },
  });

  if (!seller) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }

  return NextResponse.json({
    /** 원천징수 신고용 법적 실명 — 목록 표기명(`name`/`alias`)과 다른 값이다. */
    realName: seller.realName ?? null,
    residentNumber: decryptOrNull(seller.residentNumber),
    accountNumber: seller.accountNumber ?? null,
    /** 거래처가 연결돼 있으면 정산 신원은 거래처 정보를 쓴다(개인 원천징수 대상 아님). */
    hasLinkedPartner: Boolean(seller.agencyId),
  });
}
