/**
 * 그룹 캠페인의 **반품기간 종료일** 정합화 일회성 정리 (2026-08-04).
 *
 * ⚠️ 레포 `.env`의 DATABASE_URL은 **프로덕션 Supabase DB**다(P0).
 * 그래서 기본 동작은 **예행(dry-run)** 이고, 실제 쓰기는 `--apply`가 있을 때만 한다.
 * 오너 확인 없이 --apply를 실행하지 말 것.
 *
 *   set -a; source .env; set +a          # P7 Script Env Loading
 *   npx tsx scripts/sync-group-return-period.ts            # 예행
 *   npx tsx scripts/sync-group-return-period.ts --apply    # 실행(오너 확인 후)
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────
 * 조합 캠페인은 1개 실캠페인 = N개 관리캠페인이라 반품기간도 통합 운영한다. 그런데
 * `CampaignGroup.returnPeriodEndDate` 컬럼은 만들어만 두고 **한 번도 쓰이거나 읽히지
 * 않았고**, 멤버 컬럼도 캠페인별로 따로 계산돼 그룹 안에서 값이 갈렸다.
 *
 * 쓰기 경로는 `fanOutMemberSchedule`(PATCH 라우트)이 고쳤지만 **이미 갈라진 기존 그룹은
 * 저절로 맞춰지지 않는다** — 다음번에 그 그룹의 일정을 수정할 때까지 어긋난 채 남는다.
 * 그래서 구조 수정과 짝을 이루는 1회 정리가 필요하다.
 *
 * ── 어떤 값으로 맞추는가 ─────────────────────────────────────────────────
 * **멤버 값 중 가장 늦은 날짜(max)** 로 통일한다. 반품기간 종료일은 "이 날이 지나야 정산을
 * 확정할 수 있다"는 의미이고, 그룹은 통째로 정산되므로 **한 멤버라도 반품기간이 남아 있으면
 * 그룹 전체가 아직 확정 불가**다. min·평균으로 맞추면 아직 반품 가능한 회차를 정산 확정으로
 * 오판한다(대시보드 "반품기간 지난 정산대기" 카운터가 이 컬럼을 직접 읽는다).
 *
 * 멤버 전원이 null 인 그룹은 **건드리지 않는다** — 미입력은 "0일"이 아니라 "미정"이고,
 * 여기서 지어내면 없는 근거로 정산 확정 신호를 만들게 된다.
 *
 * ⚠️ 이 스크립트는 반품기간 종료일 **한 컬럼만** 쓴다. 기간·정산일·금액은 건드리지 않고
 * 외부 호출(네이버·구글·메일)도 하지 않는다.
 */
import { getPrisma } from "../src/lib/prisma";

const prisma = getPrisma();

const APPLY = process.argv.includes("--apply");

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "(없음)");

async function main() {
  const groups = await prisma.campaignGroup.findMany({
    select: {
      id: true,
      returnPeriodEndDate: true,
      members: {
        select: { id: true, returnPeriodEndDate: true },
      },
    },
  });

  type Plan = {
    groupId: string;
    target: Date;
    staleMemberIds: string[];
    groupNeedsMirror: boolean;
    memberValues: (Date | null)[];
  };

  const plans: Plan[] = [];
  let alreadyConsistent = 0;
  let allNull = 0;

  for (const g of groups) {
    if (g.members.length === 0) continue;
    const values = g.members.map((m) => m.returnPeriodEndDate);
    const present = values.filter((v): v is Date => v !== null);

    if (present.length === 0) {
      allNull += 1;
      continue;
    }

    // 가장 늦은 종료일 = 그룹 전체가 확정 가능해지는 시점.
    const target = present.reduce((max, v) => (v.getTime() > max.getTime() ? v : max), present[0]);

    const staleMemberIds = g.members
      .filter((m) => m.returnPeriodEndDate?.getTime() !== target.getTime())
      .map((m) => m.id);
    const groupNeedsMirror = g.returnPeriodEndDate?.getTime() !== target.getTime();

    if (staleMemberIds.length === 0 && !groupNeedsMirror) {
      alreadyConsistent += 1;
      continue;
    }
    plans.push({ groupId: g.id, target, staleMemberIds, groupNeedsMirror, memberValues: values });
  }

  console.log(`[그룹] 전체 ${groups.length}개`);
  console.log(`[건너뜀] 멤버 전원 미입력(미정 보존): ${allNull}개`);
  console.log(`[정합] 이미 일치: ${alreadyConsistent}개`);
  console.log(`[대상] 맞출 그룹: ${plans.length}개`);

  for (const p of plans) {
    console.log(
      `  - ${p.groupId} → ${ymd(p.target)}` +
        ` (멤버 현재값: ${p.memberValues.map(ymd).join(", ")}` +
        ` · 갱신 멤버 ${p.staleMemberIds.length}건${p.groupNeedsMirror ? " · 그룹행 미러 필요" : ""})`,
    );
  }

  if (plans.length === 0) {
    console.log("\n맞출 그룹이 없습니다.");
    return;
  }

  if (!APPLY) {
    console.log(
      "\n예행(dry-run)입니다 — 아무것도 쓰지 않았습니다. 실행하려면 --apply 를 붙이세요(오너 확인 후).",
    );
    return;
  }

  let memberUpdates = 0;
  let groupUpdates = 0;
  for (const p of plans) {
    await prisma.$transaction(async (tx) => {
      if (p.staleMemberIds.length > 0) {
        const r = await tx.salesCampaign.updateMany({
          where: { id: { in: p.staleMemberIds } },
          data: { returnPeriodEndDate: p.target },
        });
        memberUpdates += r.count;
      }
      if (p.groupNeedsMirror) {
        await tx.campaignGroup.update({
          where: { id: p.groupId },
          data: { returnPeriodEndDate: p.target },
        });
        groupUpdates += 1;
      }
    });
  }

  console.log(`\n[실행] 멤버 ${memberUpdates}건 · 그룹행 ${groupUpdates}건 갱신`);

  // 확인 — 남은 불일치가 0이어야 정상.
  const after = await prisma.campaignGroup.findMany({
    select: { id: true, members: { select: { returnPeriodEndDate: true } } },
  });
  const stillDivergent = after.filter((g) => {
    const present = g.members
      .map((m) => m.returnPeriodEndDate)
      .filter((v): v is Date => v !== null);
    if (present.length === 0) return false;
    return (
      present.length !== g.members.length ||
      new Set(present.map((v) => v.getTime())).size > 1
    );
  });
  console.log(`[확인] 남은 불일치 그룹: ${stillDivergent.length} (0이어야 정상)`);
}

main()
  .catch((err) => {
    console.error("[sync-group-return-period] 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
