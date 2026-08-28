/**
 * m5 [Minor, 테스트 확신도]: 실 SQLite DB로 동시성 회귀를 검증한다.
 *
 * 기존 expectedFrom 동시성 테스트(actionProposal.transition.expectedFrom.test.ts)는 목(mock)
 * 레벨이라 updateMany의 실제 SQL 원자성(`UPDATE ... WHERE status = ?`)을 검증하지 못한다.
 * 이 테스트는 격리된 임시 SQLite 파일(공유 prisma/dev.db가 아님 — 다른 세션과 충돌 방지)에
 * 스키마를 push하고, 실제 생성된 Prisma 클라이언트로 같은 row에 대해 두 transition()을
 * 실행해 정확히 하나만 성공하고 나머지는 ConcurrentModificationError(count===0)를 받는지
 * 확인한다.
 *
 * 격리 이유: 이 저장소의 다른 모든 테스트는 getPrisma()를 모킹한다 — 실 DB 접근 전례가
 * 없어, 공유 prisma/dev.db(다른 세션이 활발히 쓰는 파일)를 건드리지 않도록 매 실행마다
 * 새 임시 파일을 만들고 테스트 종료 후 삭제한다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vitest.config.ts는 프로젝트 루트에서 실행되므로 process.cwd()가 REPO_ROOT다
// (import.meta.url은 vite 변환 파이프라인에서 file: 스킴이 아닐 수 있어 사용하지 않는다).
const REPO_ROOT = process.cwd();

let tmpDir: string;
let dbPath: string;
let realPrisma: any;

// getPrisma()가 실제(격리된 임시 파일에 연결된) Prisma 클라이언트를 반환하도록 모킹한다.
// vi.mock의 팩토리는 호이스팅되므로 모듈 스코프 변수를 직접 캡처할 수 없어 getter로 감싼다.
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => realPrisma,
}));

// isSqliteDatabaseUrl()이 true를 반환해야 payload 등 Json 필드가 문자열로 직렬화된다
// (serializeJsonFields가 이 값에 따라 분기 — actionProposalRepository.ts:57).
vi.mock("@/lib/prisma-client", () => ({
  isSqliteDatabaseUrl: () => true,
}));

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-hitl-concurrency-"));
  dbPath = join(tmpDir, "test.db");

  // 격리된 SQLite 파일에 스키마를 push한다 (schema.sqlite.prisma — ActionProposal 포함).
  execFileSync(
    "npx",
    ["prisma", "db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate", "--accept-data-loss"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: "pipe",
    }
  );

  // 실제 생성된 sqlite Prisma 클라이언트로 이 임시 DB에 연결한다.
  const generatedClientPath = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite", "index.js");
  const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
  realPrisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
}, 30000);

afterAll(async () => {
  await realPrisma?.$disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ActionProposalRepository.transition — 실 SQLite 동시성 회귀 (m5)", () => {
  it("같은 row에 대해 두 transition(PENDING_APPROVAL→APPROVED, expectedFrom)을 동시 실행하면 하나만 성공하고 나머지는 ConcurrentModificationError를 받는다", async () => {
    const { ActionProposalRepository, ConcurrentModificationError } = await import(
      "../actionProposalRepository"
    );

    const created = await realPrisma.actionProposal.create({
      data: {
        requestType: "crm_mutation",
        kind: "WRITE",
        status: "PENDING_APPROVAL",
        title: "m5 동시성 회귀 — 실 SQLite",
        createdBy: "creator@example.com",
      },
    });

    // 같은 row에 대해 두 transition을 "동시에" 발사한다 — Promise.allSettled로 둘 다
    // 끝까지 기다리되 어느 한쪽의 실패가 다른 쪽 검증을 막지 않게 한다.
    const [r1, r2] = await Promise.allSettled([
      ActionProposalRepository.transition(created.id, "APPROVED", {
        actor: "approver-a@example.com",
        expectedFrom: "PENDING_APPROVAL",
      }),
      ActionProposalRepository.transition(created.id, "APPROVED", {
        actor: "approver-b@example.com",
        expectedFrom: "PENDING_APPROVAL",
      }),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");

    // 정확히 하나만 성공해야 한다 — SQL UPDATE WHERE status=? 원자성이 실제로 동작함.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // 패자(loser)의 실패 사유는 타이밍에 따라 둘 중 하나일 수 있다 — 둘 다 안전한 결과다
    // (m-ts2 설계 메모: "fromStatus stale read는 현재 안전"과 일치하는 실측 확인):
    //  ① updateMany count===0 → ConcurrentModificationError (패자가 findUnique는 승자보다
    //     먼저 읽었지만 updateMany 시점엔 이미 승자가 커밋한 뒤라 조건부 갱신이 막힘)
    //  ② 패자의 findUnique 자체가 승자의 커밋 "이후"에 실행되어 status=APPROVED를 읽어
    //     canTransition(APPROVED→APPROVED)이 거부되며 "Illegal ActionProposal transition" throw
    // 어느 쪽이든 데이터 손상이나 중복 쓰기는 없다 — 핵심 불변조건(정확히 1건 성공, 이벤트
    // 1건, 최종 상태 일관성)만 검증한다.
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    const isConcurrentModification = rejectedReason instanceof ConcurrentModificationError;
    const isIllegalTransition =
      rejectedReason instanceof Error && /Illegal ActionProposal transition/.test(rejectedReason.message);
    expect(isConcurrentModification || isIllegalTransition).toBe(true);

    // 최종 DB 상태는 APPROVED 1건이고, 이벤트도 1건만 기록되어야 한다(중복 없음).
    const finalRow = await realPrisma.actionProposal.findUniqueOrThrow({ where: { id: created.id } });
    expect(finalRow.status).toBe("APPROVED");

    const events = await realPrisma.actionProposalEvent.findMany({ where: { proposalId: created.id } });
    expect(events).toHaveLength(1);
    expect(events[0].toStatus).toBe("APPROVED");
  }, 20000);
});
