// CG-1 (D5) — 과거 캠페인 소급 조합 그룹핑 스크립트.
//
// 배경(블루프린트 §4): `groupId IS NULL` 캠페인들을 (같은 셀러 · 기간 근접) 기준으로
// 묶어 조합 캠페인 그룹 후보를 제안한다. 클러스터링 정본은 src/lib/campaign-group-clustering,
// 그룹 생성 정본은 campaignGroupService.createGroup — 이 스크립트는 로직을 복제하지 않고
// 두 정본을 호출·리포트만 한다.
//
// 안전 규칙:
// - 기본 dry-run(제안 테이블 출력만). `--apply` 플래그가 있을 때만 실제 그룹을 생성한다.
//   ⚠️ 원격/prod DB 대상 `--apply`는 소유자 게이트 — 이 스크립트가 임의로 원격에 쓰지 않는다.
// - `--seller <sellerId>`로 특정 셀러만 부분 승인/실행.
// - `--window <days>`로 근접 윈도우(일) 조정(기본 3). dry-run 1회로 실분포 보정용.
// - DATABASE_URL 환경변수를 그대로 사용한다(로컬 sqlite/원격 postgres 양쪽). 단독 실행 시
//   .env가 로드돼야 하므로 `source .env`를 선행하거나 dotenv/config가 .env를 읽도록 한다.
//
// 실행:
//   npx tsx scripts/backfill-campaign-groups.ts                 (dry-run, 전체)
//   npx tsx scripts/backfill-campaign-groups.ts --seller <id>    (dry-run, 셀러 한정)
//   npx tsx scripts/backfill-campaign-groups.ts --window 5       (dry-run, 윈도우 5일)
//   npx tsx scripts/backfill-campaign-groups.ts --apply          (실제 그룹 생성 — 게이트 확인)

import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import {
  clusterByDateWindow,
  type CampaignClusterInput,
} from "../src/lib/campaign-group-clustering";
import { campaignGroupService } from "../src/services/campaignGroupService";

export const DEFAULT_WINDOW_DAYS = 3;

/** 클러스터링 입력 + 리포트 표기 필드. */
export type BackfillCampaign = CampaignClusterInput & {
  campaignName: string | null;
  dealName: string;
  sellerLabel: string;
};

export type BackfillArgs = {
  apply: boolean;
  sellerId: string | null;
  windowDays: number;
};

/** argv를 파싱한다(순수). */
export function parseArgs(argv: string[]): BackfillArgs {
  const apply = argv.includes("--apply");

  const sellerIdx = argv.indexOf("--seller");
  const sellerId = sellerIdx >= 0 ? argv[sellerIdx + 1] ?? null : null;

  const windowIdx = argv.indexOf("--window");
  const parsedWindow = windowIdx >= 0 ? Number(argv[windowIdx + 1]) : NaN;
  const windowDays = Number.isFinite(parsedWindow) && parsedWindow >= 0 ? parsedWindow : DEFAULT_WINDOW_DAYS;

  return { apply, sellerId, windowDays };
}

function toDateRangeLabel(startDate: Date, endDate: Date): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `${fmt(startDate)} ~ ${fmt(endDate)}`;
}

async function loadUngroupedCampaigns(sellerId: string | null): Promise<BackfillCampaign[]> {
  const prisma = getPrisma();
  const rows = await prisma.salesCampaign.findMany({
    where: { groupId: null, ...(sellerId ? { sellerId } : {}) },
    select: {
      id: true,
      sellerId: true,
      dealId: true,
      startDate: true,
      endDate: true,
      campaignName: true,
      deal: { select: { dealName: true } },
      seller: { select: { name: true, alias: true } },
    },
    orderBy: [{ sellerId: "asc" }, { startDate: "asc" }],
  });

  return rows.map((r) => ({
    id: r.id,
    sellerId: r.sellerId,
    dealId: r.dealId,
    startDate: r.startDate,
    endDate: r.endDate,
    campaignName: r.campaignName,
    dealName: r.deal?.dealName ?? "(딜 없음)",
    sellerLabel: r.seller?.alias || r.seller?.name || "(셀러 없음)",
  }));
}

function printProposals(proposals: BackfillCampaign[][], windowDays: number): void {
  console.log(`[backfill-campaign-groups] 근접 윈도우: ${windowDays}일`);
  console.log(`[backfill-campaign-groups] 제안 그룹 수(멤버 ≥2): ${proposals.length}`);
  proposals.forEach((cluster, i) => {
    const label = cluster[0].sellerLabel;
    const range = toDateRangeLabel(
      cluster.reduce((min, c) => (c.startDate < min ? c.startDate : min), cluster[0].startDate),
      cluster.reduce((max, c) => (c.endDate > max ? c.endDate : max), cluster[0].endDate),
    );
    console.log(`\n  [${i + 1}] 셀러: ${label} · 기간: ${range} · 멤버 ${cluster.length}건`);
    for (const c of cluster) {
      console.log(`      - ${c.campaignName ?? c.dealName} (${c.id})`);
    }
  });
}

function printSameDealSplits(
  splits: Array<{ sellerId: string; dealId: string; campaignId: string }>,
): void {
  if (splits.length === 0) return;
  console.log(
    `\n[backfill-campaign-groups] 같은 딜 중복으로 분리된 캠페인(회차 오인 방지, 그룹 제외) ${splits.length}건:`,
  );
  for (const s of splits) {
    console.log(`      - campaign ${s.campaignId} (deal ${s.dealId}, seller ${s.sellerId})`);
  }
}

async function applyProposals(proposals: BackfillCampaign[][]): Promise<number> {
  let created = 0;
  for (const cluster of proposals) {
    const memberIds = cluster.map((c) => c.id);
    const group = await campaignGroupService.createGroup(memberIds);
    created++;
    console.log(`[backfill-campaign-groups] 그룹 생성: ${group.id} — "${group.name ?? ""}" (${memberIds.length}건)`);
  }
  return created;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill-campaign-groups] 모드: ${args.apply ? "APPLY(실제 그룹 생성)" : "DRY-RUN(출력만)"}${
      args.sellerId ? ` · 셀러 한정: ${args.sellerId}` : ""
    }`,
  );

  const campaigns = await loadUngroupedCampaigns(args.sellerId);
  console.log(`[backfill-campaign-groups] 미그룹 캠페인 수: ${campaigns.length}`);

  const { proposals, sameDealSplits } = clusterByDateWindow(campaigns, args.windowDays);
  printProposals(proposals, args.windowDays);
  printSameDealSplits(sameDealSplits);

  if (args.apply) {
    const created = await applyProposals(proposals);
    console.log(`\n[backfill-campaign-groups] ${created}개 그룹 생성 완료.`);
  } else {
    console.log(
      "\n[backfill-campaign-groups] dry-run 모드입니다. 실제로 적용하려면 --apply 플래그를 추가하세요(원격 DB는 소유자 게이트).",
    );
  }
}

// 테스트에서 순수함수(parseArgs 등)를 재사용할 때 main()이 자동 실행되지 않도록,
// 직접 실행된 경우에만 구동한다(import.meta.url 기준 — ESM 호환).
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
      console.error("[backfill-campaign-groups] 실행 중 오류:", error);
      process.exit(1);
    });
}
