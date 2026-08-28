/**
 * 셀러 주민등록번호를 새 `ENCRYPTION_KEY` 로 재암호화한다.
 *
 * 배경: 구 구현이 `ENCRYPTION_KEY` 부재 시 소스에 박힌 기본 키로 폴백했고, 레포가
 * 공개돼 있어 그 키는 공개된 키였다. 키를 바꾸려면 기존 행을 새 키로 다시
 * 암호화해야 한다 — 안 그러면 복호화가 실패한다.
 *
 * ## 실행 순서 (⚠️ 순서를 지킬 것)
 *
 *   1. Vercel/로컬에 새 키를 `ENCRYPTION_KEY`, 구 키를 `ENCRYPTION_KEY_PREVIOUS` 로 등록
 *   2. 예행: `npx tsx scripts/reencrypt-resident-numbers.ts`
 *      → 아무것도 쓰지 않고 분류 집계만 보고한다. **`복호화 실패` 가 0 이어야 한다.**
 *   3. 적용: `npx tsx scripts/reencrypt-resident-numbers.ts --apply`
 *   4. 완료 후 `ENCRYPTION_KEY_PREVIOUS` 제거
 *
 * ## 안전장치
 *
 * - 기본이 **예행(dry-run)** 이다. `--apply` 없이는 DB 에 쓰지 않는다.
 * - **멱등**하다. 이미 새 키로 열리는 행은 건너뛴다 — 중단 후 재실행해도 안전하다.
 * - 주민번호 값(평문·암호문 모두)을 **출력하지 않는다.** 개수와 셀러 id 만 찍는다.
 * - `--apply` 시 변경 전 암호문을 백업 파일로 남긴다(복구용).
 *
 * ⚠️ 이 스크립트는 프로덕션 DB 를 대상으로 돈다(레포 `.env` 의 `DATABASE_URL`).
 */
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { writeFileSync } from "fs";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

/** src/lib/encryption.ts 와 동일한 파생 규칙 — 어긋나면 기존 행이 열리지 않는다. */
const deriveKey = (secret: string) => Buffer.from(secret.padEnd(32).slice(0, 32));

function decryptWith(secret: string, text: string): string | null {
  const parts = text.split(":");
  if (parts.length !== 3) return null;
  try {
    const d = crypto.createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(parts[0], "hex"));
    d.setAuthTag(Buffer.from(parts[1], "hex"));
    return Buffer.concat([d.update(Buffer.from(parts[2], "hex")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function encryptWith(secret: string, plain: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const c = crypto.createCipheriv(ALGORITHM, deriveKey(secret), iv);
  let out = c.update(plain, "utf8", "hex");
  out += c.final("hex");
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${out}`;
}

async function main() {
  const CURRENT = process.env.ENCRYPTION_KEY;
  const PREVIOUS = process.env.ENCRYPTION_KEY_PREVIOUS;

  if (!CURRENT) {
    console.error("ENCRYPTION_KEY(새 키)가 필요합니다.");
    process.exit(1);
  }
  if (!PREVIOUS) {
    console.error("ENCRYPTION_KEY_PREVIOUS(구 키)가 필요합니다 — 기존 행을 열 키입니다.");
    process.exit(1);
  }
  if (CURRENT === PREVIOUS) {
    console.error("새 키와 구 키가 같습니다. 키를 실제로 교체했는지 확인하세요.");
    process.exit(1);
  }

  const rows = await prisma.seller.findMany({
    where: { residentNumber: { not: null } },
    select: { id: true, residentNumber: true },
  });

  const plan: { id: string; next: string }[] = [];
  const backup: { id: string; before: string }[] = [];
  let alreadyCurrent = 0;
  let plaintext = 0;
  const undecryptable: string[] = [];

  for (const row of rows) {
    const value = row.residentNumber ?? "";
    if (!value) continue;

    // 1) 이미 새 키로 열리면 완료된 행이다(멱등성의 핵심).
    if (decryptWith(CURRENT, value) !== null) {
      alreadyCurrent++;
      continue;
    }

    // 2) 구 키로 열리면 재암호화 대상.
    const viaPrevious = decryptWith(PREVIOUS, value);
    if (viaPrevious !== null) {
      plan.push({ id: row.id, next: encryptWith(CURRENT, viaPrevious) });
      backup.push({ id: row.id, before: value });
      continue;
    }

    // 3) 암호문 형식이 아니면 애초에 암호화된 적 없는 평문이다 — 이참에 암호화한다.
    if (value.split(":").length !== 3) {
      plaintext++;
      plan.push({ id: row.id, next: encryptWith(CURRENT, value) });
      backup.push({ id: row.id, before: value });
      continue;
    }

    // 4) 암호문인데 두 키 모두로 안 열린다 — 사람이 봐야 한다. 건드리지 않는다.
    undecryptable.push(row.id);
  }

  console.log(`모드: ${APPLY ? "적용(--apply)" : "예행(dry-run)"}`);
  console.log(`주민등록번호가 있는 셀러: ${rows.length}`);
  console.log(`  ├ 이미 새 키로 암호화됨(건너뜀): ${alreadyCurrent}`);
  console.log(`  ├ 구 키 → 새 키 재암호화 대상: ${plan.length - plaintext}`);
  console.log(`  ├ 평문이라 새로 암호화할 대상: ${plaintext}`);
  console.log(`  └ 두 키 모두로 복호화 실패: ${undecryptable.length}`);

  if (undecryptable.length) {
    console.log(`\n⚠️ 복호화 실패 셀러 id(값 아님): ${undecryptable.join(", ")}`);
    console.log("   이 행들은 건드리지 않았습니다. 0 이 될 때까지 --apply 하지 마세요.");
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\n예행이라 DB 에 쓰지 않았습니다. 적용하려면 --apply 를 붙이세요.");
    return;
  }

  if (plan.length === 0) {
    console.log("\n변경할 행이 없습니다(이미 전부 새 키).");
    return;
  }

  // 변경 전 암호문 백업 — 값이 들어가므로 레포 밖 경로에 쓰고 작업 후 삭제할 것.
  const backupPath = `/tmp/resident-number-backup-${process.pid}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), { mode: 0o600 });
  console.log(`\n변경 전 값 백업: ${backupPath} (권한 600 · 작업 확인 후 삭제하세요)`);

  let done = 0;
  for (const item of plan) {
    await prisma.seller.update({
      where: { id: item.id },
      data: { residentNumber: item.next },
    });
    done++;
    if (done % 20 === 0) console.log(`  ...${done}/${plan.length}`);
  }

  console.log(`\n완료: ${done}건 재암호화. 이제 ENCRYPTION_KEY_PREVIOUS 를 제거하세요.`);
}

main()
  .catch((err) => {
    console.error("실패:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
