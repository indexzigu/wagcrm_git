/**
 * 기존 단축링크의 만료를 새 규칙(KST 종료일 다음날 00:00)으로 1회 소급한다.
 *
 * ⚠️ 레포 `.env` 의 DATABASE_URL 은 **프로덕션 Supabase DB** 다(P0). 그래서 기본 동작은
 * **예행(dry-run)** 이고, 실제 쓰기는 `--apply` 가 있을 때만 한다. 오너 확인 없이 --apply 를
 * 실행하지 말 것.
 *
 *   npx tsx scripts/backfill-tracked-link-expiry.ts            # 예행 — 변경될 행과 전후 값
 *   npx tsx scripts/backfill-tracked-link-expiry.ts --apply    # 실행(오너 확인 후)
 *
 * ⛔ 이 계산을 마이그레이션 SQL 로 옮기지 말 것 — KST 계산이 TS 함수와 SQL 표현식 두 벌이
 * 되어 나중에 갈라진다. 여기서는 `resolveLinkExpiry` 를 그대로 재사용한다.
 *
 * ⛔ `isActive` 를 건드리지 않는다 — 운영자가 손으로 끈 링크를 이 스크립트가 되살리면
 * "왜 살아났는지"를 되짚을 수 없다.
 *
 * 캠페인에 연결되지 않은 링크(`salesCampaignId` 가 null)는 따라갈 종료일이 없으므로
 * 건너뛴다(무기한으로 밀지 않는다 — 수동 발급 링크의 운영자 설정을 지우게 된다).
 *
 * ⚠️ **--apply 의 실제 폭발 반경**: 이미 종료된 캠페인의 링크는 구 규칙(+30일 유예) 아래서
 * 아직 살아 있다가, 새 규칙(KST 종료일 다음날 00:00)으로는 이미 만료 시각을 지나 있을 수
 * 있다 — 승인 순간 그 링크들이 한꺼번에 즉시 만료로 전환된다(셀러가 게시물에 박은 링크라
 * 되돌릴 수 없는 방향). 예행 요약은 이 건수를 총 변경 건수와 별도로 센다.
 */
import { getPrisma } from "../src/lib/prisma";
import { resolveLinkExpiry } from "../src/lib/short-link";

const prisma = getPrisma();

const fmt = (value: Date | null) => (value ? value.toISOString() : "(무기한)");

async function main() {
  const apply = process.argv.includes("--apply");
  // 루프마다 다시 잡으면 경계(만료 시각과 정확히 같은 순간)에서 판정이 흔들린다 — 한 번만 고정.
  const now = new Date();

  const links = await prisma.trackedLink.findMany({
    where: { salesCampaignId: { not: null } },
    select: {
      id: true,
      code: true,
      expiresAt: true,
      salesCampaign: { select: { id: true, endDate: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const changes = links
    .map((link) => ({
      link,
      next: resolveLinkExpiry(link.salesCampaign?.endDate ?? null),
    }))
    .filter(({ link, next }) => (link.expiresAt?.getTime() ?? null) !== (next?.getTime() ?? null));

  // 지금 살아 있다가(구 규칙으로 만료 안 지남) 새 규칙 반영 즉시 만료로 넘어가는 링크 —
  // 승인자가 봐야 하는 숫자는 총 변경 건수가 아니라 이것이다.
  const goingLiveToDeadCount = changes.filter(
    ({ link, next }) => next !== null && next < now && (link.expiresAt === null || link.expiresAt >= now),
  ).length;

  console.log(`대상 링크 ${links.length}건 · 변경 대상 ${changes.length}건`);
  for (const { link, next } of changes) {
    console.log(
      `  ${link.code}  종료일 ${fmt(link.salesCampaign?.endDate ?? null)}` +
        `  만료 ${fmt(link.expiresAt)} → ${fmt(next)}`,
    );
  }
  console.log(
    `⚠️ 이 중 즉시 만료로 전환되는 링크: ${goingLiveToDeadCount}건 (지금 살아 있다가 반영 즉시 죽는다)`,
  );

  if (!apply) {
    console.log("\n예행(dry-run)입니다. 실제 반영은 --apply 로 실행하세요(오너 확인 필요).");
    return;
  }

  let updated = 0;
  for (const { link, next } of changes) {
    await prisma.trackedLink.update({ where: { id: link.id }, data: { expiresAt: next } });
    updated += 1;
    // 트랜잭션 없이 도는 루프다 — 중단 시 어디까지 반영됐는지 알 수 있게 행 단위로 남긴다.
    console.log(`  반영됨: ${link.code}`);
  }
  console.log(`\n반영 완료: ${updated}건`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
