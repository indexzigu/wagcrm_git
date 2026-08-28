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
// 한 번 실행**한다. 그때 storage 스키마로 같은 쿼리를 돌리는 양성 대조군을 함께 본다 —
// "늘 빈 배열을 주는 고장"과 "정말 위반이 없음"은 결과가 똑같이 생겼기 때문이다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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

  it("anon·authenticated 롤이 없으면 skip (shadow DB·순정 Postgres)", async () => {
    // migration-guard 의 shadow DB 는 순정 postgres:16 이라 이 롤들이 없다. 여기서
    // 실패로 찍으면 Supabase 가 아닌 환경 전부가 거짓 경보를 낸다.
    const client = { $queryRawUnsafe: async () => [{ n: BigInt(0) }] };
    const r = await runDbExposureAudit(client, "postgresql://localhost:5432/shadow");
    expect(r.status).toBe("skipped");
  });

  it("Supabase 환경에서 깨끗하면 ok, 위반이 있으면 drift", async () => {
    // ⚠️ `databaseUrl` 을 반드시 명시한다. 생략하면 기본값이 `process.env.DATABASE_URL` 이라
    // **주변 환경에 따라 결과가 갈린다** — 실제로 그렇게 짰다가 로컬(postgres)에서는 통과하고
    // CI 의 hermetic 서브셋(격리 sqlite)에서는 `skipped` 로 빠져 실패했다. 환경 의존 테스트는
    // "로컬 그린"이 아무것도 보장하지 않게 만든다.
    const PG_URL = "postgresql://localhost:5432/app";
    let call = 0;
    // 호출 순서: 롤 수 → 테이블 수 → CHECKS 6종
    const responses = (offenders: unknown[][]) => async () => {
      call += 1;
      if (call === 1) return [{ n: BigInt(2) }];
      if (call === 2) return [{ n: BigInt(67) }];
      return offenders[call - 3] ?? [];
    };

    call = 0;
    expect(
      (await runDbExposureAudit({ $queryRawUnsafe: responses([[], [], [], [], [], []]) }, PG_URL))
        .status,
    ).toBe("ok");

    call = 0;
    const dirty = await runDbExposureAudit(
      { $queryRawUnsafe: responses([[{ name: "Seller" }], [], [], [], [], [{ name: "Seller" }]]) },
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
