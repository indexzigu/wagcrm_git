/**
 * 정산 체크리스트의 옛 라벨·누락 항목 소급 (설계 2026-08-09 §3).
 *
 * 배경: `ensureCampaignChecklistForStatus`는 항목이 이미 있으면 조기 반환하므로,
 * 템플릿(B1)을 고쳐도 기존 캠페인의 행은 그대로다. 이 스크립트가 두 가지를 소급한다.
 * ① 우리몰 라벨 오기 정정("공급사 매입 세금계산서 발행" → "…수취")
 * ② 셀러몰 구 3항목 템플릿에 머문 캠페인에 신설 2항목을 채운다.
 *
 * ⛔ **P0 — 이 스크립트는 프로덕션 Supabase 를 쓴다.** `--apply` 는 오너 승인 사안이다.
 * 예행이 기본이고, `isChecked`·`completedAt` 은 절대 건드리지 않는다(이미 체크된 행의
 * 완료 상태가 보존돼야 한다).
 *
 * 실행:
 *   npx tsx scripts/backfill-settlement-checklist-labels.ts            (예행, 기본)
 *   npx tsx scripts/backfill-settlement-checklist-labels.ts --apply     (실제 적용)
 */
import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import { resolveTaxFilingChannelGroup } from "../src/lib/tax-filing-board";

export const OLD_OWN_MALL_LABEL = "공급사 매입 세금계산서 발행";
export const NEW_OWN_MALL_LABEL = "공급사 매입 세금계산서 수취";

/** 셀러몰에서 누락됐던 항목 2종. 구 3항목 템플릿에 머문 캠페인이 대상이다. */
export const SELLER_MALL_ADDED = [
  { label: "공급사 물품대금 세금계산서 수취", sortOrder: 0 },
  { label: "공급사 물품대금 지급 완료", sortOrder: 4 },
] as const;

type ItemLite = { id: string; campaignId: string; label: string; status: string };
type CampaignLite = { id: string; salesChannel: string };

export type BackfillPlan = {
  labelUpdates: { id: string; from: string; to: string }[];
  itemInserts: { campaignId: string; label: string; sortOrder: number }[];
};

/**
 * 판정만 하는 순수 함수 — DB I/O 없음. 멱등성을 이 함수만으로 고정할 수 있다.
 */
export function planBackfill(items: ItemLite[], campaigns: CampaignLite[]): BackfillPlan {
  const stage = items.filter((i) => i.status === "SETTLEMENT_IN_PROGRESS");

  // ① 라벨 정정 — **완전 일치만**. 채널로 미리 좁히지 않는다(채널이 나중에 바뀐
  //    캠페인도 옛 라벨을 갖고 있을 수 있다).
  const labelUpdates = stage
    .filter((i) => i.label === OLD_OWN_MALL_LABEL)
    .map((i) => ({ id: i.id, from: OLD_OWN_MALL_LABEL, to: NEW_OWN_MALL_LABEL }));

  // ② 항목 추가 — 셀러몰이면서 **이미 체크리스트가 있는** 캠페인만.
  const byCampaign = new Map<string, Set<string>>();
  for (const i of stage) {
    const set = byCampaign.get(i.campaignId) ?? new Set<string>();
    set.add(i.label);
    byCampaign.set(i.campaignId, set);
  }
  const channelById = new Map(campaigns.map((c) => [c.id, resolveTaxFilingChannelGroup(c.salesChannel)]));

  const itemInserts: BackfillPlan["itemInserts"] = [];
  for (const [campaignId, labels] of byCampaign) {
    if (channelById.get(campaignId) !== "SELLER_MALL") continue;
    for (const template of SELLER_MALL_ADDED) {
      if (labels.has(template.label)) continue;
      itemInserts.push({ campaignId, label: template.label, sortOrder: template.sortOrder });
    }
  }

  return { labelUpdates, itemInserts };
}

/**
 * 예행 출력의 **분해** — 총계 두 줄로는 `--apply` 승인 근거가 만들어지지 않는다.
 *
 * 이 스크립트의 유일한 사전 검토 수단이 예행 출력이므로(P0 게이트), 오너가 "무엇이 몇 건
 * 바뀌는가"를 라벨 단위로 볼 수 있어야 한다. 총계만 보고 승인하면 게이트가 형식이 된다.
 *
 * ⛔ **캠페인 id·셀러명·거래처명은 절대 넣지 않는다**(P0 — 이 레포는 PUBLIC 이고, 오너가
 * 이 출력을 그대로 붙여넣을 수 있다). 라벨 문자열과 건수까지가 상한이다. 라벨은 템플릿에서
 * 온 고정 문자열이라 개체 식별 정보가 아니다.
 *
 * 순수 함수로 두는 이유: 출력 형식 자체가 게이트의 실효성이므로 테스트로 고정한다.
 */
export function formatPlanBreakdown(plan: BackfillPlan): string[] {
  const lines: string[] = [];

  const labelPairs = new Map<string, number>();
  for (const u of plan.labelUpdates) {
    const key = `"${u.from}" → "${u.to}"`;
    labelPairs.set(key, (labelPairs.get(key) ?? 0) + 1);
  }
  lines.push(`라벨 정정 ${plan.labelUpdates.length}건`);
  if (labelPairs.size === 0) {
    lines.push("  (없음)");
  } else {
    // 건수 내림차순 — 규모가 큰 정정이 위로 온다.
    for (const [key, count] of [...labelPairs].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${key}: ${count}건`);
    }
  }

  const insertLabels = new Map<string, number>();
  for (const i of plan.itemInserts) {
    insertLabels.set(i.label, (insertLabels.get(i.label) ?? 0) + 1);
  }
  // 항목 추가는 캠페인 수도 함께 말한다 — 라벨별 건수만 보면 "몇 개 캠페인이 손대지는가"를
  // 오너가 머릿속에서 나눠야 한다(한 캠페인에 최대 2항목이 들어간다).
  const affectedCampaigns = new Set(plan.itemInserts.map((i) => i.campaignId)).size;
  lines.push(`항목 추가 ${plan.itemInserts.length}건 (캠페인 ${affectedCampaigns}개)`);
  if (insertLabels.size === 0) {
    lines.push("  (없음)");
  } else {
    for (const [label, count] of [...insertLabels].sort((a, b) => b[1] - a[1])) {
      lines.push(`  "${label}": ${count}건`);
    }
  }

  return lines;
}

function hasApplyFlag(): boolean {
  return process.argv.includes("--apply");
}

async function loadPlanInputs(): Promise<{ items: ItemLite[]; campaigns: CampaignLite[] }> {
  const prisma = getPrisma();
  const items = await prisma.campaignChecklistItem.findMany({
    where: { status: "SETTLEMENT_IN_PROGRESS" },
    select: { id: true, campaignId: true, label: true, status: true },
  });
  const campaigns = await prisma.salesCampaign.findMany({
    where: { id: { in: [...new Set(items.map((i) => i.campaignId))] } },
    select: { id: true, salesChannel: true },
  });
  return { items, campaigns };
}

async function applyPlan(plan: BackfillPlan): Promise<void> {
  const prisma = getPrisma();
  for (const u of plan.labelUpdates) {
    // ⛔ label 만 바꾼다 — isChecked·completedAt 은 건드리지 않는다.
    await prisma.campaignChecklistItem.update({ where: { id: u.id }, data: { label: u.to } });
  }
  if (plan.itemInserts.length > 0) {
    await prisma.campaignChecklistItem.createMany({
      data: plan.itemInserts.map((i) => ({
        campaignId: i.campaignId,
        templateId: null,
        status: "SETTLEMENT_IN_PROGRESS",
        label: i.label,
        sortOrder: i.sortOrder,
        isRequired: true,
        isChecked: false,
      })),
    });
  }
}

async function main(): Promise<void> {
  const apply = hasApplyFlag();
  const { items, campaigns } = await loadPlanInputs();
  const plan = planBackfill(items, campaigns);

  console.log(
    `[backfill-settlement-checklist-labels] 모드: ${apply ? "APPLY(실제 적용)" : "DRY-RUN(예행)"}`
  );
  for (const line of formatPlanBreakdown(plan)) {
    console.log(`[backfill-settlement-checklist-labels] ${line}`);
  }

  if (!apply) {
    console.log(
      "[backfill-settlement-checklist-labels] 예행입니다. 실제로 반영하려면 --apply 를 붙이세요(오너 승인 사안)."
    );
    return;
  }

  await applyPlan(plan);
  console.log(
    `[backfill-settlement-checklist-labels] 반영 완료: 라벨 ${plan.labelUpdates.length}건 · 항목 ${plan.itemInserts.length}건`
  );
}

// 이 스크립트가 (테스트에서 순수함수를 재사용하기 위해) import될 때는 main()이 자동
// 실행되지 않도록 직접 실행된 경우에만 구동한다(import.meta.url 기준 — ESM 호환,
// backfill-child-deals.ts 와 동일 관용구).
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
      console.error("[backfill-settlement-checklist-labels] 실행 중 오류:", error);
      process.exit(1);
    });
}
