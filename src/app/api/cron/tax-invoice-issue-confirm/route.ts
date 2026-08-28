import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import { loadCampaignSettlementFacts } from "@/lib/tax-invoice-mail/campaign-facts";
import {
  buildGroupExpectedIssuances,
  type ExpectedIssuance,
} from "@/lib/tax-invoice-mail/expected-issuances";
import {
  matchIssuedInvoices,
  type ScannedIssuedInvoice,
} from "@/lib/tax-invoice-mail/issuance-match";
import { buildIssuanceWritePlan } from "@/lib/tax-invoice-mail/issuance-confirm";
import { SUB_HUNDRED_TRUNCATION_TOLERANCE_WON } from "@/lib/tax-invoice-mail/receipt-match";
import { scanTaxInvoiceMails } from "@/lib/tax-invoice-mail/mail-scan";
// 필드 라벨 정본은 lib 쪽이다(`api/settlement/tax-filing-board/route.ts` 도 같은 맵을
// 소비한다) — 이 route 가 사본을 따로 들고 있다가 2026-08-07 정정 때 한쪽만 고쳐져
// 갈렸다(FIX 3). route 가 lib 를 import 하는 방향이 자연스러워 여기서 정리한다.
import { FIELD_LABEL } from "@/lib/tax-filing-auto-confirm";

/**
 * **발행(우리가 끊는) 세금계산서 자동 확정** — 하루 한 번.
 *
 * 오너 지시(2026-08-06): "메일엔진으로 자동확정하되 메일엔진에서 수집못할경우 수동으로도
 * 확정 가능하도록, 하루에 한번정도만 조회하면 될것 같은데."
 *
 * 즉 **1차 = 이 크론 · 폴백 = 현행 「완료」 버튼(그대로 유지) · 주기 = 일 1회**다.
 *
 * ## 이 라우트가 이 트랙 최초의 쓰기 경로다
 *
 * 지금까지 `src/lib/tax-invoice-mail/**` 는 DB 접근이 0이었고 수취 조회 API 도 쓰기가
 * 0이었다. 그래서 쓰기 규칙을 **순수 계층으로 밀어 넣고** 여기서는 그 계획을 집행만 한다:
 *
 * | 계층 | 파일 | 부수효과 |
 * | --- | --- | --- |
 * | 기대 건 | `expected-issuances.ts` | 없음 |
 * | 판정 | `issuance-match.ts` | 없음 |
 * | 쓰기 계획 | `issuance-confirm.ts` | 없음 |
 * | 집행 | **이 파일** | Prisma update + ActivityLog |
 *
 * ## ⛔ 안전 제약 (전부 실사고·오너 확정에서 나왔다)
 *
 * 1. **찍는 방향만 한다.** 되돌리는(`null` 로 지우는) 경로가 **없다** — 메일 커버리지가
 *    100% 가 아님이 실측됐고(실물 계산서가 있는데 국세청 메일이 편지함 15개 폴더에 0건),
 *    "메일이 없으니 발행 취소"는 곧 데이터 손상이다.
 * 2. **최고 등급 근거만.** 첨부 XML 파싱본만 판정에 들어간다 — 제목·발신자 추정
 *    (`SUBJECT_FALLBACK`)은 애초에 이 라우트에 도달하지 못한다(`mail.parsed` 가 null 인
 *    메일은 걸러진다).
 * 3. **그룹이 캠페인별로 후퇴하면 쓰지 않는다.** 그룹의 발행일은 멤버 전원이 공유하는
 *    스칼라 1개라, 멤버 1건을 근거로 찍으면 나머지 의무까지 조용히 완료로 굳는다.
 * 4. **이미 찍힌 건은 건드리지 않는다.**
 *
 * ## 예행(dry-run)
 *
 * `?dryRun=1` 이면 판정·계획까지만 하고 쓰지 않는다. **첫 실행은 반드시 이 모드로**
 * 오너가 결과를 확인한 뒤 스케줄에 맡긴다(P0 — 레포 `.env` 의 DB 가 프로덕션이다).
 * 수동 발화는 시스템 레이더의 실행 버튼(`/api/system/cron-run`)으로 한다.
 */

// IMAP 스캔(최대 400통 본문 다운로드) + 판정 + 소수의 쓰기. 다른 크론과 같은 상한을 명시한다.
export const maxDuration = 300;

/**
 * 메일 조회 창(일). 미발행 건 다수가 **이전 달 종료**라는 것이 프로덕션 실측이므로
 * 한 달로 좁히지 않는다. 캠페인 조회 창은 여기에 더해 `CAMPAIGN_WINDOW_LOOKBACK_DAYS`
 * 만큼 더 넓다(계산서는 캠페인이 끝난 뒤에 끊긴다).
 */
const SCAN_SINCE_DAYS = 90;

/**
 * 한 회차 확정 상한.
 *
 * 계산서 물량은 월 15~20건(오너 실측)이라 평시엔 걸리지 않는다. 그럼에도 두는 이유는
 * **데이터 결함이 상시 폭주로 번지는 것**을 막기 위해서다(임포트로 과거 캠페인이 대량
 * 유입되는 등). ⚠️ 상한에 걸려 빠진 수는 응답에 남긴다 — 조용한 절단은 "전부 처리했다"로
 * 읽힌다.
 */
const MAX_CONFIRMS_PER_RUN = 30;

const BASIS_LABEL: Record<string, string> = {
  LINE_ITEM: "품목명 일치",
  SOLE_COUNTERPART: "해당 상대의 유일한 건",
};

/** 캠페인 타임라인에 그대로 렌더되는 한 줄. 숫자·승인번호는 담되 문장으로 쓴다. */
function summarizeConfirm(op: {
  field: string;
  writtenDate: string;
  evidence: {
    issueIds: string[];
    invoiceCount: number;
    totalAmount: number | null;
    basis: string[];
    toleratedDelta: number | null;
  };
}): string {
  const amount =
    op.evidence.totalAmount === null
      ? ""
      : ` · 합계 ${op.evidence.totalAmount.toLocaleString("ko-KR")}원`;
  const ids = op.evidence.issueIds.length > 0 ? ` · 승인번호 ${op.evidence.issueIds.join(", ")}` : "";
  const basis = op.evidence.basis.map((b) => BASIS_LABEL[b] ?? b).join("/");
  // ⚠️ 흡수한 차액은 **반드시** 문장에 남긴다 — 조용히 흡수하면 절삭인지 입력 오류인지
  //    사후에 구분할 수단이 사라진다(오너 요구). 응답이 아니라 여기가 영속 기록이다.
  const tolerated =
    op.evidence.toleratedDelta === null || op.evidence.toleratedDelta === 0
      ? ""
      : ` · ⚠️ 정산액과 ${op.evidence.toleratedDelta.toLocaleString("ko-KR")}원 차이를 허용오차로 흡수했습니다`;
  const fieldLabel = (FIELD_LABEL as Record<string, string>)[op.field] ?? op.field;
  return `메일 자동 확정: ${fieldLabel}을 ${op.writtenDate}로 기록했습니다(계산서 ${op.evidence.invoiceCount}장${amount}${ids} · 대조 근거 ${basis}${tolerated}).`;
}

async function handler(request: Request): Promise<Response> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
   * ⛔ **기본은 예행이다.** 쓰기를 켜려면 프로덕션 env 에 `TAX_INVOICE_AUTO_CONFIRM=1` 을
   * 명시해야 한다.
   *
   * 왜 필요한가: 이 크론은 머지→승격과 동시에 스케줄에 올라 **매일 스스로 쓴다.** 그런데
   * 오너 지시는 "자동 확정의 첫 실행은 오너 확인 하에"였다 — `?dryRun=1` 은 사람이 수동으로
   * 부를 때만 유효하고 **스케줄 발화를 막지 못한다.** env 게이트가 없으면 배포되는 순간
   * 그 조건이 깨진다.
   *
   * fail-safe 방향으로 기울인다: 변수 누락·오타는 "안 쓴다"로 떨어진다. 오너가 예행 결과를
   * 확인한 뒤 값을 켜면 **코드 변경 없이** 자동 확정이 시작되고, 이상이 보이면 값을 지우는
   * 것만으로 **되돌릴 수 있다**(배포·롤백 불요).
   */
  const writeEnabled = process.env.TAX_INVOICE_AUTO_CONFIRM === "1";
  const dryRunRequested = new URL(request.url).searchParams.get("dryRun") === "1";
  const dryRun = dryRunRequested || !writeEnabled;
  const prisma = getPrisma();

  /** 메일 조회 창의 시작일 — 판정이 「안 봤다」와 「안 왔다」를 가르는 데 쓴다. */
  const scanWindowFrom = new Date(Date.now() - SCAN_SINCE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // ── 1. 발행 기대 건. 그룹은 합산 인지형 진입점이 정리하고, 미그룹은 1건짜리 묶음으로 탄다.
  const facts = await loadCampaignSettlementFacts(prisma, { sinceDays: SCAN_SINCE_DAYS });
  const expected: ExpectedIssuance[] = [
    ...facts.solo.flatMap((item) => buildGroupExpectedIssuances([item])),
    ...[...facts.byGroup.values()].flatMap((members) => buildGroupExpectedIssuances(members)),
  ];

  // ── 2. 전용 메일함 스캔(읽기 전용·무흔적). 실패를 삼키면 "발행 0건"으로 오독돼
  //      레이더가 초록인 채 아무 일도 안 하는 상태가 된다 — 실질 실패로 선언한다.
  let scan;
  try {
    scan = await scanTaxInvoiceMails({
      sinceDays: SCAN_SINCE_DAYS,
      invoicePassword: SUPPLIER.businessNumber,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "메일함 조회에 실패했습니다.";
    return NextResponse.json(
      { failed: true, failureReason: `메일함 조회 실패: ${message}`, error: message },
      { status: 502 },
    );
  }

  // 첨부 파싱본만 판정에 넣는다 — 제목 폴백은 검증이 아니므로 자동 확정 근거가 될 수 없다.
  const invoices: ScannedIssuedInvoice[] = scan.mails.flatMap((mail) =>
    mail.parsed ? [{ mailUid: mail.uid, parsed: mail.parsed }] : [],
  );

  // ── 3. 판정(N:M) → 4. 쓰기 계획. 둘 다 순수 함수다.
  const { verdicts, unassigned } = matchIssuedInvoices({
    invoices,
    expected,
    ourBusinessNumber: SUPPLIER.businessNumber,
    // ⚠️ 기대 건은 캠페인 창(넓다)에서, 계산서는 메일 창(좁다)에서 나온다. 이 값을 안
    //    넘기면 그 차집합이 전부 「미발행 후보」로 세어져 **조회하지 않은 구간을 안 왔다고
    //    단정**한다(#297 과 같은 부류).
    scanWindowFromDate: scanWindowFrom,
    // 오너 확정(2026-08-06): 브랜드사의 100원 미만 절삭 관행만 흡수한다. 리터럴을 다시
    // 적지 않고 상수를 쓴다 — 수취·발행이 서로 다른 숫자를 들면 정책이 갈린다.
    // 흡수된 오차는 `AMOUNT_TOLERATED` 로 표면화되고 감사 로그에도 실린다(조용한 완화 아님).
    amountToleranceWon: SUB_HUNDRED_TRUNCATION_TOLERANCE_WON,
  });
  const plan = buildIssuanceWritePlan(verdicts, expected);

  const capped = plan.ops.slice(0, MAX_CONFIRMS_PER_RUN);
  const droppedByCap = plan.ops.length - capped.length;

  // ── 5. 집행. 계획 1건 = 트랜잭션 1개(대상 갱신 + 캠페인별 감사 로그).
  const applied: string[] = [];
  /** 계획은 섰지만 갱신 0건 — 다른 실행이 먼저 찍었다는 뜻이다(실패가 아니다). */
  const noop: string[] = [];
  const failures: Array<{ key: string; error: string }> = [];

  if (!dryRun) {
    for (const op of capped) {
      try {
        const wrote = await prisma.$transaction(async (tx) => {
          const value = new Date(`${op.writtenDate}T00:00:00.000Z`);

          const result =
            op.target.kind === "group"
              ? // 그룹 행이 SoT 다(`campaign-row.ts` 가 멤버에 폴딩) — 멤버 행에 쓰면 화면이
                // 안 바뀐다. `PATCH /api/campaigns/[id]` 의 `isGrouped` 분기와 같은 규칙이다.
                await tx.campaignGroup.updateMany({
                  // 이미 찍힌 값을 덮지 않는다 — 사람이 손으로 넣은 날짜를 기계가 밀어내지
                  // 않게 하는 마지막 방벽이자, 재실행 멱등성의 근거다.
                  where: { id: op.target.groupId, [op.field]: null },
                  data: { [op.field]: value },
                })
              : await tx.salesCampaign.updateMany({
                  where: { id: op.target.campaignId, [op.field]: null },
                  data: { [op.field]: value },
                });

          // ⛔ **0건이면 감사 로그를 남기지 않는다.** 위 WHERE 가드가 값을 지켜도, 로그를
          //    그대로 쓰면 **그 값을 감사하려고 만든 기록 자체가 오염된다** — "…로
          //    기록했습니다"라는 줄이 실제로는 아무것도 안 바꾼 실행에 붙는다.
          //    도달 경로: 스케줄 발화와 수동 실행 버튼이 같은 스냅샷을 동시에 읽는 경우
          //    (`alreadyMarkedAt` 가드는 **한 실행 안**에서만 유효하다).
          if (result.count === 0) return false;

          // ⚠️ `content` 는 **사람이 읽는 문장**이어야 한다 — `activity-timeline.tsx` 는
          //    아는 type(CHANGE·CREATE·DELETE)이 아니면 이 값을 **그대로** 렌더한다.
          //    JSON 을 넣으면 캠페인 타임라인에 원시 문자열이 뜬다.
          const content = summarizeConfirm(op);
          const toleratedDelta =
            op.evidence.toleratedDelta !== null && op.evidence.toleratedDelta !== 0;

          for (const campaignId of op.campaignIds) {
            await tx.activityLog.create({
              data: {
                entityType: "CAMPAIGN",
                entityId: campaignId,
                // 커스텀 type 이라 `@@index([type])` 로 "자동 확정된 건"만 뽑을 수 있다 —
                // 나중에 잘못 찍힌 건을 찾아내려면 이 축이 필요하다(수동 CHANGE 와 구분).
                //
                // ⛔ **흡수 건은 type 을 갈라 둔다.** 오너가 「이번 달 허용오차로 자동
                //    확정된 N건」을 보드에서 보게 할 예정인데(오너 확정 2026-08-06),
                //    한 type 에 몰아 두면 그 수를 세려고 `content` 한국어 문장을 파싱해야
                //    한다 — 문구를 다듬는 순간 조용히 0건이 된다. 인덱스된 컬럼으로 센다.
                //    "자동 확정 전체"는 `startsWith("TAX_INVOICE_AUTO_CONFIRM")` 로 잡는다.
                type: toleratedDelta
                  ? "TAX_INVOICE_AUTO_CONFIRM_TOLERATED"
                  : "TAX_INVOICE_AUTO_CONFIRM",
                fieldName: op.field,
                previousValue: null,
                newValue: op.writtenDate,
                content,
                actor: "SYSTEM",
              },
            });
          }
          return true;
        });
        if (wrote) applied.push(op.key);
        else noop.push(op.key);
      } catch (error) {
        // 한 건의 실패가 나머지를 막지 않는다. 삼키지도 않는다 — 응답에 싣는다.
        failures.push({
          key: op.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const byStatus = {
    confirmed: verdicts.filter((v) => v.status === "CONFIRMED").length,
    needsReview: verdicts.filter((v) => v.status === "NEEDS_REVIEW").length,
    unseen: verdicts.filter((v) => v.status === "UNSEEN").length,
    unmatchable: verdicts.filter((v) => v.status === "UNMATCHABLE").length,
    /**
     * 타당 구간이 통째로 메일 조회 창보다 이른 건 — **미발행이 아니라 미조회**다.
     * 0 이 아니면 이 크론의 자동화가 그만큼 못 미친다는 뜻이므로 `unseen` 과 합치지 않는다.
     */
    outOfScanRange: verdicts.filter((v) => v.status === "OUT_OF_SCAN_RANGE").length,
  };

  /**
   * `NEEDS_REVIEW` 건의 **왜**를 응답에 싣는다.
   *
   * 종전엔 집계 숫자만 냈다 — "확인 필요 2건"은 알아도 그 2건이 금액 불일치인지·수정계산서인지
   * 알 방법이 없어, 오너가 자동 확정을 켤지 판단할 근거가 부족했다(오너 요청 2026-08-06).
   *
   * ⚠️ `campaignLabel`·`counterpartLabel` 에는 셀러 실명이 들어갈 수 있다 — 이 응답은
   * `/api/system/cron-run`(세션 인증 뒤)을 통해서만 오너 브라우저에 도달하고, 저장처는
   * `SystemTaskLog`(운영 DB, git 미추적)다. **공개 레포에 커밋·주석으로 남기지 않는다**(P0).
   * 수취 판정(`/api/settlement/tax-invoice-receipts`)이 이미 같은 등급으로 실명을 오너
   * 응답에 싣고 있다 — 여기서도 같은 규약을 따른다.
   *
   * 상한은 **건수가 아니라 직렬화 바이트로** 건다. `SystemTaskLog.details` 는 4,000자를
   * 넘으면 객체 전체가 `{truncated, preview}` 로 대체되므로(`system-task-status.ts`),
   * 건수만 제한하면 항목이 길어질 때 이 필드보다 먼저 나온 집계 숫자까지 통째로 사라진다.
   * ⚠️ 처음 넣은 건수 상한 30은 이 봉투를 재보지 않고 고른 값이라 실제로는 3배 초과였다
   * (prod 실측 2026-08-07: 상세 제외 본문 1,383자 · 항목 평균 413자 → 약 6건이 한계).
   * 예산 2,000자면 본문이 지금의 1.4배로 자라도 봉투 안에 남는다. 잘리면 `capped` 로 고지한다.
   */
  const NEEDS_REVIEW_DETAIL_BUDGET_CHARS = 2_000;
  const expectedByKey = new Map(expected.map((item) => [item.key, item]));
  const needsReviewVerdicts = verdicts.filter((v) => v.status === "NEEDS_REVIEW");
  const needsReviewDetail: Array<Record<string, unknown>> = [];
  let needsReviewDetailChars = 0;
  for (const v of needsReviewVerdicts) {
    const item = expectedByKey.get(v.key);
    const entry = {
      key: v.key,
      campaignLabel: item?.campaignLabel ?? null,
      counterpartLabel: item?.counterpartLabel ?? null,
      channel: item?.channel ?? null,
      trackingField: item?.trackingField ?? null,
      reasons: v.reasons,
      observed: v.observed,
    };
    // 예산을 넘기느니 싣지 않는다 — 한 건을 더 넣으려다 집계 전체를 잃는 것이 훨씬 나쁘다.
    const entryChars = JSON.stringify(entry).length;
    if (needsReviewDetailChars + entryChars > NEEDS_REVIEW_DETAIL_BUDGET_CHARS) break;
    needsReviewDetail.push(entry);
    needsReviewDetailChars += entryChars;
  }

  return NextResponse.json({
    dryRun,
    /** 왜 예행인가 — 「env 가 꺼져 있다」와 「사람이 dryRun=1 로 불렀다」를 가른다. */
    dryRunReason: dryRun
      ? dryRunRequested
        ? "REQUESTED"
        : "TAX_INVOICE_AUTO_CONFIRM_NOT_SET"
      : null,
    // 스캔이 잘렸으면 화면·보고가 "전부 확인했다"고 말하면 안 된다.
    scan: {
      box: scan.box,
      headerScanned: scan.headerScanned,
      candidates: scan.candidates,
      skippedByFilter: scan.skippedByFilter,
      truncated: scan.truncated,
      parsedInvoices: invoices.length,
      sinceDays: SCAN_SINCE_DAYS,
      /** 화면이 「이 범위는 확인했다」고 말할 때 근거로 쓸 실제 시작일 */
      windowFrom: scanWindowFrom,
    },
    expectedTotal: expected.length,
    ...byStatus,
    needsReviewDetail,
    needsReviewDetailCapped: needsReviewDetail.length < needsReviewVerdicts.length,
    planned: plan.ops.length,
    applied: applied.length,
    /** 이미 찍혀 있어 아무것도 안 바꾼 건 — 감사 로그도 남기지 않았다. */
    noop: noop.length,
    droppedByCap,
    skipped: plan.skipped,
    failures,
    /** 어느 기대 건에도 붙지 못한 계산서 — 사유별로 갈라 둔다(사유 코드만, 실명 없음). */
    unassigned: unassigned.map((item) => ({ mailUid: item.mailUid, code: item.code })),
    // 쓰기가 한 건이라도 터졌으면 레이더를 빨강으로 — HTTP 200 을 성공으로 읽지 않는다.
    ...(failures.length > 0
      ? { failed: true, failureReason: `발행 확정 쓰기 ${failures.length}건 실패` }
      : {}),
  });
}

export const GET = withSystemTaskStatus("tax-invoice-issue-confirm", handler);
