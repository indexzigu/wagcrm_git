import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { toCampaignRow } from "@/lib/campaign-row";
import { requireAuth } from "@/lib/api-auth";
import { buildTaxInvoiceRows, buildTaxInvoiceXlsx } from "@/lib/tax-invoice-builder";
import { buildTaxInvoiceObligationRows } from "@/lib/tax-filing-board";

export async function POST(request: Request) {
  // 1. 인증 확인
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  // 2. Request body 파싱 — campaignIds: string[] 필수.
  //    format: "json" 이면 XLSX 대신 TaxInvoiceRow[] JSON 을 돌려준다 — 홈택스 로컬
  //    헬퍼(건별발급 폼 자동 입력)가 이 페이로드를 소비한다. 검증·행 구성은 XLSX 와
  //    완전히 같은 경로를 타므로(보드 ISSUE 행 → buildTaxInvoiceRows) 두 형식의
  //    금액·상대가 갈릴 수 없다 — 헬퍼 전용 별도 라우트를 만들지 말 것(화면과
  //    파일이 갈렸던 이 도메인의 반복 사고가 그 이중화에서 나왔다).
  let campaignIds: string[];
  let format: "xlsx" | "json" = "xlsx";
  try {
    const body = await request.json();
    if (
      !body ||
      !Array.isArray(body.campaignIds) ||
      body.campaignIds.length === 0
    ) {
      return NextResponse.json(
        { error: "campaignIds required" },
        { status: 400 },
      );
    }
    campaignIds = body.campaignIds as string[];
    if (body.format === "json") format = "json";
  } catch {
    return NextResponse.json(
      { error: "campaignIds required" },
      { status: 400 },
    );
  }

  // 3. DB에서 캠페인 조회 (campaignDeals, seller, deal.partner 포함)
  const prisma = getPrisma();
  const campaignInclude = {
    deal: { include: { partner: true } },
    campaignDeals: { include: { deal: true } },
    seller: {
      include: {
        agency: { include: { contacts: { take: 1, orderBy: { createdAt: "asc" } } } },
        histories: { orderBy: { snapshotDate: "asc" }, take: 1 },
      },
    },
    group: true,
    // ⛔ 빼면 부가 항목이 있어도 XLSX 금액·품목 행이 안 움직이고 **오류도 안 난다**
    //    (설계 §9-6-3). 오너가 그 파일을 홈택스에 그대로 올리는 경로라 침묵형 과소
    //    신고가 된다. 정렬은 `campaignService` 의 select 와 동일하게 맞춘다.
    settlementItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    // ⚠️ `as const` 가 아니라 `satisfies` 다 — `as const` 는 `orderBy` 배열을 readonly
    //    튜플로 굳혀 Prisma 의 `SalesCampaignInclude` 에 안 맞는다.
  } satisfies Prisma.SalesCampaignInclude;

  const requestedCampaigns = await prisma.salesCampaign.findMany({
    where: { id: { in: campaignIds } },
    include: campaignInclude,
  });

  // ⛔ 실사고(2026-08-04 whole-branch 리뷰) — `buildTaxInvoiceObligationRows`는
  // "받은 캠페인 안에서" 그룹을 재구성한다. 3인 그룹 중 1건만 요청받으면, 그
  // 1건이 "그룹 없는 캠페인 1건"처럼 보이는 게 아니라 **멤버가 1명뿐인 그룹**으로
  // 다뤄져 조용히 정상 행이 나온다 — 금액은 그 1건 몫만, 라벨은 「외 N건」 없이
  // 단일 캠페인처럼, selectable:true, 경고 없음. 결과 XLSX 가 3분의 1 금액의
  // 정상 세금계산서와 구분되지 않는다(과소 신고). 그래서 요청받은 캠페인들이
  // 속한 그룹은 **항상 전원을 채워** 넘긴다 — 그룹이면 어차피 한 행으로 접히므로
  // (emitGroupRows) 멤버를 더 가져오는 것은 안전하다(결과가 부풀지 않는다).
  const groupIds = [
    ...new Set(requestedCampaigns.map((c) => c.groupId).filter((id): id is string => id != null)),
  ];

  let dbCampaigns = requestedCampaigns;
  if (groupIds.length > 0) {
    const groupMemberCampaigns = await prisma.salesCampaign.findMany({
      where: { groupId: { in: groupIds } },
      include: campaignInclude,
    });
    const byId = new Map(requestedCampaigns.map((c) => [c.id, c]));
    for (const member of groupMemberCampaigns) byId.set(member.id, member);
    dbCampaigns = [...byId.values()];
  }

  const campaigns = dbCampaigns.map((campaign) => toCampaignRow(campaign));
  const campaignsById = new Map(campaigns.map((c) => [c.id, c]));

  // 4. 캠페인에서 다시 금액·상대를 유도하지 않는다 — `tax-filing-board`가 이미
  // channel·counterpart·amount·그룹 수렴·결번 판정을 전부 통과시킨 행을 낸다
  // (설계 문서 「빌더 정정 설계 — 보드 행에서 만든다」). 월 필터가 없는 버전을
  // 쓴다 — 여기 캠페인은 이미 사용자가 특정 campaignIds 로 골라 온 것이라, 월로
  // 다시 걸러내면 사용자가 고른 행이 조용히 사라질 수 있다.
  const { rows: obligationRows } = buildTaxInvoiceObligationRows(campaigns);
  const issueRows = obligationRows.filter((row) => row.direction === "ISSUE");

  if (issueRows.length === 0) {
    return NextResponse.json(
      { error: "선택된 캠페인 중 발행(ISSUE) 대상이 없습니다." },
      { status: 400 },
    );
  }

  const blockedRows = issueRows.filter((row) => !row.selectable);
  if (blockedRows.length > 0) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: blockedRows.map((row) => ({
          campaignId: row.campaignId,
          campaignName: row.campaignLabel,
          missingFields: row.blockingReasons,
        })),
      },
      { status: 400 },
    );
  }

  // 5. 세금계산서 행 생성 — 선택 가능(결번 없음)한 ISSUE 행만 넘긴다. 행의 amount 를
  // 그대로 쓰므로 재계산이 없다. format=json 이면 여기서 행을 그대로 반환한다.
  if (format === "json") {
    try {
      const rows = buildTaxInvoiceRows(issueRows, campaignsById);
      return NextResponse.json({ rows });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json(
        { error: "Failed to build tax invoice rows", detail: errMsg },
        { status: 500 },
      );
    }
  }

  let buffer: Buffer;
  try {
    const rows = buildTaxInvoiceRows(issueRows, campaignsById);
    buffer = await buildTaxInvoiceXlsx(rows);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to generate tax invoice file", detail: errMsg },
      { status: 500 },
    );
  }

  // 6. 파일명: hometax-tax-invoice-YYYYMMDD.xlsx
  const now = new Date();
  const dateStr =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");
  const filename = `hometax-tax-invoice-${dateStr}.xlsx`;

  // 7. 응답 반환 (Buffer → Uint8Array for NextResponse compatibility)
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
