// C2-2 — 자식 딜(하위 옵션) 데이터 위생 백필 스크립트.
//
// 배경(청사진 §C2-2): dealService.createDeal의 근본 원인 버그(C2-1)로 인해 기존에 생성된
// 자식 딜(parentDealId IS NOT NULL)은 brandName/unit/unitQuantity가 대부분 null로 저장되어
// 있다. 이 스크립트는 부모 딜 및 자식 dealName으로부터 값을 추정해 채운다.
//
// 안전 규칙:
// - 기본 dry-run(출력만). `--apply` 플래그가 있을 때만 실제 DB write를 수행한다.
// - 부모 접두어로 시작하지 않는 비정형 자식 이름은 변경하지 않고 리포트에만 나열한다
//   (dealName 자체를 변경하는 것은 스코프 밖 — 사용자 판단).
// - DATABASE_URL 환경변수를 그대로 사용한다(로컬 sqlite/원격 postgres 양쪽 동작).
//
// 실행:
//   npx tsx scripts/backfill-child-deals.ts            (dry-run, 기본)
//   npx tsx scripts/backfill-child-deals.ts --apply     (실제 적용)

import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import { inferQuantityFromName, hasWordBoundaryPrefix } from "../src/lib/price-monitor/query-builder";

/** 이름에서 일반적인 수량 단위를 추정할 때 시도할 단위 후보(청사진 §C2-2 명시 목록). */
export const COMMON_UNITS = ["박스", "통", "개", "세트", "팩", "병", "포", "캔", "스틱"] as const;

export type ChildDealForBackfill = {
  id: string;
  dealName: string;
  brandName: string | null;
  unit: string | null;
  unitQuantity: number | null;
  parentDealName: string | null;
  parentBrandName: string | null;
  parentUnit: string | null;
};

export type BackfillFieldPlan = {
  brandName?: string;
  unit?: string;
  unitQuantity?: number;
};

export type BackfillPlanEntry = {
  id: string;
  dealName: string;
  isStandardName: boolean;
  fields: BackfillFieldPlan;
};

/**
 * dealName에서 "숫자+일반단위" 패턴(청사진 목록: 박스|통|개|세트|팩|병|포|캔|스틱)을 찾아
 * 단위를 추정한다. 숫자가 선행하는 경우만 인정한다(예: "4박스"는 인정, "박스"는 불인정).
 */
export function inferUnitFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  for (const unit of COMMON_UNITS) {
    const match = name.match(new RegExp(`\\d+\\s*${unit}`));
    if (match) return unit;
  }
  return null;
}

/**
 * 자식 dealName이 부모 dealName 접두어로 시작하는지(trim 기준, 단어 경계 포함) 판별한다.
 * query-builder.extractOptionToken/hasWordBoundaryPrefix와 동일한 판정 로직을 공유한다
 * (Critical 2 회귀 수정 — "레몬즙".startsWith("레몬") 같은 부분 문자열 오매치를 정형으로
 * 오판하지 않는다).
 */
export function isStandardChildName(childDealName: string, parentDealName: string | null): boolean {
  if (!parentDealName) return false;
  return hasWordBoundaryPrefix(childDealName.trim(), parentDealName.trim());
}

/**
 * 자식 딜 1건에 대한 백필 계획을 순수하게 계산한다(DB I/O 없음).
 * - brandName null → 부모 brandName.
 * - unit null → 부모 unit ?? 이름에서 일반 단위 추정.
 * - unitQuantity null → inferQuantityFromName(dealName, resolvedUnit).
 * - 비정형 이름(부모 접두어로 시작하지 않음)은 fields가 비어 있어도 isStandardName=false로
 *   표시되어 리포트에 별도 나열될 수 있게 한다(호출부가 판단).
 */
export function planBackfillForChild(child: ChildDealForBackfill): BackfillPlanEntry {
  const isStandardName = isStandardChildName(child.dealName, child.parentDealName);
  const fields: BackfillFieldPlan = {};

  if (child.brandName == null && child.parentBrandName != null) {
    fields.brandName = child.parentBrandName;
  }

  const resolvedUnit = child.unit ?? child.parentUnit ?? inferUnitFromName(child.dealName);
  if (child.unit == null && resolvedUnit != null) {
    fields.unit = resolvedUnit;
  }

  if (child.unitQuantity == null) {
    const inferredQty = inferQuantityFromName(child.dealName, resolvedUnit);
    if (inferredQty != null) {
      fields.unitQuantity = inferredQty;
    }
  }

  return {
    id: child.id,
    dealName: child.dealName,
    isStandardName,
    fields,
  };
}

export type BackfillSummary = {
  targetCount: number;
  filledCounts: { brandName: number; unit: number; unitQuantity: number };
  nonStandardNames: Array<{ id: string; dealName: string }>;
  plans: BackfillPlanEntry[];
};

/** planBackfillForChild 결과들을 집계해 요약을 만든다(순수함수). */
export function summarizeBackfillPlans(children: ChildDealForBackfill[]): BackfillSummary {
  const plans = children.map(planBackfillForChild);
  const filledCounts = { brandName: 0, unit: 0, unitQuantity: 0 };
  const nonStandardNames: Array<{ id: string; dealName: string }> = [];

  for (const plan of plans) {
    if (plan.fields.brandName !== undefined) filledCounts.brandName++;
    if (plan.fields.unit !== undefined) filledCounts.unit++;
    if (plan.fields.unitQuantity !== undefined) filledCounts.unitQuantity++;
    if (!plan.isStandardName) {
      nonStandardNames.push({ id: plan.id, dealName: plan.dealName });
    }
  }

  return {
    targetCount: children.length,
    filledCounts,
    nonStandardNames,
    plans,
  };
}

function hasApplyFlag(): boolean {
  return process.argv.includes("--apply");
}

async function loadChildDealsForBackfill(): Promise<ChildDealForBackfill[]> {
  const prisma = getPrisma();
  const children = await prisma.deal.findMany({
    where: { parentDealId: { not: null } },
    select: {
      id: true,
      dealName: true,
      brandName: true,
      unit: true,
      unitQuantity: true,
      parentDeal: {
        select: {
          dealName: true,
          brandName: true,
          unit: true,
        },
      },
    },
  });

  return children.map((c) => ({
    id: c.id,
    dealName: c.dealName,
    brandName: c.brandName,
    unit: c.unit,
    unitQuantity: c.unitQuantity,
    parentDealName: c.parentDeal?.dealName ?? null,
    parentBrandName: c.parentDeal?.brandName ?? null,
    parentUnit: c.parentDeal?.unit ?? null,
  }));
}

async function applyBackfillPlans(plans: BackfillPlanEntry[]): Promise<void> {
  const prisma = getPrisma();
  for (const plan of plans) {
    if (Object.keys(plan.fields).length === 0) continue;
    await prisma.deal.update({
      where: { id: plan.id },
      data: plan.fields,
    });
  }
}

function printSummary(summary: BackfillSummary, applied: boolean): void {
  console.log(`[backfill-child-deals] 모드: ${applied ? "APPLY(실제 적용)" : "DRY-RUN(출력만)"}`);
  console.log(`[backfill-child-deals] 대상 자식 딜 수: ${summary.targetCount}`);
  console.log(
    `[backfill-child-deals] 필드별 채움 수 — brandName: ${summary.filledCounts.brandName}, unit: ${summary.filledCounts.unit}, unitQuantity: ${summary.filledCounts.unitQuantity}`
  );
  console.log(`[backfill-child-deals] 비정형 이름(부모 접두어 없음, 변경 없음) 수: ${summary.nonStandardNames.length}`);
  if (summary.nonStandardNames.length > 0) {
    console.log("[backfill-child-deals] 비정형 이름 목록:");
    for (const item of summary.nonStandardNames) {
      console.log(`  - ${item.id}: "${item.dealName}"`);
    }
  }
}

async function main(): Promise<void> {
  const apply = hasApplyFlag();
  const children = await loadChildDealsForBackfill();
  const summary = summarizeBackfillPlans(children);

  printSummary(summary, apply);

  if (apply) {
    const writablePlans = summary.plans.filter((p) => Object.keys(p.fields).length > 0);
    await applyBackfillPlans(writablePlans);
    console.log(`[backfill-child-deals] ${writablePlans.length}건 적용 완료.`);
  } else {
    console.log("[backfill-child-deals] dry-run 모드입니다. 실제로 적용하려면 --apply 플래그를 추가하세요.");
  }
}

// 이 스크립트가 (테스트에서 순수함수를 재사용하기 위해) import될 때는 main()이 자동
// 실행되지 않도록 직접 실행된 경우에만 구동한다(import.meta.url 기준 — ESM 호환).
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
      console.error("[backfill-child-deals] 실행 중 오류:", error);
      process.exit(1);
    });
}
