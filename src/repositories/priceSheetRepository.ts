import { createHash } from "crypto";
import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import type { Prisma } from "@prisma/client";

// PriceSheet 상태기계 (청사진 §2):
// UPLOADED →(추출) EXTRACTED →(매칭) MAPPED →(검수) REVIEWED →(ActionProposal WRITE 경유) APPLIED
// 추출 실패 시 EXTRACT_FAILED.
// APPLYING = 반영 라우트가 중복 반영을 막으려고 잡는 진행 중 표시(반영이 끝나면 APPLIED,
// 실패하면 직전 상태로 되돌린다). 실제로 쓰이는데 이 타입에 빠져 있었다. 요청이 죽어 남은
// APPLYING 은 APPLY_CLAIM_STALE_MS 뒤 다음 반영 요청이 넘겨받는다(T-310).
// ℹ️ REVIEWED 는 쓰는 코드가 없다 — 반영은 MAPPED 에서 바로 간다.
export type PriceSheetStatus =
  | "UPLOADED"
  | "EXTRACTED"
  | "MAPPED"
  | "REVIEWED"
  | "APPLYING"
  | "APPLIED"
  | "EXTRACT_FAILED";

// 반영 잠금 상태(T-310). APPLYING = 반영 요청이 선점 중, APPLIED = 딜에 반영 끝(종착점).
// 이 두 상태의 시트는 추출·매핑·행 수정이 상태를 되돌리거나 행을 바꾸면 안 된다 —
// 되돌아간 시트는 반영 버튼이 다시 살아나 같은 딜을 한 번 더 만들 수 있다.
export const APPLY_LOCKED_STATUSES = ["APPLYING", "APPLIED"] as const satisfies readonly PriceSheetStatus[];

export function isApplyLocked(status: string): boolean {
  return (APPLY_LOCKED_STATUSES as readonly string[]).includes(status);
}

// APPLYING 선점이 이보다 오래되면 그 요청은 죽은 것으로 보고 다음 반영 요청이 넘겨받는다.
// 근거: 살아 있는 반영 요청이 APPLYING 을 쥐는 시간은 실행기의 인터랙티브 $transaction
// 상한(Prisma 기본 timeout 5초 + maxWait 2초)과 그 앞의 기안 쓰기 3회뿐이다. 10분은 그
// 상한보다 두 자릿수 크다. 늦게 깨어난 원 요청은 선점 시각 토큰(updatedAt)이 바뀐 것을 보고
// 스스로 롤백하므로(route.ts 의 fence), 넘겨받아도 이중 반영은 일어나지 않는다.
export const APPLY_CLAIM_STALE_MS = 10 * 60 * 1000;

// Json 이원화: Postgres는 객체 그대로, SQLite는 문자열 직렬화.
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

export class PriceSheetRepository {
  static async create(data: Prisma.PriceSheetUncheckedCreateInput) {
    return getPrisma().priceSheet.create({
      data: {
        ...data,
        columnMapping: serializeJsonField(data.columnMapping) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  static async findById(id: string, includeRows = true) {
    return getPrisma().priceSheet.findUnique({
      where: { id },
      include: { rows: includeRows },
    });
  }

  static async updateStatus(
    id: string,
    status: PriceSheetStatus,
    extra: Prisma.PriceSheetUncheckedUpdateInput = {}
  ) {
    return getPrisma().priceSheet.update({
      where: { id },
      data: {
        ...extra,
        status,
      },
    });
  }

  /**
   * 반영 잠금(APPLYING/APPLIED)이 아닐 때만 상태를 바꾼다. 읽고 나서 쓰는 사이에 반영이
   * 끝날 수 있으므로(추출은 LLM 호출이라 길다) 조건을 쓰기 자체에 건다. 반환 = 바뀐 행 수(0/1).
   */
  static async updateStatusUnlessApplyLocked(
    id: string,
    status: PriceSheetStatus,
    extra: Prisma.PriceSheetUncheckedUpdateManyInput = {}
  ): Promise<number> {
    const { count } = await getPrisma().priceSheet.updateMany({
      where: { id, status: { notIn: [...APPLY_LOCKED_STATUSES] } },
      data: { ...extra, status },
    });
    return count;
  }

  static async findMany<T extends Prisma.PriceSheetFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.PriceSheetFindManyArgs>
  ) {
    return getPrisma().priceSheet.findMany(args);
  }
}

export class PriceSheetRowRepository {
  /**
   * 멱등키 계산: sha256(priceSheetId+rawCells).
   * 순수 함수로 분리해 DB 없이 결정성(같은 입력 → 같은 해시)을 유닛테스트로 검증할 수 있게 한다.
   */
  static computeRowHash(priceSheetId: string, rawCells: unknown): string {
    const payload = `${priceSheetId}|${JSON.stringify(rawCells)}`;
    return createHash("sha256").update(payload).digest("hex");
  }

  static async createMany(
    priceSheetId: string,
    rows: Array<{
      rowIndex: number;
      tableSegment?: number;
      productName?: string | null;
      optionName?: string | null;
      sellingPrice?: number | null;
      commissionRate?: number | null;
      supplyPrice?: number | null;
      listPrice?: number | null;
      floorPrice?: number | null;
      discountRate?: number | null;
      note?: string | null;
      flags?: unknown;
      rawCells: unknown;
    }>
  ) {
    const prisma = getPrisma();
    const data = rows.map((row) => ({
      priceSheetId,
      rowHash: PriceSheetRowRepository.computeRowHash(priceSheetId, row.rawCells),
      rowIndex: row.rowIndex,
      tableSegment: row.tableSegment ?? 0,
      productName: row.productName ?? null,
      optionName: row.optionName ?? null,
      sellingPrice: row.sellingPrice ?? null,
      commissionRate: row.commissionRate ?? null,
      supplyPrice: row.supplyPrice ?? null,
      listPrice: row.listPrice ?? null,
      floorPrice: row.floorPrice ?? null,
      discountRate: row.discountRate ?? null,
      note: row.note ?? null,
      flags: serializeJsonField(row.flags ?? null) as Prisma.InputJsonValue | undefined,
      rawCells: serializeJsonField(row.rawCells) as Prisma.InputJsonValue,
    }));

    // SQLite 드라이버는 createMany의 skipDuplicates 옵션을 지원하지 않는다
    // ("Unknown argument `skipDuplicates`"). 개별 create를 순회하며 중복
    // (unique constraint 위반, P2002)만 스킵해 Postgres skipDuplicates:true와
    // 동일한 "기존 행 보존 + 중복 건너뛰기" 시맨틱을 유지한다.
    // 트레이드오프: 개별 create 순회는 Postgres createMany와 달리 단일 트랜잭션
    // 원자성이 없어 부분 실패 시 이미 생성된 행이 잔존할 수 있다. 다만 재시도 시
    // 동일 rowHash는 P2002로 스킵되어 자연 복구되므로 로컬 dev 환경에 한해 허용한다.
    if (isSqliteDatabaseUrl()) {
      let count = 0;
      for (const row of data) {
        try {
          await prisma.priceSheetRow.create({ data: row });
          count += 1;
        } catch (err) {
          if ((err as { code?: string }).code === "P2002") {
            continue;
          }
          throw err;
        }
      }
      return { count };
    }

    return prisma.priceSheetRow.createMany({ data, skipDuplicates: true });
  }

  static async upsertByHash(
    priceSheetId: string,
    row: {
      rowIndex: number;
      tableSegment?: number;
      productName?: string | null;
      optionName?: string | null;
      sellingPrice?: number | null;
      commissionRate?: number | null;
      supplyPrice?: number | null;
      listPrice?: number | null;
      floorPrice?: number | null;
      discountRate?: number | null;
      note?: string | null;
      flags?: unknown;
      rawCells: unknown;
    }
  ) {
    const rowHash = PriceSheetRowRepository.computeRowHash(priceSheetId, row.rawCells);
    const prisma = getPrisma();
    const flags = serializeJsonField(row.flags ?? null) as Prisma.InputJsonValue | undefined;
    const rawCells = serializeJsonField(row.rawCells) as Prisma.InputJsonValue;

    return prisma.priceSheetRow.upsert({
      where: { priceSheetId_rowHash: { priceSheetId, rowHash } },
      create: {
        priceSheetId,
        rowHash,
        rowIndex: row.rowIndex,
        tableSegment: row.tableSegment ?? 0,
        productName: row.productName ?? null,
        optionName: row.optionName ?? null,
        sellingPrice: row.sellingPrice ?? null,
        commissionRate: row.commissionRate ?? null,
        supplyPrice: row.supplyPrice ?? null,
        listPrice: row.listPrice ?? null,
        floorPrice: row.floorPrice ?? null,
        discountRate: row.discountRate ?? null,
        note: row.note ?? null,
        flags,
        rawCells,
      },
      update: {
        rowIndex: row.rowIndex,
        tableSegment: row.tableSegment ?? undefined,
        productName: row.productName ?? undefined,
        optionName: row.optionName ?? undefined,
        sellingPrice: row.sellingPrice ?? undefined,
        commissionRate: row.commissionRate ?? undefined,
        supplyPrice: row.supplyPrice ?? undefined,
        listPrice: row.listPrice ?? undefined,
        floorPrice: row.floorPrice ?? undefined,
        discountRate: row.discountRate ?? undefined,
        note: row.note ?? undefined,
        flags,
      },
    });
  }

  static async updateMapping(
    id: string,
    input: {
      mappingStatus: "UNMAPPED" | "SUGGESTED" | "MAPPED" | "NEW_DEAL";
      mappedDealId?: string | null;
      mappedCampaignDealId?: string | null;
    }
  ) {
    // null = 매핑 해제(DB에 NULL 기록), undefined = 이 필드 건드리지 않음. `??`로 null을
    // undefined로 바꾸면 NEW_DEAL 전환 시 기존 매핑이 지워지지 않는 버그가 된다.
    return getPrisma().priceSheetRow.update({
      where: { id },
      data: {
        mappingStatus: input.mappingStatus,
        mappedDealId: input.mappedDealId,
        mappedCampaignDealId: input.mappedCampaignDealId,
      },
    });
  }

  static async findUnmapped(priceSheetId: string) {
    return getPrisma().priceSheetRow.findMany({
      where: { priceSheetId, mappingStatus: "UNMAPPED" },
      orderBy: [{ tableSegment: "asc" }, { rowIndex: "asc" }],
    });
  }
}
