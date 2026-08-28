import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import type { Prisma } from "@prisma/client";

// ActionProposal 상태기계 (청사진 §2)
//
// [DRAFT] ─submit→ [PENDING_APPROVAL] ─approve→ [APPROVED] ─execute→ [EXECUTED]
//    │                    └─reject→ [REJECTED]         └─error→ [FAILED] ─retry→ [APPROVED]
//    └─(READ & reviewRequired=false)→ 즉시 EXECUTED
//
// EXECUTED/REJECTED 재전이 금지 (FAILED→APPROVED만 예외).
export type ActionProposalStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "EXECUTED"
  | "REJECTED"
  | "FAILED";

export type ActionProposalKind = "READ" | "WRITE";

// 상태 전이 화이트리스트. 순수 함수로 분리해 DB 없이 유닛테스트 가능하게 한다.
const TRANSITIONS: Record<ActionProposalStatus, ActionProposalStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "EXECUTED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED"],
  APPROVED: ["EXECUTED", "FAILED"],
  EXECUTED: [],
  REJECTED: [],
  FAILED: ["APPROVED"],
};

/**
 * from → to 전이가 화이트리스트상 허용되는지 판정하는 순수 함수.
 *
 * kind는 DRAFT→EXECUTED 직행 전이(READ & reviewRequired=false 즉시 실행)에만 참고용으로 쓰인다.
 * 이 함수 자체는 reviewRequired 값을 모르므로(호출부 책임), kind="WRITE"일 때 DRAFT→EXECUTED
 * 직행은 정책상 금지한다 — WRITE는 항상 승인 절차(PENDING_APPROVAL)를 거쳐야 한다.
 */
export function canTransition(
  from: ActionProposalStatus,
  to: ActionProposalStatus,
  kind: ActionProposalKind = "READ"
): boolean {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) return false;

  // WRITE는 DRAFT에서 EXECUTED로 직행할 수 없다 — 반드시 승인 경유.
  if (from === "DRAFT" && to === "EXECUTED" && kind === "WRITE") return false;

  return true;
}

// Json 이원화: Postgres는 객체 그대로, SQLite는 문자열 직렬화.
// 순수 함수라 유닛테스트에서 DB 없이 직렬화 왕복을 검증할 수 있도록 export한다.
export function serializeJsonField(value: unknown): unknown {
  if (value === undefined || value === null) return value ?? null;
  return isSqliteDatabaseUrl() ? JSON.stringify(value) : value;
}

export function deserializeJsonField<T = unknown>(value: unknown): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value as T;
}

const JSON_FIELDS = [
  "dataSources",
  "assumptions",
  "structuredResult",
  "evidence",
  "risks",
  "nextActions",
  "payload",
  "executionResult",
] as const;

type JsonFieldName = (typeof JSON_FIELDS)[number];

// data 객체 내 Json 필드들을 provider에 맞게 일괄 직렬화한다.
export function serializeJsonFields<T extends Partial<Record<JsonFieldName, unknown>>>(
  data: T
): T {
  const result: Record<string, unknown> = { ...data };
  for (const field of JSON_FIELDS) {
    if (field in result) {
      result[field] = serializeJsonField(result[field]);
    }
  }
  return result as T;
}

export class ActionProposalRepository {
  static async create(data: Prisma.ActionProposalUncheckedCreateInput) {
    return getPrisma().actionProposal.create({
      data: serializeJsonFields(data),
    });
  }

  static async findById<T extends Prisma.ActionProposalInclude>(id: string, include?: T) {
    return getPrisma().actionProposal.findUnique({
      where: { id },
      include,
    }) as Promise<Prisma.ActionProposalGetPayload<{ include: T }> | null>;
  }

  static async findMany<T extends Prisma.ActionProposalFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.ActionProposalFindManyArgs>
  ) {
    return getPrisma().actionProposal.findMany(args);
  }

  static async findPending() {
    return getPrisma().actionProposal.findMany({
      where: { status: "PENDING_APPROVAL" },
      orderBy: { createdAt: "asc" },
    });
  }

  static async appendEvent(
    proposalId: string,
    input: {
      fromStatus?: string | null;
      toStatus: string;
      actor?: string;
      note?: string | null;
    }
  ) {
    return getPrisma().actionProposalEvent.create({
      data: {
        proposalId,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus,
        actor: input.actor ?? "SYSTEM",
        note: input.note ?? null,
      },
    });
  }

  /**
   * 전이 검증 + 상태 갱신 + ActionProposalEvent append를 하나의 트랜잭션으로 묶는다.
   * canTransition()으로 화이트리스트를 통과하지 못하면 에러를 던지고 아무것도 쓰지 않는다.
   *
   * options.tx로 이미 열려 있는 인터랙티브 트랜잭션 클라이언트를 받으면 자체
   * $transaction을 새로 열지 않고 그 tx를 그대로 사용한다 — 호출부(예: apply-executor)가
   * Deal 쓰기와 이 전이를 하나의 원자적 트랜잭션으로 묶을 수 있게 하기 위함이다.
   * options.tx를 넘기지 않는 기존 호출부는 지금까지와 동일하게 자체 $transaction을 연다
   * (동작 변화 없음 — 순수 추가 오버로드).
   *
   * options.expectedFrom(청사진 §0-5): 넘기면 내부 update를 조건부 updateMany로 강화한다
   * — updateMany({where:{id, status: expectedFrom}, ...})의 count가 0이면 그 사이 다른
   * 요청이 이미 전이를 마쳤다는 뜻이므로 ConcurrentModificationError를 던진다(더블클릭/
   * 2인 동시 승인 방어). expectedFrom을 넘기지 않는 기존 호출부는 findUnique로 읽은
   * 현재 상태를 그대로 신뢰하는 기존 update 경로를 사용한다(동작 변화 없음).
   */
  static async transition(
    proposalId: string,
    toStatus: ActionProposalStatus,
    options: {
      actor?: string;
      note?: string | null;
      data?: Prisma.ActionProposalUncheckedUpdateInput;
      tx?: Prisma.TransactionClient;
      expectedFrom?: ActionProposalStatus;
    } = {}
  ) {
    const runner = async (tx: Prisma.TransactionClient) => {
      const current = await tx.actionProposal.findUnique({ where: { id: proposalId } });
      if (!current) {
        throw new Error(`ActionProposal not found: ${proposalId}`);
      }

      const fromStatus = current.status as ActionProposalStatus;
      const kind = (current.kind as ActionProposalKind) ?? "READ";

      if (!canTransition(fromStatus, toStatus, kind)) {
        throw new Error(
          `Illegal ActionProposal transition: ${fromStatus} -> ${toStatus} (kind=${kind})`
        );
      }

      const extraData = options.data ? serializeJsonFields(options.data) : {};

      let updated: Prisma.ActionProposalGetPayload<Record<string, never>>;
      if (options.expectedFrom !== undefined) {
        const claim = await tx.actionProposal.updateMany({
          where: { id: proposalId, status: options.expectedFrom },
          data: {
            ...extraData,
            status: toStatus,
          },
        });

        if (claim.count === 0) {
          throw new ConcurrentModificationError(
            `ActionProposal ${proposalId}는 이미 처리되었습니다 (expected status=${options.expectedFrom}, 동시 요청으로 선점 실패)`
          );
        }

        updated = await tx.actionProposal.findUniqueOrThrow({ where: { id: proposalId } });
      } else {
        updated = await tx.actionProposal.update({
          where: { id: proposalId },
          data: {
            ...extraData,
            status: toStatus,
          },
        });
      }

      await tx.actionProposalEvent.create({
        data: {
          proposalId,
          fromStatus,
          toStatus,
          actor: options.actor ?? "SYSTEM",
          note: options.note ?? null,
        },
      });

      return updated;
    };

    if (options.tx) {
      return runner(options.tx);
    }

    const prisma = getPrisma();
    return prisma.$transaction(runner);
  }
}

/** §0-5 동시성 가드가 count===0일 때 던지는 전용 에러 — 호출부가 409로 매핑하기 쉽도록 구분한다. */
export class ConcurrentModificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentModificationError";
  }
}
