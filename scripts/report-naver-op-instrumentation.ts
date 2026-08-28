/**
 * 네이버 오퍼레이션 계측 요약 행 읽기 전용 리포트 (2026-07-30).
 *
 * ⚠️ 레포 `.env` 의 DATABASE_URL 은 **프로덕션 Supabase DB** 다(P0).
 * 이 스크립트는 **읽기 전용**이다 — 쓰기 경로가 없다.
 *
 *   set -a; source .env; set +a          # P7 Script Env Loading
 *   npx tsx scripts/report-naver-op-instrumentation.ts            # 주문확인 최근 5행
 *   npx tsx scripts/report-naver-op-instrumentation.ts excel 10   # 발주요청 최근 10행
 *
 * ── 무엇에 쓰나 ──────────────────────────────────────────────────────────
 * `ApiCallLog` 의 **오퍼레이션 요약 1행**(P7 *Naver Call Observability*)이 조회 범위 최적화의
 * 전후 비교 지표다. `rangeType` 명시(#162·#169)의 회귀 판정도 이 행으로 한다.
 *
 * **기준선(2026-07-30): `countMismatch=2026-07-12:41/43` · `rangeType=PAYED_DATETIME` ·
 * `logicalCalls=3`.** 이 셋이 유지되면 회귀 없음이다.
 *
 * ⚠️ **이 행은 크론이 만들지 않는다 — 오너가 주문확인/발주요청을 실제로 눌러야 생긴다.**
 * 배포 직후 조회하면 배포 이전 행만 보이므로 "판정 불가"이지 "회귀 없음"이 아니다.
 * 행의 `calledAt` 이 배포 시각보다 **뒤인지** 반드시 확인할 것.
 *
 * ⚠️ `metadata` 는 JSON **문자열** 컬럼이다(P7) — 객체로 접근하면 곧 `undefined` 다.
 * 반드시 `JSON.parse` 한다.
 *
 * ⚠️ 계측 필드는 **PR #162 에서 처음 도입**됐다. 그 이전 행의 `countMismatch`·`rangeType` 이
 * `null` 인 것은 "불일치 없음"이 아니라 **"미배포"** 다 — 계측 고장으로 오판하지 말 것.
 */
import { getPrisma } from "../src/lib/prisma";

const prisma = getPrisma();

/** P7 의 오퍼레이션 요약 scope. 운영자가 명시적으로 누른 작업 1회당 1행. */
const SCOPES = {
  confirm: "naver_op_confirm_order", // 주문확인
  excel: "naver_op_order_excel", // 발주요청(발주서)
} as const;

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw !== "string") return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // 삼키지 않는다 — 파싱 실패는 계측을 못 읽었다는 사실 자체가 신호다(P0).
    return { __parseError: String(err) };
  }
}

async function main() {
  const which = (process.argv[2] ?? "confirm") as keyof typeof SCOPES;
  const take = Number(process.argv[3] ?? 5);
  const scope = SCOPES[which];
  if (!scope) {
    console.error(`알 수 없는 대상 '${process.argv[2]}' — 가능한 값: ${Object.keys(SCOPES).join(" | ")}`);
    process.exitCode = 1;
    return;
  }

  const rows = await prisma.apiCallLog.findMany({
    where: { permissionScope: scope },
    select: { calledAt: true, metadata: true },
    orderBy: { calledAt: "desc" },
    take: Number.isFinite(take) && take > 0 ? take : 5,
  });

  console.log(`[${scope}] 최근 ${rows.length}행 (최신순)`);
  if (rows.length === 0) {
    console.log("행이 없습니다 — 해당 작업이 아직 실행된 적이 없거나 계측 도입 이전입니다.");
    return;
  }

  for (const r of rows) {
    const m = parseMetadata(r.metadata);
    const fields = [
      `rangeType=${m.rangeType ?? "null"}`,
      `countMismatch=${m.countMismatch ?? m.countMismatchDates ?? "null"}`,
      `logicalCalls=${m.logicalCalls ?? "null"}`,
      `httpAttempts=${m.httpAttempts ?? "null"}`,
      `skipped=${m.skipped ?? "null"}`,
      `outcome=${m.outcome ?? "null"}`,
      `elapsedMs=${m.elapsedMs ?? "null"}`,
    ];
    console.log(`  ${r.calledAt.toISOString()} | ${fields.join(" · ")}`);
  }

  console.log(
    `\n기준선(2026-07-30): countMismatch=2026-07-12:41/43 · rangeType=PAYED_DATETIME · logicalCalls=3` +
      `\n⚠️ 판정 전에 최신 행의 calledAt 이 **비교 대상 배포 시각보다 뒤인지** 확인할 것(아니면 판정 불가).`,
  );
}

main()
  .catch((err) => {
    console.error("[report-naver-op-instrumentation] 실패:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
