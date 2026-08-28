// 기존 CampaignGroup 정산 예정일/완료 블록 승계 백필 — 그룹 형성 시 멤버의
// expectedDepositDate/expectedPayoutDate(+완료 플래그 페어)가 그룹으로 승계되지
// 않던 버그의 "이미 형성된 그룹" 소급분 복구용.
//
// 배경(버그 2026-07): campaignGroupService.recomputeGroup이 기간·이름만 롤업하고
// 정산 블록은 null로 남겼다. CG-2 dual-read는 "그룹 정본·무폴백"이라 그룹 예정일
// null + 멤버 예정일 존재 조합에서 캘린더 자금 도트·정산 테이블 예정일이 통째로
// 사라졌다. 서비스는 수정됐고(신규 그룹은 형성 시 승계), 이 스크립트는 수정 전에
// 형성된 기존 그룹만 소급 승계한다.
//
// 판정 정본을 복제하지 않는다:
//   - 승계 규칙: campaignGroupService.rollupSettlementBlock (예정일=멤버 max,
//     완료 플래그=전 멤버 완료 시에만 true + 완료시각 max 페어링)
//   - virgin 판정: 서비스 inheritGroupSettlement와 동일 — 블록(예정일·완료시각·
//     플래그)에 신호가 전무한 그룹만 채운다. 오너가 그룹에 이미 기록한 값은 덮지 않는다.
//
// ⚠️ 한계(read 시점 구분 불가): 오너가 예정일을 **명시적으로 지운(→null)** 그룹은
//    "한 번도 승계 안 된 그룹"과 DB상 구별되지 않는다 — 이 스크립트는 후자를 노리지만
//    전자도 멤버 잔존값으로 채워버릴 수 있다. 반드시 dry-run 출력을 오너가 눈으로
//    검토해, 의도적으로 비운 그룹이 목록에 없는지 확인한 뒤에만 --apply 한다.
//
// 안전 규칙(P0: repo .env = 프로덕션 Supabase DB):
//   - 기본 dry-run. 실제 쓰기는 --apply 플래그가 있을 때만.
//   - ⚠️ --apply는 오너 승인 게이트다. 오너 확인 없이 실행 금지.
//   - 단독 실행 시 .env 로드 필요(memory: wag-crm-script-env-loading) —
//     dotenv/config가 .env를 읽는다.
//
// 실행:
//   npx tsx scripts/backfill-campaign-group-settlement-dates.ts            (dry-run)
//   npx tsx scripts/backfill-campaign-group-settlement-dates.ts --apply    (실제 쓰기 — 오너 게이트)

import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import { rollupSettlementBlock } from "../src/services/campaignGroupService";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const prisma = getPrisma();

  const groups = await prisma.campaignGroup.findMany({
    select: {
      id: true,
      name: true,
      expectedDepositDate: true,
      depositReceivedAt: true,
      isDepositReceived: true,
      expectedPayoutDate: true,
      payoutCompletedAt: true,
      isPayoutCompleted: true,
      members: {
        select: {
          id: true,
          expectedDepositDate: true,
          depositReceivedAt: true,
          isDepositReceived: true,
          expectedPayoutDate: true,
          payoutCompletedAt: true,
          isPayoutCompleted: true,
        },
      },
    },
  });

  let updated = 0;
  let skipped = 0;

  for (const g of groups) {
    const depositVirgin =
      g.expectedDepositDate == null && g.depositReceivedAt == null && !g.isDepositReceived;
    const payoutVirgin =
      g.expectedPayoutDate == null && g.payoutCompletedAt == null && !g.isPayoutCompleted;

    const data: Record<string, Date | boolean | null> = {};

    if (depositVirgin) {
      const deposit = rollupSettlementBlock(
        g.members.map((m) => ({
          expectedDate: m.expectedDepositDate,
          completedAt: m.depositReceivedAt,
          isCompleted: m.isDepositReceived,
        })),
      );
      if (deposit.expectedDate || deposit.isCompleted) {
        data.expectedDepositDate = deposit.expectedDate;
        data.depositReceivedAt = deposit.completedAt;
        data.isDepositReceived = deposit.isCompleted;
      }
    }

    if (payoutVirgin) {
      const payout = rollupSettlementBlock(
        g.members.map((m) => ({
          expectedDate: m.expectedPayoutDate,
          completedAt: m.payoutCompletedAt,
          isCompleted: m.isPayoutCompleted,
        })),
      );
      if (payout.expectedDate || payout.isCompleted) {
        data.expectedPayoutDate = payout.expectedDate;
        data.payoutCompletedAt = payout.completedAt;
        data.isPayoutCompleted = payout.isCompleted;
      }
    }

    if (Object.keys(data).length === 0) {
      skipped += 1;
      continue;
    }

    const summary = Object.entries(data)
      .map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString().slice(0, 10) : String(v)}`)
      .join(" ");
    console.log(`${apply ? "APPLY" : "DRY"} group=${g.id} (${g.name ?? "무명"}) → ${summary}`);

    if (apply) {
      await prisma.campaignGroup.update({ where: { id: g.id }, data });
    }
    updated += 1;
  }

  console.log(
    `${apply ? "적용" : "dry-run"} 완료: 대상 ${updated}건 / 스킵 ${skipped}건 (전체 그룹 ${groups.length}건)`,
  );
}

function isDirectRun(): boolean {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getPrisma().$disconnect();
    });
}
