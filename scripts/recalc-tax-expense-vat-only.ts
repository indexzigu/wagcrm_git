/**
 * 개인 셀러 캠페인의 저장 공제세액(`SalesCampaign.taxExpense`)·영업이익(`operatingProfit`) 재계산.
 *
 * 배경(오너 확정 2026-10-16): 공제세액은 이제 **부가세만** 담는다(`computeVatExpense`). 그 전에
 *   저장된 개인 셀러 캠페인은 원천세 3.3% 가 공제세액에 들어 있어 영업이익이 원천세만큼 낮다
 *   (원천세는 셀러지급액 안에 이미 든 셀러 몫이다). 이 스크립트가 그 저장값을 새 산식으로 바꾼다.
 *
 * 판정은 `scripts/lib/tax-expense-recalc.ts`(`planTaxExpenseRecalc`, 테스트 고정)가 한다:
 *   사업자·수동 공제세액·금액 빈 행은 건너뛰고, 「저장값 − 새 값 = 원천세」 검산이 맞는 행만 쓴다.
 *   검산이 안 맞는 행(REVIEW)은 ⛔ 쓰지 않고 사유만 찍는다 — 오너가 보고 판단한다.
 *
 * 쓰기는 `taxExpense`·`operatingProfit` 두 칸뿐이고, 읽은 뒤 계산에 쓴 금액(수수료매출·셀러지급액·
 *   공제세액·영업이익)이 바뀌었거나 수동으로 돌아섰으면 쓰지 않는다(조건부 updateMany — 건수 0 이면 「건너뜀」).
 *
 * 사용(레포 .env 는 **프로덕션 DB** 다 — P0. 실행은 오너 몫):
 *   set -a; source .env; set +a; npx tsx scripts/recalc-tax-expense-vat-only.ts              # 예행(기본, 쓰기 없음)
 *   set -a; source .env; set +a; npx tsx scripts/recalc-tax-expense-vat-only.ts --id=<id>    # 한 건만
 *   set -a; source .env; set +a; npx tsx scripts/recalc-tax-expense-vat-only.ts --apply      # 실제 DB 반영(오너 승인 사안)
 *
 * 설계 정본: docs/private/specs/2026-10-16-settlement-tax-split-design.md §5-2
 */
import { getPrisma } from "../src/lib/prisma";
import {
  planTaxExpenseRecalc,
  type TaxExpenseRecalcKind,
  type TaxExpenseRecalcRow,
} from "./lib/tax-expense-recalc";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const idArg = args.find((a) => a.startsWith("--id="))?.slice("--id=".length) ?? "";

const toNumber = (value: unknown): number | null => (value == null ? null : Number(value));
const krw = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString("ko-KR"));

async function main() {
  const prisma = getPrisma();
  console.log(`[recalc-tax-expense] 모드: ${APPLY ? "적용(--apply)" : "예행(쓰기 없음)"}${idArg ? ` · id=${idArg}` : ""}`);

  const campaigns = await prisma.salesCampaign.findMany({
    where: idArg ? { id: idArg } : undefined,
    select: {
      id: true,
      status: true,
      isManualTaxExpense: true,
      sellerTaxType: true,
      settlementSales: true,
      sellerExpense: true,
      taxExpense: true,
      operatingExpense: true,
      miscExpense: true,
      operatingProfit: true,
      _count: { select: { campaignDeals: true } },
      seller: { select: { alias: true, name: true, agency: { select: { businessNumber: true } } } },
    },
    orderBy: { startDate: "asc" },
  });

  const counts: Record<TaxExpenseRecalcKind, number> = {
    SKIP_BUSINESS: 0,
    SKIP_MANUAL_TAX: 0,
    SKIP_MISSING: 0,
    APPLY: 0,
    REVIEW: 0,
  };
  const applyTargets: Array<{
    id: string;
    prev: { taxExpense: number; settlementSales: number; sellerExpense: number; operatingProfit: number };
    nextTaxExpense: number;
    nextOperatingProfit: number;
  }> = [];

  for (const campaign of campaigns) {
    const row: TaxExpenseRecalcRow = {
      id: campaign.id,
      isManualTaxExpense: campaign.isManualTaxExpense,
      sellerTaxType: campaign.sellerTaxType,
      sellerCompanyBusinessNumber: campaign.seller.agency?.businessNumber ?? null,
      dealCount: campaign._count.campaignDeals,
      settlementSales: toNumber(campaign.settlementSales),
      sellerExpense: toNumber(campaign.sellerExpense),
      taxExpense: toNumber(campaign.taxExpense),
      operatingExpense: toNumber(campaign.operatingExpense),
      miscExpense: toNumber(campaign.miscExpense),
      operatingProfit: toNumber(campaign.operatingProfit),
    };
    const plan = planTaxExpenseRecalc(row);
    counts[plan.kind] += 1;
    // 사업자 행은 찍지 않는다(바뀌지 않는 대다수 — 건수만 센다).
    if (plan.kind === "SKIP_BUSINESS") continue;

    const sellerLabel = campaign.seller.alias || campaign.seller.name;
    console.log(
      [
        campaign.id,
        sellerLabel,
        campaign.status,
        plan.kind,
        `공제세액 ${krw(row.taxExpense)} → ${krw(plan.nextTaxExpense)}`,
        `영업이익 ${krw(row.operatingProfit)} → ${krw(plan.nextOperatingProfit)}`,
        `차이 ${krw(plan.delta)}`,
        plan.reason ?? "",
      ].join(" | "),
    );
    if (plan.kind === "APPLY") {
      applyTargets.push({
        id: campaign.id,
        prev: {
          taxExpense: row.taxExpense!,
          settlementSales: row.settlementSales!,
          sellerExpense: row.sellerExpense!,
          operatingProfit: row.operatingProfit!,
        },
        nextTaxExpense: plan.nextTaxExpense!,
        nextOperatingProfit: plan.nextOperatingProfit!,
      });
    }
  }

  console.log(
    `[recalc-tax-expense] 대상 ${campaigns.length}건 — 적용 ${counts.APPLY} · 검토 ${counts.REVIEW} · ` +
      `수동 공제세액 ${counts.SKIP_MANUAL_TAX} · 금액 없음 ${counts.SKIP_MISSING} · 사업자 ${counts.SKIP_BUSINESS}`,
  );

  if (!APPLY) {
    console.log("[recalc-tax-expense] 예행이라 쓰지 않았다. 반영하려면 --apply 를 붙여 다시 실행한다.");
    return;
  }

  let written = 0;
  let skippedChanged = 0;
  for (const target of applyTargets) {
    // 읽은 뒤 계산에 쓴 금액이 하나라도 바뀌었거나 수동으로 돌아선 행은 쓰지 않는다.
    const result = await prisma.salesCampaign.updateMany({
      where: { id: target.id, isManualTaxExpense: false, ...target.prev },
      data: { taxExpense: target.nextTaxExpense, operatingProfit: target.nextOperatingProfit },
    });
    if (result.count === 1) written += 1;
    else {
      skippedChanged += 1;
      console.warn(`[recalc-tax-expense] 건너뜀(읽은 뒤 값이 바뀜): ${target.id}`);
    }
  }
  console.log(`[recalc-tax-expense] 적용 완료 — 씀 ${written}건 · 건너뜀 ${skippedChanged}건`);
}

const isDirectRun = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[recalc-tax-expense] 실행 중 오류:", error);
      process.exit(1);
    });
}
