import { describe, it, expect, vi } from "vitest";

// recalculateCampaignRounds 동시성 회귀 테스트 (code-review MEDIUM):
// Read Committed에서는 동시 트랜잭션의 미커밋 캠페인이 서로 안 보여, 같은
// (dealId, sellerId)의 동시 생성 2건이 같은 차수·캠페인명을 받을 수 있었다.
// 수정 = 재계산 전 pg_advisory_xact_lock으로 (dealId, sellerId) 직렬화.
// 여기서는 advisory lock(FIFO·커밋 시 해제)과 Read Committed 가시성(커밋된 행
// + 자기 트랜잭션의 행만 보임)을 흉내내는 가짜 tx 2개를 병렬로 돌려, 락이
// 실제로 두 번째 트랜잭션의 재계산을 첫 커밋 뒤로 미루는지 검증한다.

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => {
    throw new Error("이 테스트는 실제 DB를 사용하지 않는다");
  },
}));
vi.mock("@/lib/asset-storage", () => ({
  googleDriveProvider: { createFolderForEntity: vi.fn() },
  GOOGLE_DRIVE_PROVIDER: "GOOGLE_DRIVE",
}));

import { recalculateCampaignRounds } from "../campaignService";

type Row = {
  id: string;
  dealId: string;
  sellerId: string;
  startDate: Date;
  createdAt: Date;
  roundNumber: number | null;
  campaignName: string | null;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
};

type Patch = Pick<Row, "roundNumber" | "campaignName">;

/** 커밋된 행 저장소 + (단일 키) advisory lock 대기열. */
function createFakeDb() {
  const committed: Row[] = [];
  let lockTail: Promise<void> = Promise.resolve();

  function beginTx() {
    const inserted: Row[] = [];
    const updates = new Map<string, Patch>();
    let releaseLock: (() => void) | undefined;

    const withPatch = (row: Row): Row => ({ ...row, ...(updates.get(row.id) ?? {}) });

    const tx = {
      // pg_advisory_xact_lock 시뮬레이션 — FIFO 획득, 커밋 시 해제.
      async $executeRaw(strings: TemplateStringsArray, ..._values: unknown[]) {
        if (!strings.join("?").includes("pg_advisory_xact_lock")) return [];
        const prev = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => (release = resolve));
        await prev;
        releaseLock = release;
        return [];
      },
      salesCampaign: {
        // Read Committed 가시성: 커밋된 행 + 자기 삽입행 (자기 갱신 반영).
        // 테스트는 단일 (dealId, sellerId)만 다루므로 where 필터는 생략.
        async findMany(_args: unknown) {
          const view = [...committed, ...inserted].map(withPatch);
          view.sort(
            (a, b) =>
              a.startDate.getTime() - b.startDate.getTime() ||
              a.createdAt.getTime() - b.createdAt.getTime(),
          );
          return view;
        },
        async update({ where, data }: { where: { id: string }; data: Patch }) {
          updates.set(where.id, {
            roundNumber: data.roundNumber,
            campaignName: data.campaignName,
          });
        },
      },
      insert(row: Row) {
        inserted.push(row);
      },
      commit() {
        for (const row of inserted) committed.push(withPatch(row));
        for (const [id, patch] of updates) {
          const target = committed.find((r) => r.id === id);
          if (target) Object.assign(target, patch);
        }
        releaseLock?.();
      },
    };
    return tx;
  }

  return { committed, beginTx };
}

function makeRow(id: string, startDate: string): Row {
  return {
    id,
    dealId: "deal-1",
    sellerId: "seller-1",
    startDate: new Date(startDate),
    createdAt: new Date(startDate),
    roundNumber: null,
    campaignName: null,
    deal: { dealName: "비타민" },
    seller: { name: "김본명", alias: "가온" },
  };
}

describe("recalculateCampaignRounds 동시성", () => {
  it("동시 생성 2건이 중복 차수·중복 캠페인명을 받지 않는다", async () => {
    const db = createFakeDb();

    // mobile draft / createCampaign 흐름의 골격: tx 시작 → 캠페인 삽입 →
    // 같은 tx에서 recalculateCampaignRounds → 커밋.
    const createFlow = async (id: string, startDate: string) => {
      const tx = db.beginTx();
      tx.insert(makeRow(id, startDate));
      await recalculateCampaignRounds("deal-1", "seller-1", tx);
      tx.commit();
    };

    await Promise.all([
      createFlow("c1", "2026-07-10"),
      createFlow("c2", "2026-07-20"),
    ]);

    // 락이 없으면 둘 다 상대 행을 못 봐 roundNumber=null, 같은 이름을 받는다.
    const rounds = db.committed.map((r) => r.roundNumber).sort();
    expect(rounds).toEqual([1, 2]);
    const names = db.committed.map((r) => r.campaignName);
    expect(new Set(names).size).toBe(2);
    // 이름 규칙 + 별칭 우선(P2 Seller Alias Priority)도 함께 고정.
    expect(names).toContain("비타민 - 가온 1차");
    expect(names).toContain("비타민 - 가온 2차");
  });

  it("코호트가 1건만 남으면 roundNumber=null·이름에서 N차를 제거한다", async () => {
    // 2건 코호트에서 1건 삭제 후 재계산되는 상황: findMany가 남은 1건만 반환.
    const update = vi.fn();
    const tx = {
      $executeRaw: vi.fn(async () => []),
      salesCampaign: {
        findMany: vi.fn(async () => [
          {
            id: "c2",
            dealId: "deal-1",
            sellerId: "seller-1",
            startDate: new Date("2026-07-20"),
            createdAt: new Date("2026-07-20"),
            roundNumber: 2,
            campaignName: "비타민 - 가온 2차",
            deal: { dealName: "비타민" },
            seller: { name: "김본명", alias: "가온" },
          },
        ]),
        update,
      },
    };

    await recalculateCampaignRounds("deal-1", "seller-1", tx);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "c2" },
      data: { roundNumber: null, campaignName: "비타민 - 가온" },
    });
  });

  it("재계산은 조회 전에 (dealId, sellerId) advisory lock을 획득한다", async () => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push("lock");
        expect(strings.join("?")).toContain("pg_advisory_xact_lock");
        expect(values).toEqual(["deal-1", "seller-1"]);
        return [];
      }),
      salesCampaign: {
        findMany: vi.fn(async () => {
          calls.push("read");
          return [];
        }),
        update: vi.fn(),
      },
    };

    await recalculateCampaignRounds("deal-1", "seller-1", tx);

    expect(calls).toEqual(["lock", "read"]);
  });
});
