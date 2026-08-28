// Supabase Data API 노출 감사 — public 스키마의 두 방어겹이 살아 있는지 주기 점검한다.
//
// 배경 — **레포 안의 가드로는 이 드리프트를 볼 수 없다.**
// `rls-coverage.contract.test.ts`(#193)는 마이그레이션 파일을 대조하므로 "우리가 켜기를
// 빠뜨렸나"는 잡지만, **DB 쪽에서 방어가 벗겨지는 것**은 레포에 흔적이 없어 못 잡는다.
// `20260716130000_revoke_public_grants_from_anon` 이 스스로 경고한 그대로다:
//   "Supabase 가 플랫폼 업그레이드 시 자체 마이그레이션으로 기본권한을 재부여할 수 있다
//    (무증상 되돌림)."
// 무증상이라는 게 핵심이다 — 되돌아가도 앱은 멀쩡히 동작한다(Prisma 는 postgres 롤이라
// 그랜트·RLS 양쪽과 무관하다). 그래서 **사람이 알아차릴 계기가 존재하지 않는다.**
//
// 두 겹의 역할(2026-07-31 실측 기준선):
//   ① GRANT 회수 — anon 의 /rest/v1/<table> 이 **401**(권한 없음)에서 끊긴다.
//   ② RLS       — ①이 벗겨져도 정책 0개라 행이 안 나간다(2026-07-15 사고 당시엔 이 겹만
//                 있었고, 그래서 RLS 를 한 번 잊은 테이블이 전량 노출됐다).
// 둘 중 하나만 남아도 즉시 유출은 아니지만, **한 겹으로 버티는 상태를 모르고 지내는 것**이
// 위험이다. 이 감사는 그 상태를 시스템 레이더에 빨강으로 띄운다.
import { isSqliteDatabaseUrl } from "./prisma-client";

/** 감사 대상 롤 — Supabase 가 만드는 공개 경로 롤. `service_role` 은 서버 전용이라 제외한다. */
const PUBLIC_ROLES = ["anon", "authenticated"] as const;

/** 이력(SystemTaskLog.details)이 비대해지지 않게 위반 객체명 나열 상한을 둔다. */
const MAX_OFFENDERS = 20;

export type ExposureFinding = {
  /** 기계 판독용 키. */
  check: string;
  /** 오너가 레이더에서 읽을 한글 설명. */
  label: string;
  /** 위반 객체 수(상한과 무관한 실제 개수). */
  count: number;
  /** 위반 객체명 일부(최대 MAX_OFFENDERS개). */
  offenders: string[];
};

export type ExposureAuditResult =
  | { status: "skipped"; reason: string }
  | { status: "broken"; reason: string }
  | { status: "ok"; publicTables: number }
  | { status: "drift"; publicTables: number; findings: ExposureFinding[]; summary: string };

/**
 * 최소한의 Prisma 의존 — 테스트에서 가짜 클라이언트를 넣을 수 있게 좁게 받는다.
 * 제네릭을 두지 않는 이유: 목 객체가 `Promise<unknown[]>` 를 돌려주면 제네릭 시그니처와
 * 어긋나 테스트 쪽이 컴파일되지 않는다. 반환 형은 아래 호출부에서 좁힌다.
 */
export type RawQueryClient = {
  $queryRawUnsafe(query: string): Promise<unknown>;
};

type NameRow = { name: string };
type CountRow = { n: bigint | number };

const rolesLiteral = PUBLIC_ROLES.map((r) => `'${r}'`).join(", ");

/**
 * 점검 쿼리 4종. 전부 카탈로그 **읽기**다(`$queryRawUnsafe` — 파라미터 없음, 문자열 보간도
 * 상수뿐이라 주입면이 없다). 쓰기 경로를 타지 않으므로 `DB_READ_ONLY=1` 레인에서도 돈다.
 */
const CHECKS: { check: string; label: string; sql: string }[] = [
  {
    check: "relation_grants",
    label: "public 테이블·뷰·시퀀스에 anon/authenticated GRANT 가 살아 있음",
    // relacl 이 NULL 이면 명시 그랜트가 없다는 뜻 = LATERAL 이 행을 만들지 않는다(정상).
    sql: `SELECT c.relname::text AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
          JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public' AND r.rolname IN (${rolesLiteral})
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "function_grants",
    label: "public 함수에 anon/authenticated EXECUTE 가 살아 있음",
    sql: `SELECT p.proname::text AS name
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(p.proacl) a
          JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public' AND r.rolname IN (${rolesLiteral})
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "default_privileges",
    label: "미래 객체 자동 부여가 되살아남 (pg_default_acl 에 public 항목 재등장)",
    // 이게 가장 위험한 항목이다 — 지금 객체는 깨끗해도 **다음 마이그레이션이 만드는 테이블부터**
    // 다시 anon 에 열린다. 회수 마이그레이션의 핵심이 정확히 이 항목이었다.
    // `defaclobjtype` 은 `"char"` 타입이라 캐스트 없이 `||` 로 이으면
    // `operator is not unique: text || "char"` (42725)로 쿼리가 통째로 실패한다.
    // 목킹된 단위 테스트는 이 오류를 볼 수 없어 실 DB 실행으로 잡았다.
    sql: `SELECT (n.nspname || '/' || d.defaclobjtype::text) AS name
          FROM pg_default_acl d
          JOIN pg_namespace n ON n.oid = d.defaclnamespace
          CROSS JOIN LATERAL aclexplode(d.defaclacl) a
          JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public' AND r.rolname IN (${rolesLiteral})
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "public_pseudo_role_grants",
    label: "public 테이블이 PUBLIC 의사롤에 열려 있음 (= anon 포함 전원)",
    // ⚠️ 위의 GRANT 점검들은 `pg_roles` 를 조인하므로 **PUBLIC 을 절대 보지 못한다** —
    // aclexplode 가 PUBLIC 을 grantee=0(실재하지 않는 롤 OID)으로 돌려주기 때문이다.
    // `GRANT SELECT ON "Seller" TO PUBLIC` 한 줄이면 anon 도 읽는데 감사는 조용하다.
    // 교차검증(2026-07-31)에서 지적된 사각이라 별도 항목으로 닫는다.
    // 함수는 대상에서 뺀다 — Postgres 는 함수 EXECUTE 를 PUBLIC 에 **기본 부여**하므로
    // 넣으면 상시 오탐이 된다(테이블은 기본이 소유자 전용이라 부여가 곧 이상 신호다).
    sql: `SELECT c.relname::text AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
          WHERE n.nspname = 'public' AND a.grantee = 0
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "column_grants",
    label: "public 테이블의 컬럼 단위 GRANT 가 anon/authenticated/PUBLIC 에 열려 있음",
    // 컬럼 단위 부여(`GRANT SELECT (email) ON "Seller" TO anon`)는 `pg_class.relacl` 이
    // 아니라 `pg_attribute.attacl` 에 저장돼, 위 관계 GRANT 점검이 통째로 놓친다.
    // 노출 폭은 좁지만 **정확히 민감한 컬럼만 골라 여는** 모양이라 위험도는 낮지 않다.
    sql: `SELECT (c.relname || '.' || att.attname) AS name
          FROM pg_attribute att
          JOIN pg_class c ON c.oid = att.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(att.attacl) a
          LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public'
            AND (r.rolname IN (${rolesLiteral}) OR a.grantee = 0)
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "rls_disabled",
    label: "public 테이블에 RLS 가 꺼져 있음",
    sql: `SELECT c.relname::text AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
          ORDER BY 1`,
  },
];

/** public 스키마의 일반 테이블 수 — 아래 양성 대조군의 근거. */
const PUBLIC_TABLE_COUNT_SQL = `SELECT count(*)::bigint AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;

/** 감사 대상 롤이 이 DB 에 실재하는가. */
const ROLE_COUNT_SQL = `SELECT count(*)::bigint AS n FROM pg_roles WHERE rolname IN (${rolesLiteral})`;

function toNumber(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * 위반 목록 → 최종 판정. 순수 함수라 계약 테스트가 DB 없이 고정한다.
 *
 * ⚠️ `publicTables === 0` 을 "깨끗함"으로 읽지 않는다 — 그건 **하네스가 고장난 것**이다
 * (권한 부족으로 카탈로그가 안 보이거나, 엉뚱한 DB 를 보고 있거나). 위반 0건과 구분하지
 * 않으면 감사기가 조용히 죽은 채로 매일 초록을 찍는다. `capture-stories` 가 11일간
 * SUCCESS 로 무음 실패했던 것과 같은 실패 모드다.
 */
export function evaluateExposureAudit(
  publicTables: number,
  findings: ExposureFinding[],
): ExposureAuditResult {
  if (publicTables === 0) {
    return {
      status: "broken",
      reason:
        "public 스키마에서 테이블을 하나도 못 봤다. 위반 0건이 아니라 감사기가 대상을 못 보는 상태다(권한·연결 대상 확인 필요).",
    };
  }
  const hit = findings.filter((f) => f.count > 0);
  if (hit.length === 0) return { status: "ok", publicTables };
  return {
    status: "drift",
    publicTables,
    findings: hit,
    summary: hit.map((f) => `${f.label} (${f.count}건)`).join(" · "),
  };
}

/**
 * 실제 감사 실행. sqlite 레인(dev:local·데모)에서는 카탈로그가 없으므로 조용히 건너뛴다 —
 * 이 불변식은 프로덕션 Postgres 에만 존재하는 것이라 sqlite 에서 실패로 찍으면 거짓 경보다.
 */
export async function runDbExposureAudit(
  client: RawQueryClient,
  databaseUrl = process.env.DATABASE_URL,
): Promise<ExposureAuditResult> {
  if (isSqliteDatabaseUrl(databaseUrl)) {
    return { status: "skipped", reason: "sqlite 레인: public 스키마 노출 개념이 없다." };
  }

  const roleRows = (await client.$queryRawUnsafe(ROLE_COUNT_SQL)) as CountRow[];
  if (toNumber(roleRows[0]?.n ?? 0) === 0) {
    // shadow DB(순정 postgres)·로컬 Postgres 에는 anon·authenticated 가 없다. Supabase 가
    // 아니라는 뜻이므로 감사 대상이 아니다 — 회수 마이그레이션의 DO 블록과 같은 방어다.
    return { status: "skipped", reason: "anon·authenticated 롤이 없다. Supabase 프로젝트가 아니다." };
  }

  const tableRows = (await client.$queryRawUnsafe(PUBLIC_TABLE_COUNT_SQL)) as CountRow[];
  const publicTables = toNumber(tableRows[0]?.n ?? 0);

  const findings: ExposureFinding[] = [];
  for (const { check, label, sql } of CHECKS) {
    const rows = (await client.$queryRawUnsafe(sql)) as NameRow[];
    findings.push({
      check,
      label,
      count: rows.length,
      offenders: rows.slice(0, MAX_OFFENDERS).map((r) => r.name),
    });
  }

  return evaluateExposureAudit(publicTables, findings);
}
