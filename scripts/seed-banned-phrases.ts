/**
 * 전역 금지 표현 사전 시딩·동기화 (C1 스펙 M1).
 *
 * ⚠️ 레포 `.env`의 DATABASE_URL은 **프로덕션 Supabase DB**다(P0).
 * 그래서 기본 동작은 **예행(dry-run)** 이고, 실제 쓰기는 `--apply`가 있을
 * 때만 한다. 오너 확인 없이 --apply를 실행하지 말 것.
 *
 *   npx tsx scripts/seed-banned-phrases.ts                 # 예행 — 신규 주입만
 *   npx tsx scripts/seed-banned-phrases.ts --sync          # 예행 — 주입 + 갱신 + 이관 정리
 *   npx tsx scripts/seed-banned-phrases.ts --sync --apply  # 실행(오너 확인 후)
 *
 * ── 왜 --sync 가 필요한가 ────────────────────────────────────────────────
 * 초기 버전은 **삽입만** 했고 멱등 키가 `phrase + category`였다. 그래서
 * 사전의 `pattern`을 고쳐도 프로덕션 행은 그대로였고(화면은 DB를 읽는다),
 * `category`를 옮기면 키가 달라져 **같은 취지의 행이 중복 생성**됐다.
 * 2026-07-30 활용형 보강에서 두 경우가 다 필요해져 동기화 모드를 넣었다.
 *
 * 동기화 키는 `phrase`다(`category`는 이관 대상이라 키가 될 수 없다).
 * 유일성은 `claim-gate.contract.test.ts`가 강제한다.
 *
 * ⚠️ **`severity`는 절대 덮어쓰지 않는다.** 운영자가 검수 후 BLOCK으로
 * 승격했을 수 있고, 시드는 전 항목 WARN이라 되돌려버린다(C1 §8-Q3).
 * 차이가 있으면 보고만 한다.
 */
import { getPrisma } from "../src/lib/prisma";
import {
  BANNED_PHRASE_SEED,
  SUPERSEDED_PHRASES,
} from "../src/lib/claims/banned-phrase-seed";

const prisma = getPrisma();

/** 갱신 대상 필드 — severity·active 는 운영자 소관이라 제외한다. */
const SYNCED_FIELDS = ["pattern", "category", "legalBasis", "note"] as const;

type SyncedField = (typeof SYNCED_FIELDS)[number];

function norm(value: string | null | undefined): string | null {
  return value ?? null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const sync = process.argv.includes("--sync");

  // ⚠️ 비활성 행까지 함께 읽는다. 활성만 읽으면 **운영자가 일부러 끈 규칙이
  // 시드에 남아 있을 때 조용히 중복 삽입**된다(활성 사본이 되살아나 운영자의
  // 비활성 결정이 무음으로 뒤집힌다). 지금은 `active=false`를 만드는 경로가 이
  // 스크립트의 SUPERSEDED 처리뿐이지만, 관리 화면에 "규칙 끄기"가 붙는 순간
  // 실제 사고가 된다 — 그때 이 파일을 고치게 하지 말고 지금 막는다.
  const allRows = await prisma.bannedPhraseRule.findMany({
    select: {
      id: true,
      phrase: true,
      pattern: true,
      category: true,
      severity: true,
      legalBasis: true,
      note: true,
      active: true,
    },
  });
  const existing = allRows.filter((r) => r.active);
  const byPhrase = new Map(existing.map((r) => [r.phrase, r]));

  /** 시드에 있는데 DB에서 비활성인 행 — 되살리지 않고 보고만 한다. */
  const deactivatedInSeed = allRows.filter(
    (r) => !r.active && BANNED_PHRASE_SEED.some((s) => s.phrase === r.phrase),
  );
  const deactivatedPhrases = new Set(deactivatedInSeed.map((r) => r.phrase));

  const toInsert = BANNED_PHRASE_SEED.filter(
    (r) => !byPhrase.has(r.phrase) && !deactivatedPhrases.has(r.phrase),
  );

  /** phrase가 일치하는데 동기 대상 필드가 다른 행. */
  const toUpdate: {
    id: string;
    phrase: string;
    diffs: { field: SyncedField; from: string | null; to: string | null }[];
    data: Record<string, string | null>;
  }[] = [];

  /** 시드는 WARN인데 DB가 다른 행 — 운영자 승격으로 보고 건드리지 않는다. */
  const severityDrift: { phrase: string; db: string; seed: string }[] = [];

  for (const seed of BANNED_PHRASE_SEED) {
    const row = byPhrase.get(seed.phrase);
    if (!row) continue;

    if (row.severity !== seed.severity) {
      severityDrift.push({
        phrase: seed.phrase,
        db: row.severity,
        seed: seed.severity,
      });
    }

    const diffs: { field: SyncedField; from: string | null; to: string | null }[] =
      [];
    const data: Record<string, string | null> = {};
    for (const field of SYNCED_FIELDS) {
      const from = norm(row[field]);
      const to = norm(seed[field]);
      if (from !== to) {
        diffs.push({ field, from, to });
        data[field] = to;
      }
    }
    if (diffs.length > 0) {
      toUpdate.push({ id: row.id, phrase: seed.phrase, diffs, data });
    }
  }

  const supersededByPhrase = new Map(
    SUPERSEDED_PHRASES.map((s) => [s.phrase, s.supersededBy]),
  );
  const seedPhrases = new Set(BANNED_PHRASE_SEED.map((r) => r.phrase));

  /** 시드에서 이관·통합돼 고아가 된 행 — 비활성 대상. */
  const toDeactivate = existing.filter((r) => supersededByPhrase.has(r.phrase));

  /**
   * 시드에도 없고 이관 이력에도 없는 행 — 운영자가 관리 화면에서 직접
   * 넣었을 수 있으므로 **손대지 않고 보고만** 한다.
   */
  const unknownRows = existing.filter(
    (r) => !seedPhrases.has(r.phrase) && !supersededByPhrase.has(r.phrase),
  );

  console.log(`시드 정의: ${BANNED_PHRASE_SEED.length}건`);
  console.log(`활성 DB 행: ${existing.length}건`);
  console.log("");

  console.log(`▸ 신규 주입: ${toInsert.length}건`);
  for (const r of toInsert) {
    console.log(
      `    + [${r.category ?? "공통"}] ${r.phrase} (${r.severity}) — ${r.legalBasis}`,
    );
  }

  console.log(`▸ 필드 갱신: ${toUpdate.length}건${sync ? "" : "  (--sync 필요)"}`);
  for (const u of toUpdate) {
    console.log(`    ~ ${u.phrase}`);
    for (const d of u.diffs) {
      console.log(`        ${d.field}:`);
      console.log(`          before: ${d.from ?? "(null)"}`);
      console.log(`          after : ${d.to ?? "(null)"}`);
    }
  }

  console.log(
    `▸ 이관으로 비활성: ${toDeactivate.length}건${sync ? "" : "  (--sync 필요)"}`,
  );
  for (const r of toDeactivate) {
    console.log(
      `    - [${r.category ?? "공통"}] ${r.phrase} → "${supersededByPhrase.get(r.phrase)}"로 통합`,
    );
  }

  if (severityDrift.length > 0) {
    console.log(
      `▸ severity 차이 ${severityDrift.length}건 — **갱신하지 않는다**(운영자 승격 보존)`,
    );
    for (const s of severityDrift) {
      console.log(`    ! ${s.phrase}: DB=${s.db} · 시드=${s.seed}`);
    }
  }

  if (deactivatedInSeed.length > 0) {
    console.log(
      `▸ 비활성인데 시드에 있는 행 ${deactivatedInSeed.length}건 — **되살리지 않는다**(운영자 비활성 결정 보존)`,
    );
    for (const r of deactivatedInSeed) {
      console.log(`    ○ [${r.category ?? "공통"}] ${r.phrase}`);
    }
  }

  if (unknownRows.length > 0) {
    console.log(
      `▸ 시드 밖 행 ${unknownRows.length}건 — 운영자 추가로 보고 **손대지 않는다**`,
    );
    for (const r of unknownRows) {
      console.log(`    ? [${r.category ?? "공통"}] ${r.phrase}`);
    }
  }

  const writes =
    toInsert.length + (sync ? toUpdate.length + toDeactivate.length : 0);

  if (!apply) {
    console.log(
      `\n예행입니다(쓰기 ${writes}건 예정). 실제 적용하려면 --apply 를 붙이세요(오너 확인 필요).`,
    );
    return;
  }
  if (writes === 0) {
    console.log("\n적용할 변경이 없습니다.");
    return;
  }

  // 부분 적용이 남지 않게 한 트랜잭션으로 묶는다 — 사전이 중간 상태로 남으면
  // 판정이 조용히 어긋난다(통합 규칙만 들어가고 옛 규칙이 살아 있는 등).
  await prisma.$transaction(async (tx) => {
    if (toInsert.length > 0) {
      await tx.bannedPhraseRule.createMany({
        data: toInsert.map((rule) => ({
          phrase: rule.phrase,
          pattern: rule.pattern ?? null,
          category: rule.category ?? null,
          severity: rule.severity,
          legalBasis: rule.legalBasis,
          note: rule.note ?? null,
        })),
      });
    }
    if (sync) {
      for (const u of toUpdate) {
        await tx.bannedPhraseRule.update({
          where: { id: u.id },
          data: u.data,
        });
      }
      if (toDeactivate.length > 0) {
        await tx.bannedPhraseRule.updateMany({
          where: { id: { in: toDeactivate.map((r) => r.id) } },
          // 삭제하지 않는다 — 지난 판정의 근거를 보존한다(스키마 주석).
          data: { active: false },
        });
      }
    }
  });

  console.log(
    `\n적용 완료 — 주입 ${toInsert.length}건 · 갱신 ${sync ? toUpdate.length : 0}건 · 비활성 ${sync ? toDeactivate.length : 0}건`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
