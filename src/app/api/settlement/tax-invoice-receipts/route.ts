import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import {
  buildGroupExpectedReceivables,
  type ExpectedReceivable,
} from "@/lib/tax-invoice-mail/expected-receivables";
import { loadCampaignSettlementFacts } from "@/lib/tax-invoice-mail/campaign-facts";
import {
  judgeReceipt,
  SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
  type ReceiptVerdict,
} from "@/lib/tax-invoice-mail/receipt-match";
import { scanTaxInvoiceMails } from "@/lib/tax-invoice-mail/mail-scan";
import { suggestReceiptMatch } from "@/lib/tax-invoice-mail/receipt-similarity";
import { parseStoredJson } from "@/lib/stored-json";

/**
 * 수취 세금계산서 **조회 전용** 엔드포인트.
 *
 * 전용 메일함(오너가 세금계산서 메일을 따로 관리하는 폴더)을 읽기 전용으로 스캔해,
 * 국세청 표준 XML 첨부를 CRM 정산 금액과 대조한 **판정 결과를 돌려준다.**
 *
 * ## ⛔ 이 라우트는 아무것도 쓰지 않는다
 *
 * `sellerInvoiceIssuedAt`·`supplierInvoiceIssuedAt` 을 **찍지 않는다.** 무엇을 근거로 완료를
 * 확정할지는 세무 보드 재작성이 끝난 뒤 결정할 사안이고, 그 전에 자동 완료를 붙이면
 * **잘못 발행된 계산서가 「확인됨」으로 굳는다** — 이 기능이 막으려던 바로 그 실패다.
 * 메일함에도 흔적을 남기지 않는다(`mail-scan.ts` 의 무흔적 계약).
 *
 * ⚠️ 쓰기는 형제 라우트 `./decision` 이 소유한다(오너의 클릭이 근거) — 이 라우트는 그
 * 결정 기록을 **읽어서** 결과에 얹기만 한다.
 */

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const url = new URL(request.url);
  const sinceDays = Math.min(365, Math.max(7, Number(url.searchParams.get("sinceDays") ?? 90)));
  const boxOverride = url.searchParams.get("box");

  // ── 1. 대조 대상 캠페인 — 조회 창과 겹치는 기간의 건만.
  //    ⚠️ 조회·폴딩 규칙은 `campaign-facts.ts` 가 SSOT 다(발행 자동확정 크론과 공유) —
  //    여기에 findMany 를 다시 쓰면 select 하나가 갈리는 순간 두 표면이 다른 답을 낸다.
  const facts = await loadCampaignSettlementFacts(getPrisma(), { sinceDays });

  // 「셀러·공급사 둘 다 그룹당 한 장을 합산해서 끊는다」(오너 확정 2026-08-04) — 그룹은
  // buildGroupExpectedReceivables 로 합산 인지형 기대 건을 만들고, 미그룹 캠페인은
  // 이 함수의 멤버-1건 위임 경로(=buildExpectedReceivables 와 동일)를 그대로 탄다.
  const expected: ExpectedReceivable[] = [
    ...facts.solo.flatMap((item) => buildGroupExpectedReceivables([item])),
    ...[...facts.byGroup.values()].flatMap((members) => buildGroupExpectedReceivables(members)),
  ];

  // ── 2. CRM 이 아는 **모든** 거래 상대의 사업자번호.
  //    조회 창과 무관하게 전량을 모은다 — 창만 어긋난 셀러를 "모르는 상대"로 오분류하면
  //    잘못 발행된 계산서가 경비 계산서와 같은 칸에 들어가 접힌다.
  const partners = await getPrisma().partner.findMany({
    where: { businessNumber: { not: null } },
    select: { businessNumber: true },
  });
  const knownCounterpartBusinessNumbers = partners
    .map((partner) => partner.businessNumber)
    .filter((value): value is string => Boolean(value));

  // ── 3. 전용 메일함 스캔(읽기 전용)
  let scan;
  try {
    scan = await scanTaxInvoiceMails({
      sinceDays,
      boxName: boxOverride ?? undefined,
      // 국세청 보안메일 첨부의 비밀번호 = 공급받는자(우리) 사업자등록번호 10자리.
      invoicePassword: SUPPLIER.businessNumber,
    });
  } catch (error) {
    // 삼키지 않는다 — 조회 실패를 "수취 0건"으로 오독하면 오너가 미수취를 못 본다(P0).
    const message = error instanceof Error ? error.message : "메일함 조회에 실패했습니다.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // ── 4. 이미 내려진 결정(승인·무관 처리). 기각한 계산서가 매 스캔 다시 「확인 필요」로
  //    올라오면 화면이 무시당하므로, 결정된 건은 그 사실과 함께 접는다.
  const decisionRows = await getPrisma().taxInvoiceReceiptDecision.findMany();
  const decisionByIssueId = new Map(
    decisionRows.map((row) => [
      row.issueId,
      {
        decision: row.decision,
        // ⛔ Json 텍스트 컬럼은 캐스팅하지 말고 통과시킨다(`stored-json.ts` 헤더).
        matchedKeys: parseStoredJson<string[]>(row.matchedKeys) ?? [],
        amountDelta: row.amountDelta,
        decidedAt: row.decidedAt.toISOString(),
      },
    ]),
  );

  // ── 5. 판정. 승인번호를 누적해 중복 발행을 잡는다.
  const seenIssueIds: string[] = [];
  const results = scan.mails.map((mail) => {
    const verdict: ReceiptVerdict = judgeReceipt({
      parsed: mail.parsed,
      expected,
      ourBusinessNumber: SUPPLIER.businessNumber,
      seenIssueIds: [...seenIssueIds],
      knownCounterpartBusinessNumbers,
      // 오너 확정(2026-08-06): 브랜드사의 100원 미만 절삭 관행만 흡수한다. 흡수된 오차는
      // AMOUNT_TOLERATED 사유로 표면화된다 — 조용한 완화가 아니다.
      amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
      attachmentPasswordSuspected: mail.unparsedAttachments.some(
        (attachment) => attachment.passwordSuspected,
      ),
    });
    if (mail.parsed?.issueId) seenIssueIds.push(mail.parsed.issueId);

    const decision = mail.parsed?.issueId ? decisionByIssueId.get(mail.parsed.issueId) ?? null : null;

    // 유사도 제안 — 판정을 **바꾸지 않고** 근거만 덧붙인다(`receipt-similarity.ts` 헤더).
    // 이미 결정이 내려진 건에는 붙이지 않는다(누를 것이 없다).
    const suggestion = decision
      ? null
      : suggestReceiptMatch({ verdict, parsed: mail.parsed, expected });

    return {
      decision,
      suggestion,
      mail: {
        uid: mail.uid,
        subject: mail.subject,
        fromAddress: mail.fromAddress,
        receivedAt: mail.receivedAt,
        hasAttachmentEvidence: mail.parsed !== null,
        /** 형식 조사의 원천 — 못 읽은 첨부를 버리지 않는다. */
        unparsedAttachments: mail.unparsedAttachments,
      },
      verdict,
    };
  });

  // ── 첨부 형식 census. **이 응답의 가장 큰 값어치가 당분간 이것이다** — 발행 메일의 첨부가
  //    실제로 무엇인지가 미확인이라, 첫 호출이 그 답을 낸다(설계 문서의 🔴 절 참조).
  const attachmentCensus: Record<string, number> = {};
  for (const mail of scan.mails) {
    for (const attachment of mail.unparsedAttachments) {
      const key = attachment.passwordSuspected ? `${attachment.kind}(암호)` : attachment.kind;
      attachmentCensus[key] = (attachmentCensus[key] ?? 0) + 1;
    }
    if (mail.parsed) attachmentCensus.ETAX_XML = (attachmentCensus.ETAX_XML ?? 0) + 1;
  }

  const matchedKeys = new Set(
    results.filter((row) => row.verdict.matchedKey).map((row) => row.verdict.matchedKey as string),
  );
  // 오너가 승인한 건도 「대응 계산서를 봤다」에 든다 — 넣지 않으면 승인 직후에도 그 건이
  // 계속 미수취 후보로 남아, 승인이 화면에 아무 변화를 만들지 못한다.
  for (const row of decisionRows) {
    if (row.decision !== "APPROVED") continue;
    for (const key of parseStoredJson<string[]>(row.matchedKeys) ?? []) matchedKeys.add(key);
  }

  return NextResponse.json({
    scan: {
      box: scan.box,
      headerScanned: scan.headerScanned,
      candidates: scan.candidates,
      /** 관문에서 걸러 본문을 열지도 않은 통수 — 필터의 사각을 눈에 보이게 한다. */
      skippedByFilter: scan.skippedByFilter,
      /** 0 이 아니면 화면이 "전부 확인했다"고 말하면 안 된다. */
      truncated: scan.truncated,
      sinceDays,
    },
    summary: {
      verified: results.filter((row) => row.verdict.status === "VERIFIED").length,
      /**
       * 아직 **오너가 손대지 않은** 확인 필요 건. 결정이 내려진 건은 빠진다 — 기각한
       * 경비 계산서가 매달 같은 자리에 다시 쌓이면 이 숫자가 신호이기를 그만둔다.
       */
      needsReview: results.filter(
        (row) => row.verdict.status === "NEEDS_REVIEW" && row.decision === null,
      ).length,
      /** 승인·무관 처리로 종결된 건 */
      decided: results.filter((row) => row.decision !== null).length,
      /** 그중 1클릭 승인 후보가 붙은 건 — 오너가 지금 처리할 수 있는 양 */
      suggested: results.filter((row) => row.suggestion !== null).length,
      notOurs: results.filter((row) => row.verdict.status === "NOT_OURS").length,
      /** 우리가 발행한 건(수취 대상 아님) — 이 폴더엔 발행 메일도 섞여 있다 */
      issuedByUs: results.filter((row) => row.verdict.status === "ISSUED_BY_US").length,
      expectedTotal: expected.length,
      /** 기대 건인데 대응하는 계산서를 못 본 것 = 미수취 후보 */
      unseenExpected: expected.filter((item) => !matchedKeys.has(item.key)).length,
      /**
       * 그중 **상대 사업자등록번호가 CRM 에 없어 대조 자체가 불가능한** 건.
       * 대조 키가 없으면 계산서가 와 있어도 영원히 매칭되지 않는다 — 이걸 미수취로
       * 세면 화면이 「안 왔다」고 단정하지만 실제로는 「우리가 확인할 수단이 없다」다.
       */
      unmatchableExpected: expected.filter(
        (item) => !matchedKeys.has(item.key) && item.counterpartBusinessNumber === null,
      ).length,
      /** 비밀번호가 걸려 열지 못한 메일 수 — 0 이 아니면 자동 검증 범위가 그만큼 좁다 */
      passwordProtected: results.filter((row) =>
        row.verdict.reasons.some((reason) => reason.code === "ATTACHMENT_PASSWORD_PROTECTED"),
      ).length,
      /** 첨부 형식 분포 — 미확인 가정을 닫는 관측치 */
      attachmentCensus,
    },
    results,
    unseenExpected: expected
      .filter((item) => !matchedKeys.has(item.key))
      .map((item) => ({
        key: item.key,
        campaignId: item.campaignId,
        campaignLabel: item.campaignLabel,
        channel: item.channel,
        slot: item.slot,
        counterpartLabel: item.counterpartLabel,
        /** 상대 사업자번호가 없으면 이 건은 「미수취」가 아니라 **대조 불가**다. */
        counterpartBusinessNumberMissing: item.counterpartBusinessNumber === null,
        expectedTotalAmount: item.expectedTotalAmount,
        amountBasis: item.amountBasis,
        trackingField: item.trackingField,
        alreadyMarkedAt: item.alreadyMarkedAt,
      })),
  });
}
