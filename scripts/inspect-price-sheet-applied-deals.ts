/**
 * 가격표 반영으로 생성된 딜 조회 · 정리 (2026-08-01 설계 §5).
 *
 * ⚠️ 레포 `.env`의 DATABASE_URL은 **프로덕션 Supabase DB**다(P0).
 * 기본 동작은 **조회 전용**이고, 삭제는 `--apply`가 있을 때만 한다.
 *
 *   npx tsx scripts/inspect-price-sheet-applied-deals.ts
 *   npx tsx scripts/inspect-price-sheet-applied-deals.ts --proposal <id>
 *   npx tsx scripts/inspect-price-sheet-applied-deals.ts --proposal <id> --apply
 *
 * ── 왜 브랜드·생성일로 찾지 않는가 ──────────────────────────────────────
 * "브랜드 X + 오늘 생성 + parentDealId null"로 긁으면 **손으로 만든 딜이
 * 섞여 들어온다**. 반영 실행기는 ActionProposal(requestType
 * "price_sheet_apply")의 executionResult.results[]에 생성한 딜 id를 그대로
 * 남기므로, 그게 "이 반영이 만든 딜"의 유일한 확정 근거다.
 *
 * ── 삭제 경로 ───────────────────────────────────────────────────────────
 * dealService.deleteDeal 을 쓴다 — 캠페인 연결 가드(DealDeletionBlockedError)와
 * 연관 레코드 정리가 이미 그 안에 있다. 이 삭제 경로의 라우트는 외부 IO 훅이
 * 없고 `revalidateMasterDataCaches()`만 부르므로, 스크립트 직접 호출로 빠지는
 * 것은 **Next 캐시 무효화뿐이다**(codebase-map의 after() 훅 함정 확인 완료).
 * 그래서 삭제 후 CRM 딜 목록이 잠시 낡아 보일 수 있다 — 아래 마지막에 안내한다.
 */
import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import { parseStoredJson } from "../src/lib/stored-json";
import { dealService } from "../src/services/dealService";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const proposalIdArg = (() => {
  const i = args.indexOf("--proposal");
  return i >= 0 ? args[i + 1] : null;
})();

type ExecResult = { results?: Array<{ dealId?: string; action?: string }> };

async function main() {
  const prisma = getPrisma();

  const proposals = await prisma.actionProposal.findMany({
    where: {
      requestType: "price_sheet_apply",
      status: "EXECUTED",
      ...(proposalIdArg ? { id: proposalIdArg } : {}),
    },
    orderBy: { executedAt: "desc" },
    take: proposalIdArg ? 1 : 10,
    select: {
      id: true,
      title: true,
      targetEntityId: true,
      executedAt: true,
      executionResult: true,
    },
  });

  if (proposals.length === 0) {
    console.log("가격표 반영 이력(EXECUTED)이 없습니다.");
    return;
  }

  for (const p of proposals) {
    // raw Prisma 로 읽은 Json 은 SQLite 에서 문자열이다 — 캐스팅하면 0건으로 보인다.
    const created = (parseStoredJson<ExecResult>(p.executionResult)?.results ?? [])
      .filter((r) => r.action === "CREATE" && r.dealId)
      .map((r) => r.dealId!);

    console.log("\n" + "=".repeat(72));
    console.log(`제안 ${p.id}`);
    console.log(`  시트: ${p.targetEntityId}  실행: ${p.executedAt?.toISOString() ?? "-"}`);
    console.log(`  생성 기록된 딜: ${created.length}건`);

    if (created.length === 0) continue;

    const deals = await prisma.deal.findMany({
      where: { id: { in: created } },
      select: {
        id: true,
        dealName: true,
        brandName: true,
        dealType: true,
        parentDealId: true,
        status: true,
        partner: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const missing = created.length - deals.length;
    if (missing > 0) console.log(`  (이미 삭제됨: ${missing}건)`);

    // 딸린 데이터 집계 — 캠페인만이 삭제를 '차단'하고, 나머지는 deleteDeal이 정리한다.
    const ids = deals.map((d) => d.id);
    const [campaigns, campaignDeals, tasks, outreaches, claims, templates, snapshots, assets, children] =
      await Promise.all([
        prisma.salesCampaign.groupBy({ by: ["dealId"], where: { dealId: { in: ids } }, _count: true }),
        prisma.campaignDeal.groupBy({ by: ["dealId"], where: { dealId: { in: ids } }, _count: true }),
        prisma.salesTask.groupBy({ by: ["dealId"], where: { dealId: { in: ids } }, _count: true }),
        prisma.sellerOutreach.groupBy({ by: ["dealId"], where: { dealId: { in: ids } }, _count: true }),
        prisma.dealClaim.groupBy({ by: ["dealId"], where: { dealId: { in: ids } }, _count: true }),
        prisma.campaignTemplate.groupBy({ by: ["dealId"], where: { dealId: { in: ids } }, _count: true }),
        prisma.priceMonitorSnapshot.groupBy({ by: ["dealId"], where: { dealId: { in: ids } }, _count: true }),
        prisma.asset.groupBy({ by: ["entityId"], where: { entityType: "DEAL", entityId: { in: ids } }, _count: true }),
        prisma.deal.groupBy({ by: ["parentDealId"], where: { parentDealId: { in: ids } }, _count: true }),
      ]);

    const tally = (rows: Array<Record<string, unknown>>, key: string) =>
      new Map(rows.map((r) => [String(r[key]), Number((r as { _count: number })._count)]));

    const byCampaign = tally(campaigns, "dealId");
    const byCampaignDeal = tally(campaignDeals, "dealId");
    const byTask = tally(tasks, "dealId");
    const byOutreach = tally(outreaches, "dealId");
    const byClaim = tally(claims, "dealId");
    const byTemplate = tally(templates, "dealId");
    const bySnapshot = tally(snapshots, "dealId");
    const byAsset = tally(assets, "entityId");
    const byChild = tally(children, "parentDealId");

    const blocked: string[] = [];
    console.log("");
    for (const d of deals) {
      const c = byCampaign.get(d.id) ?? 0;
      if (c > 0) blocked.push(d.id);
      const attach = [
        c && `캠페인 ${c}`,
        (byCampaignDeal.get(d.id) ?? 0) && `조합 ${byCampaignDeal.get(d.id)}`,
        (byTask.get(d.id) ?? 0) && `태스크 ${byTask.get(d.id)}`,
        (byOutreach.get(d.id) ?? 0) && `아웃리치 ${byOutreach.get(d.id)}`,
        (byClaim.get(d.id) ?? 0) && `클레임 ${byClaim.get(d.id)}`,
        (byTemplate.get(d.id) ?? 0) && `템플릿 ${byTemplate.get(d.id)}`,
        (bySnapshot.get(d.id) ?? 0) && `가격스냅샷 ${bySnapshot.get(d.id)}`,
        (byAsset.get(d.id) ?? 0) && `자산 ${byAsset.get(d.id)}`,
        (byChild.get(d.id) ?? 0) && `하위딜 ${byChild.get(d.id)}`,
      ]
        .filter(Boolean)
        .join(", ");
      const mark = c > 0 ? "⛔" : attach ? "•" : "○";
      console.log(
        `  ${mark} ${d.dealName}  [${d.dealType}${d.parentDealId ? "/자식" : ""}]` +
          ` 브랜드=${d.brandName ?? "-"} 거래처=${d.partner?.name ?? "-"} 상태=${d.status}` +
          (attach ? `\n       └ ${attach}` : "")
      );
    }

    console.log("");
    console.log(`  ○ 딸린 데이터 없음: ${deals.filter((d) => !(byCampaign.get(d.id) ?? 0)).length}건 삭제 가능`);
    if (blocked.length > 0) {
      console.log(`  ⛔ 캠페인 연결로 삭제 차단: ${blocked.length}건 — 이 건들은 건드리지 않습니다.`);
    }

    if (!APPLY) {
      console.log("\n  (조회 전용. 삭제하려면 --proposal <id> --apply)");
      continue;
    }
    if (!proposalIdArg) {
      console.log("\n  ⚠️ --apply 는 --proposal <id> 와 함께만 씁니다(대상 특정 강제).");
      continue;
    }

    console.log("\n  삭제 실행...");
    let ok = 0;
    const failed: Array<{ name: string; reason: string }> = [];
    // 자식 딜은 부모 삭제 시 함께 지워지므로, 부모(최상위)부터 지우고 이미 사라진 건 건너뛴다.
    for (const d of deals.filter((x) => !x.parentDealId)) {
      try {
        await dealService.deleteDeal(d.id, "SCRIPT/price-sheet-cleanup");
        ok += 1;
      } catch (err) {
        failed.push({ name: d.dealName, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    console.log(`  삭제 완료 ${ok}건` + (failed.length ? `, 실패 ${failed.length}건` : ""));
    for (const f of failed) console.log(`    ✗ ${f.name} — ${f.reason}`);
    console.log("\n  ℹ️ CRM 딜 목록 캐시는 이 스크립트가 깨지 못합니다 — 목록에 잠시 남아 보이면");
    console.log("     화면에서 딜을 하나 만들거나 고치면 무효화됩니다.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
