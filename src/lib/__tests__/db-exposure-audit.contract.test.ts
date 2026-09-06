// DB 노출 감사 계약 테스트 (2026-07-31).
//
// 이 감사기의 가치는 "빨강을 띄우는가" 하나에 달려 있다. 판정이 조용히 무뎌지면
// **매일 도는데 아무것도 못 잡는 초록**이 되고, 그건 감사기가 없는 것보다 나쁘다
// (있다고 믿게 만들기 때문이다). 그래서 판정 함수를 DB 없이 직접 고정한다.
//
// 계열 선례: `capture-stories` 가 11일간 전량 실패하면서 매일 SUCCESS 로 기록됐다
// (2026-07-23) — 그 사고가 `withSystemTaskStatus` 의 `failed` 선언 계약을 낳았고,
// 이 라우트가 그 계약을 쓰는지도 여기서 함께 본다.
//
// ⚠️ **이 테스트가 못 보는 것 — SQL 자체의 유효성.**
// 아래 실행 테스트는 `$queryRawUnsafe` 를 목킹하므로 쿼리 문자열이 문법적으로 틀려도
// 전부 통과한다. 실제로 그랬다: 초판의 `default_privileges` 쿼리가
// `n.nspname || '/' || d.defaclobjtype` 로 `"char"` 를 캐스트 없이 이어 붙여
// `operator is not unique (42725)` 로 **통째로 실패**했는데, 여기 단위 테스트는 49건 전부
// green 이었다. 실 Postgres 에 붙여 돌리고 나서야 드러났다.
// 그래서 SQL 변경 시에는 목킹 테스트 통과를 근거로 삼지 말고 **실 DB(읽기 전용 레인)에서
// 한 번 실행**한다. 그때 양성 대조군을 함께 본다 — "늘 빈 배열을 주는 고장"과 "정말 위반이
// 없음"은 결과가 똑같이 생겼기 때문이다.
//
// `wag_readonly_scope` 에 대해서는 그 실행이 옆 파일 `db-exposure-audit.realpg.test.ts` 에
// 상주한다(옵트인 — 일회용 PostgreSQL URL 을 주면 돈다). 음성 대조군 + 분기별 변이 12종 +
// 오탐 대조군을 **출고되는 쿼리 문자열 그대로** 돌린다. 위 42725 를 일부러 되살려 보면
// 그 파일이 빨강이 되는 것을 확인했다(2026-09-07).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECRET_COLUMN_NAME_PATTERN,
  WAG_READONLY_FORBIDDEN_COLUMNS,
  evaluateExposureAudit,
  runDbExposureAudit,
  type ExposureFinding,
} from "@/lib/db-exposure-audit";

const clean = (check: string, label: string): ExposureFinding => ({
  check,
  label,
  count: 0,
  offenders: [],
});

const CLEAN_FINDINGS: ExposureFinding[] = [
  clean("relation_grants", "테이블 GRANT"),
  clean("function_grants", "함수 GRANT"),
  clean("default_privileges", "기본권한"),
  clean("public_pseudo_role_grants", "PUBLIC 의사롤"),
  clean("column_grants", "컬럼 GRANT"),
  clean("rls_disabled", "RLS"),
  clean("wag_readonly_scope", "wag_readonly 범위"),
];

describe("판정 — 드리프트는 반드시 빨강이 된다", () => {
  it("위반 0건이면 ok", () => {
    const r = evaluateExposureAudit(67, CLEAN_FINDINGS);
    expect(r.status).toBe("ok");
  });

  it.each([
    ["relation_grants", "anon GRANT 부활"],
    ["function_grants", "함수 EXECUTE 부활"],
    ["default_privileges", "미래 객체 자동 부여 부활"],
    ["public_pseudo_role_grants", "PUBLIC 의사롤 부여"],
    ["column_grants", "컬럼 단위 GRANT"],
    ["rls_disabled", "RLS 꺼진 테이블"],
    ["wag_readonly_scope", "wag_readonly 권한 범위 이탈"],
  ])("%s 위반 1건이면 drift", (check, label) => {
    const findings = CLEAN_FINDINGS.map((f) =>
      f.check === check ? { ...f, label, count: 1, offenders: ["Something"] } : f,
    );
    const r = evaluateExposureAudit(67, findings);
    expect(r.status).toBe("drift");
    // 사유가 비면 레이더에 빨강만 뜨고 무엇이 문제인지 알 수 없다.
    expect(r.status === "drift" && r.summary).toContain(label);
  });

  it("여러 항목이 동시에 깨지면 전부 사유에 실린다", () => {
    const findings = CLEAN_FINDINGS.map((f) => ({ ...f, count: 2, offenders: ["A", "B"] }));
    const r = evaluateExposureAudit(67, findings);
    expect(r.status).toBe("drift");
    expect(r.status === "drift" && r.findings).toHaveLength(CLEAN_FINDINGS.length);
  });

  it("⚠️ 테이블 0개는 '깨끗함'이 아니라 '감사 불능'이다", () => {
    // 가장 위험한 오판. 권한 부족·엉뚱한 DB 연결로 카탈로그가 안 보이면 위반도 0건으로
    // 나오는데, 그걸 ok 로 읽으면 감사기가 죽은 채 매일 초록을 찍는다.
    const r = evaluateExposureAudit(0, CLEAN_FINDINGS);
    expect(r.status).toBe("broken");
  });
});

describe("실행 — 환경별 분기", () => {
  it("sqlite 레인은 쿼리조차 하지 않고 skip", async () => {
    // 던지는 클라이언트를 넣는 것 자체가 단언이다 — 조회를 시도하면 이 테스트가 깨진다.
    const failClient = {
      $queryRawUnsafe: async (): Promise<never> => {
        throw new Error("sqlite 레인에서 카탈로그를 조회하면 안 된다");
      },
    };
    const r = await runDbExposureAudit(failClient, "file:./dev.db");
    expect(r.status).toBe("skipped");
  });

  it("감사 대상 롤이 하나도 없으면 skip (shadow DB·순정 Postgres)", async () => {
    // migration-guard 의 shadow DB 는 순정 postgres 라 이 롤들이 없다. 여기서
    // 실패로 찍으면 Supabase 가 아닌 환경 전부가 거짓 경보를 낸다.
    const client = {
      $queryRawUnsafe: async () => [{ publicroles: BigInt(0), wagrole: BigInt(0) }],
    };
    const r = await runDbExposureAudit(client, "postgresql://localhost:5432/shadow");
    expect(r.status).toBe("skipped");
  });

  it("anon·authenticated 가 없어도 wag 축과 PUBLIC 의사롤 점검은 돈다", async () => {
    // 종전에는 공개 롤이 없으면 감사 전체가 skip 이었다 — 그러면 wag_readonly 만 있는
    // Postgres 에서 권한 상승이 통째로 무시된다. 축이 셋이 된 이상 존재 판정도 축별로 한다.
    //
    // ⚠️ 다만 **PUBLIC 의사롤 점검 2종은 축과 무관하게 돌아야 한다.** PUBLIC 부여는
    // 로그인하는 모두에게 적용되므로 anon 이 없는 DB 에서도 wag_readonly 가 그걸로 읽는다.
    // 이 단언이 없으면 축 분리가 그대로 새 사각을 만든다(실측으로 확인한 회귀다).
    // 개수가 아니라 **정체**로 단언한다. 개수만 보면 어느 점검을 `always` 로 둘지 뒤바꿔도
    // 총계가 같아 초록이다 — 이 테스트가 막으려는 회귀가 정확히 그 바꿔치기다.
    let call = 0;
    const client = {
      $queryRawUnsafe: async () => {
        call += 1;
        if (call === 1) return [{ publicroles: BigInt(0), wagrole: BigInt(1) }];
        if (call === 2) return [{ n: BigInt(67) }];
        // 돈 점검마다 위반 1건을 돌려주면 findings 가 곧 "무엇이 돌았는가"의 목록이 된다.
        return [{ name: "something" }];
      },
    };
    const r = await runDbExposureAudit(client, "postgresql://localhost:5432/app");
    expect(r.status).toBe("drift");
    expect(r.status === "drift" && r.findings.map((f) => f.check)).toEqual([
      "public_pseudo_role_grants",
      "column_grants",
      "wag_readonly_scope",
    ]);
  });

  it("Supabase 환경에서 깨끗하면 ok, 위반이 있으면 drift", async () => {
    // ⚠️ `databaseUrl` 을 반드시 명시한다. 생략하면 기본값이 `process.env.DATABASE_URL` 이라
    // **주변 환경에 따라 결과가 갈린다** — 실제로 그렇게 짰다가 로컬(postgres)에서는 통과하고
    // CI 의 hermetic 서브셋(격리 sqlite)에서는 `skipped` 로 빠져 실패했다. 환경 의존 테스트는
    // "로컬 그린"이 아무것도 보장하지 않게 만든다.
    const PG_URL = "postgresql://localhost:5432/app";
    let call = 0;
    // 호출 순서: 롤 존재 → 테이블 수 → CHECKS 7종
    const responses = (offenders: unknown[][]) => async () => {
      call += 1;
      if (call === 1) return [{ publicroles: BigInt(2), wagrole: BigInt(1) }];
      if (call === 2) return [{ n: BigInt(67) }];
      return offenders[call - 3] ?? [];
    };

    call = 0;
    expect(
      (await runDbExposureAudit({ $queryRawUnsafe: responses([[], [], [], [], [], [], []]) }, PG_URL))
        .status,
    ).toBe("ok");

    call = 0;
    const dirty = await runDbExposureAudit(
      { $queryRawUnsafe: responses([[{ name: "Seller" }], [], [], [], [], [{ name: "Seller" }], []]) },
      PG_URL,
    );
    expect(dirty.status).toBe("drift");
    expect(dirty.status === "drift" && dirty.findings.map((f) => f.check)).toEqual([
      "relation_grants",
      "rls_disabled",
    ]);
  });
});

describe("배선 — 라우트가 실패를 선언한다", () => {
  const src = readFileSync(
    join(process.cwd(), "src/app/api/cron/db-exposure-audit/route.ts"),
    "utf-8",
  );

  it("drift·broken 을 failed 로 승격한다", () => {
    // 이 두 줄이 없으면 크론은 200 을 돌려주고 레이더는 영원히 초록이다 —
    // 감사기가 있는데 아무도 모르는 상태가 정확히 이 지점에서 생긴다.
    expect(src).toContain("failed: true");
    expect(src).toContain("failureReason");
    expect(src).toContain("withSystemTaskStatus");
  });

  it("skipped 는 실패로 승격하지 않는다 (sqlite·데모에서 거짓 경보 금지)", () => {
    // skipped 분기가 failed 를 달면 데모 프로젝트 레이더가 매일 빨강이 된다.
    const skippedBranch = src.slice(src.indexOf("skipped(sqlite"));
    expect(skippedBranch).not.toContain("failed: true");
  });

  it("쓰기·외부호출을 하지 않는다 (부수효과 0)", () => {
    for (const f of ["$executeRaw", "fetch(", "prisma.$transaction"]) {
      expect(src.includes(f), `라우트에 ${f} 발견 — 감사는 읽기 전용이어야 한다`).toBe(false);
    }
  });
});

describe("wag_readonly 범위 — 이름 규칙이 의도한 것을 실제로 덮는가", () => {
  // 이 검사의 값은 "울릴 때 울리고, 안 울릴 때 조용한가" 두 쪽 모두에 있다. 한쪽만 보면
  // 상시 오탐(→ 무시당함)이나 상시 침묵(→ 없는 것과 같음)으로 조용히 기운다.
  const secretRx = new RegExp(SECRET_COLUMN_NAME_PATTERN, "i");

  it("2026-09-06 오너가 허용으로 되살린 이름에는 울리지 않는다", () => {
    // `token`·`key`·`email` 을 패턴에 넣으면 이 계열 21개가 매일 빨강이 된다.
    for (const name of [
      "promptTokens",
      "instagramTokenExpiresAt",
      "jobKey",
      "roomKey",
      "orderToEmail",
      "ccEmail",
    ]) {
      expect(secretRx.test(name), `${name} 은 허용 컬럼인데 패턴이 잡았다`).toBe(false);
    }
  });

  it("이름만으로 비밀값이 드러나는 컬럼에는 울린다", () => {
    for (const name of ["portalPasswordHash", "residentNumber", "bankAccount", "phoneNumber"]) {
      expect(secretRx.test(name), `${name} 을 패턴이 놓쳤다`).toBe(true);
    }
  });

  it("출고 SQL 에 분기 13종이 전부 실려 있고 심각도 정렬에도 등록돼 있다", async () => {
    // ⚠️ 이 단언이 없으면 **분기를 하나 지워도 CI 는 초록이다.** 분기별 발화는 옆의
    // realpg 레인이 보는데 그건 옵트인이라 기본 실행에서 전부 skip 되고, 나머지 계약은
    // `check` 키만 볼 뿐 SQL 문자열을 건드리지 않는다.
    // 정렬표까지 함께 보는 이유: `ORDER BY` 의 `ELSE` 가 미등록 접두사를 조용히 최하위로
    // 떨어뜨려서, 새 분기를 넣고 정렬을 잊으면 그 위반이 offenders 절단에 먼저 잘린다.
    const sql = await captureScopeSql();
    // 🪤 **"출고 SQL 에 'relation-owner:' 라는 글자가 있는가"로 물으면 안 된다.** 그 글자는
    // 아래 `ORDER BY` 의 `WHEN name LIKE 'relation-owner:%'` 에도 있어서, SELECT 분기를
    // 통째로 지워도 단언이 통과한다(교차 검증이 실증했다). 그래서 **분기가 실제로 방출하는
    // 접두사만** 뽑아 목록과 집합으로 맞댄다 — 삭제와 추가를 한 단언이 양방향으로 잡는다.
    const emitted = [...sql.matchAll(/\('([a-z-]+):' \|\|/g)].map((m) => m[1]);

    // 추출식이 분기를 놓치면 위 집합 비교가 조용히 통과한다(새 분기를 다른 형태로 쓰면
    // 안 잡힌다). 분기 수는 UNION 수 + 1 이므로, 뽑은 개수를 그 구조와 맞춰 못 박는다.
    const unions = (sql.match(/\bUNION\b/g) ?? []).length;
    expect(emitted, "분기 하나가 추출식에 안 걸렸다 — 접두사를 다른 형태로 쓴 분기가 있다").toHaveLength(
      unions + 1,
    );

    expect(new Set(emitted)).toEqual(new Set(BRANCH_PREFIXES));
    for (const prefix of emitted) {
      expect(sql, `${prefix} 가 심각도 정렬에 등록되지 않았다`).toContain(
        `WHEN name LIKE '${prefix}:%'`,
      );
    }
  });

  it("롤 존재 질의의 별칭이 코드가 읽는 키와 같다", async () => {
    // 옆의 realpg 레인이 실 DB 가 돌려주는 키를 보지만 그건 옵트인이라 CI 에서 돌지 않는다.
    // 여기서는 **한쪽만 개명하는 것**을 막는다 — 별칭과 타입 키가 한 파일에서 마주보게 둔다.
    // (둘 다 바꾸면 이 단언도 같이 고치게 되고, 그때는 의도한 개명이다.)
    const roleSql = await captureRolePresenceSql();
    expect(roleSql).toContain("AS publicroles");
    expect(roleSql).toContain("AS wagrole");
  });

  it("롤 존재 질의의 컬럼이 어긋나면 skip 이 아니라 broken 이다", async () => {
    // 별칭 하나만 바뀌어도 두 축이 다 "롤 없음"으로 읽혀 **모든 환경에서 조용히 통과**한다.
    // 그 고장은 위반 0건과 결과가 똑같이 생겨서, 기본값으로 덮으면 아무도 알아채지 못한다.
    const client = { $queryRawUnsafe: async () => [{ publicRoles: BigInt(2), wagRole: BigInt(1) }] };
    const r = await runDbExposureAudit(client, "postgresql://localhost:5432/app");
    expect(r.status).toBe("broken");
  });

  it("패턴이 못 보는 제외 컬럼은 명시 목록이 덮는다", () => {
    // `token`·`email` 을 뺀 대가로 이름만으로는 안 보이는 진짜 비밀값들. 목록이 이걸
    // 잃으면 `Seller.portalToken` 재부여가 무증상으로 통과한다.
    const blind = WAG_READONLY_FORBIDDEN_COLUMNS.filter(
      (c) => !secretRx.test(c.split(".")[1] ?? ""),
    );
    expect(blind).toContain("Seller.portalToken");
    expect(blind).toContain("SystemSettings.instagramAccessToken");
    expect(WAG_READONLY_FORBIDDEN_COLUMNS).toHaveLength(16);
  });
});

/** `wag_readonly_scope` 가 덮어야 하는 상승 경로 전체. 하나라도 빠지면 위 계약이 깨진다. */
const BRANCH_PREFIXES = [
  "role-attribute",
  "role-membership",
  "namespace-owner",
  "relation-owner",
  "function-owner",
  "secret-column",
  "default-privilege",
  "function-grant",
  "forbidden-table",
  "forbidden-column",
  "relation",
  "schema-privilege",
  "column-privilege",
] as const;

/** 출고되는 점검 SQL 을 공개 API 로 뽑는다 — 손으로 옮겨 적은 사본은 출고본을 대표하지 못한다. */
async function captureScopeSql(): Promise<string> {
  const seen: string[] = [];
  let call = 0;
  await runDbExposureAudit(
    {
      $queryRawUnsafe: async (query: string) => {
        seen.push(query);
        call += 1;
        if (call === 1) return [{ publicroles: BigInt(2), wagrole: BigInt(1) }];
        return call === 2 ? [{ n: BigInt(2) }] : [];
      },
    },
    "postgresql://localhost:5432/app",
  );
  const sql = seen.find((query) => query.includes("role-membership:"));
  if (!sql) throw new Error("wag_readonly_scope 점검 SQL 을 출고본에서 못 찾았다.");
  return sql;
}

/** 출고되는 **첫** 질의(롤 존재 판정)를 뽑는다. */
async function captureRolePresenceSql(): Promise<string> {
  let captured = "";
  await runDbExposureAudit(
    {
      $queryRawUnsafe: async (query: string) => {
        if (!captured) captured = query;
        return [{ publicroles: BigInt(0), wagrole: BigInt(0) }];
      },
    },
    "postgresql://localhost:5432/app",
  );
  return captured;
}
