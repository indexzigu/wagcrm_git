/**
 * 그룹 롤업 드리프트 방지 계약 (2026-08-01 실사고).
 *
 * `CampaignGroup.startDate/endDate` 는 멤버 포락선의 **비정규화 복사본**인데, 갱신 주체가
 * `recomputeGroup`(멤버십 변경 전용) 하나뿐이라 **멤버 기간 수정이 복사본을 낡게 만들었다**
 * (prod 실측 20그룹 중 2건 · 종료 최대 11일 차). 낡은 값은 홈 「다가올 14일 일정」과
 * 그룹 합류 후보 검색이 읽는데, 후자는 **제안이 아예 안 뜨는 침묵형 실패**다.
 *
 * 이 파일이 고정하는 것 3가지:
 *  ① `recomputeGroupRollup` 이 기간만 맞추고 **이름·멤버십은 건드리지 않는다**
 *     (`recomputeGroup` 재사용 금지의 근거 — 그쪽은 해체·개명을 한다)
 *  ② 두 경로가 **같은 포락선 산식**(`rollupGroupPeriod`)을 쓴다
 *  ③ 캠페인 PATCH 라우트가 기간 변경 시 실제로 이 함수를 부른다(소스 스캔 — 미래 회귀 방어)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type FakeCampaign = {
  id: string;
  dealId: string;
  sellerId: string;
  groupId: string | null;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
};

type FakeGroup = {
  id: string;
  sellerId: string;
  name: string | null;
  startDate: Date | null;
  endDate: Date | null;
};

const hoisted = vi.hoisted(() => {
  const state = {
    campaigns: new Map<string, FakeCampaign>(),
    groups: new Map<string, FakeGroup>(),
    lockCalls: [] as string[],
    deletedGroups: [] as string[],
  };

  const tx = {
    async $executeRaw(_s: TemplateStringsArray, ...values: unknown[]) {
      state.lockCalls.push(String(values[0]));
      return 0;
    },
    campaignGroup: {
      async findUnique({ where }: { where: { id: string } }) {
        const g = state.groups.get(where.id);
        return g ? { ...g } : null;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<FakeGroup> }) {
        const g = state.groups.get(where.id);
        if (!g) throw new Error(`group not found: ${where.id}`);
        Object.assign(g, data);
        return { ...g, updatedAt: new Date() };
      },
      async delete({ where }: { where: { id: string } }) {
        state.deletedGroups.push(where.id);
        const g = state.groups.get(where.id);
        state.groups.delete(where.id);
        return g;
      },
    },
    salesCampaign: {
      async findMany({ where }: { where?: { groupId?: string | null } }) {
        const rows = [...state.campaigns.values()].filter(
          (c) => !where || !("groupId" in where) || c.groupId === where.groupId,
        );
        rows.sort(
          (a, b) =>
            a.startDate.getTime() - b.startDate.getTime() ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return rows.map((c) => ({ ...c }));
      },
      async update({ where, data }: { where: { id: string }; data: { groupId?: string | null } }) {
        const c = state.campaigns.get(where.id);
        if (!c) throw new Error(`campaign not found: ${where.id}`);
        if (data.groupId !== undefined) c.groupId = data.groupId;
        return { id: c.id, groupId: c.groupId };
      },
    },
  };

  return { state, tx, prisma: { $transaction: async <T>(cb: (c: typeof tx) => Promise<T>) => cb(tx) } };
});

vi.mock("@/lib/prisma", () => ({ getPrisma: () => hoisted.prisma }));

import { recomputeGroupRollup, rollupGroupPeriod } from "../campaignGroupService";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
let seq = 0;

function seedGroup(over: Partial<FakeGroup> & { id: string; sellerId: string }): FakeGroup {
  const g: FakeGroup = { name: null, startDate: null, endDate: null, ...over };
  hoisted.state.groups.set(g.id, g);
  return g;
}

function seedMember(
  over: Partial<FakeCampaign> & { id: string; sellerId: string; groupId: string },
): FakeCampaign {
  const c: FakeCampaign = {
    dealId: `deal-${over.id}`,
    startDate: d("2026-07-01"),
    endDate: d("2026-07-05"),
    createdAt: new Date(`2026-07-01T00:00:0${seq++ % 10}Z`),
    deal: { dealName: "딜A" },
    seller: { name: "셀러", alias: null },
    ...over,
  };
  hoisted.state.campaigns.set(c.id, c);
  return c;
}

beforeEach(() => {
  hoisted.state.campaigns.clear();
  hoisted.state.groups.clear();
  hoisted.state.lockCalls = [];
  hoisted.state.deletedGroups = [];
  seq = 0;
});

describe("rollupGroupPeriod (포락선 산식)", () => {
  it("min(시작) ~ max(종료) 를 돌려준다 — 입력 순서 무관", () => {
    const members = [
      { startDate: d("2026-07-12"), endDate: d("2026-07-19") },
      { startDate: d("2026-07-12"), endDate: d("2026-07-30") },
      { startDate: d("2026-07-14"), endDate: d("2026-07-20") },
    ];
    expect(rollupGroupPeriod(members)).toEqual({
      startDate: d("2026-07-12"),
      endDate: d("2026-07-30"),
    });
    expect(rollupGroupPeriod([...members].reverse())).toEqual({
      startDate: d("2026-07-12"),
      endDate: d("2026-07-30"),
    });
  });
});

describe("recomputeGroupRollup", () => {
  it("낡은 롤업을 멤버 포락선으로 맞춘다 (실사고 fmze: 종료 7/19 → 7/30)", async () => {
    seedGroup({ id: "g1", sellerId: "s1", startDate: d("2026-07-12"), endDate: d("2026-07-19") });
    seedMember({ id: "c1", sellerId: "s1", groupId: "g1", startDate: d("2026-07-12"), endDate: d("2026-07-30") });
    seedMember({ id: "c2", sellerId: "s1", groupId: "g1", startDate: d("2026-07-12"), endDate: d("2026-07-30") });

    const updated = await recomputeGroupRollup("g1", hoisted.tx as never);

    expect(updated?.startDate).toEqual(d("2026-07-12"));
    expect(updated?.endDate).toEqual(d("2026-07-30"));
    expect(hoisted.state.groups.get("g1")!.endDate).toEqual(d("2026-07-30"));
  });

  it("과대 롤업도 줄인다 (실사고 jvbm: 종료 6/23 → 6/21)", async () => {
    seedGroup({ id: "g1", sellerId: "s1", startDate: d("2026-06-15"), endDate: d("2026-06-23") });
    seedMember({ id: "c1", sellerId: "s1", groupId: "g1", startDate: d("2026-06-15"), endDate: d("2026-06-21") });
    seedMember({ id: "c2", sellerId: "s1", groupId: "g1", startDate: d("2026-06-15"), endDate: d("2026-06-21") });

    await recomputeGroupRollup("g1", hoisted.tx as never);

    expect(hoisted.state.groups.get("g1")!.endDate).toEqual(d("2026-06-21"));
  });

  it("⛔ 이름을 건드리지 않는다 — 수동 이름이 보존된다(recomputeGroup 재사용 금지의 근거)", async () => {
    seedGroup({ id: "g1", sellerId: "s1", name: "오너가 손으로 지은 이름", startDate: d("2026-07-01"), endDate: d("2026-07-05") });
    seedMember({ id: "c1", sellerId: "s1", groupId: "g1", startDate: d("2026-07-01"), endDate: d("2026-07-09") });
    seedMember({ id: "c2", sellerId: "s1", groupId: "g1", startDate: d("2026-07-02"), endDate: d("2026-07-06") });

    await recomputeGroupRollup("g1", hoisted.tx as never);

    expect(hoisted.state.groups.get("g1")!.name).toBe("오너가 손으로 지은 이름");
    expect(hoisted.state.groups.get("g1")!.endDate).toEqual(d("2026-07-09"));
  });

  it("대표 멤버가 바뀌는 기간 수정에도 이름을 재생성하지 않는다 — 의도된 스코프 경계", async () => {
    // 자동 이름은 "시작일이 가장 이른 멤버"의 딜명에서 나온다. 아래 수정으로 대표가
    // 딜A(7/10) → 딜B(7/03) 로 바뀌지만, 수동/자동 이름을 구분하는 플래그가 없어
    // 여기서 재생성하면 오너의 수동 이름이 날짜 수정만으로 사라진다. 이름은 다음
    // 멤버십 변경 때 recomputeGroup 이 정리한다.
    seedGroup({ id: "g1", sellerId: "s1", name: "[셀러] 딜A 외 1건", startDate: d("2026-07-01"), endDate: d("2026-07-15") });
    seedMember({ id: "c1", sellerId: "s1", groupId: "g1", deal: { dealName: "딜A" }, startDate: d("2026-07-10"), endDate: d("2026-07-15") });
    seedMember({ id: "c2", sellerId: "s1", groupId: "g1", deal: { dealName: "딜B" }, startDate: d("2026-07-03"), endDate: d("2026-07-12") });

    await recomputeGroupRollup("g1", hoisted.tx as never);

    expect(hoisted.state.groups.get("g1")!.name).toBe("[셀러] 딜A 외 1건");
    expect(hoisted.state.groups.get("g1")!.startDate).toEqual(d("2026-07-03"));
    expect(hoisted.state.groups.get("g1")!.endDate).toEqual(d("2026-07-15"));
  });

  it("⛔ 멤버가 1건이어도 그룹을 해체하지 않는다 — 기간 수정이 해체를 유발하면 안 된다", async () => {
    seedGroup({ id: "g1", sellerId: "s1", startDate: d("2026-07-01"), endDate: d("2026-07-05") });
    seedMember({ id: "c1", sellerId: "s1", groupId: "g1", startDate: d("2026-07-03"), endDate: d("2026-07-08") });

    await recomputeGroupRollup("g1", hoisted.tx as never);

    expect(hoisted.state.deletedGroups).toEqual([]);
    expect(hoisted.state.campaigns.get("c1")!.groupId).toBe("g1");
    expect(hoisted.state.groups.get("g1")!.endDate).toEqual(d("2026-07-08"));
  });

  it("멤버가 0건이면 아무것도 쓰지 않고 null", async () => {
    seedGroup({ id: "g1", sellerId: "s1", startDate: d("2026-07-01"), endDate: d("2026-07-05") });

    expect(await recomputeGroupRollup("g1", hoisted.tx as never)).toBeNull();
    expect(hoisted.state.groups.get("g1")!.endDate).toEqual(d("2026-07-05"));
  });

  it("그룹이 없으면 null (호출자 트랜잭션을 깨지 않는다)", async () => {
    expect(await recomputeGroupRollup("missing", hoisted.tx as never)).toBeNull();
  });

  // ⚠️ 락 판정은 `DATABASE_URL` 에 달려 있다 — `acquireGroupLock` 은 sqlite 면 조기 반환한다.
  // 그래서 두 갈래를 **명시적으로** 고정한다. 환경에 맡기면 로컬(`npm test`, DATABASE_URL
  // 미설정)에서는 통과하고 CI(`test:ci`, `DATABASE_URL=file:./dev.db`)에서는 실패한다 —
  // 실제로 그렇게 깨졌다. 이 파일은 hermetic 제외 목록에 넣지 않는다(소스 스캔 계약이
  // CI 에서 돌아야 미래 회귀를 막는다).
  const withDatabaseUrl = async (url: string | undefined, run: () => Promise<void>) => {
    const prev = process.env.DATABASE_URL;
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    try {
      await run();
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  };

  it("원격 DB 에서는 셀러 키로 advisory 락을 잡는다 — 동시 멤버십 변경과 직렬화", async () => {
    seedGroup({ id: "g1", sellerId: "s1" });
    seedMember({ id: "c1", sellerId: "s1", groupId: "g1" });
    seedMember({ id: "c2", sellerId: "s1", groupId: "g1" });

    await withDatabaseUrl("postgresql://user@example.invalid:5432/db", async () => {
      await recomputeGroupRollup("g1", hoisted.tx as never);
    });

    expect(hoisted.state.lockCalls).toContain("s1");
  });

  it("sqlite 에서는 락을 건너뛰되 롤업은 그대로 갱신한다", async () => {
    seedGroup({ id: "g1", sellerId: "s1", startDate: d("2026-07-01"), endDate: d("2026-07-05") });
    seedMember({ id: "c1", sellerId: "s1", groupId: "g1", startDate: d("2026-07-01"), endDate: d("2026-07-09") });
    seedMember({ id: "c2", sellerId: "s1", groupId: "g1", startDate: d("2026-07-02"), endDate: d("2026-07-06") });

    await withDatabaseUrl("file:./dev.db", async () => {
      await recomputeGroupRollup("g1", hoisted.tx as never);
    });

    expect(hoisted.state.lockCalls).toEqual([]);
    expect(hoisted.state.groups.get("g1")!.endDate).toEqual(d("2026-07-09"));
  });
});

describe("소스 계약 — 호출부·산식 공유", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("캠페인 PATCH 트랜잭션 본체가 기간 변경 시 recomputeGroupRollup 을 부른다", () => {
    // ⚠️ 2026-08-07 3계층 이관 3단계에서 트랜잭션 본체가 라우트 →
    // `campaignService.updateCampaign` 으로 옮겨졌다. 단언은 그대로, 읽는 파일만 옮긴다.
    const src = read("src/services/campaignService.ts");
    expect(src).toContain("recomputeGroupRollup");
    // 무조건 호출이 아니라 "그룹 소속 + 기간 변경" 게이트를 통과해야 한다.
    expect(src).toMatch(/periodChanged/);
    expect(src).toMatch(/previous\.groupId\s*&&\s*periodChanged/);
  });

  it("recomputeGroup 도 같은 포락선 산식을 쓴다 — 두 경로가 갈리지 않게", () => {
    const src = read("src/services/campaignGroupService.ts");
    // min/max 를 손으로 다시 쓰지 않고 공유 헬퍼를 통과시킨다.
    const rollupCalls = src.match(/rollupGroupPeriod\(/g) ?? [];
    expect(rollupCalls.length).toBeGreaterThanOrEqual(3); // 정의 1 + 소비 2
  });
});

/**
 * 롤업이 **비어 있지 않다**는 전제를 지키는 장치 (T-101).
 *
 * 합류 후보 조회(`campaignGroupRepository.findSuggestions`)는 그룹의 기간으로 거른다 —
 * Prisma 의 `startDate: { lte }` · `endDate: { gte }` 는 **NULL 행을 통째로 뺀다.** 그래서
 * 기간이 빈 그룹은 「합류할 그룹」 목록에서 사라지는데, 그 멤버는 「그룹으로 묶기」에서
 * 여전히 「이미 다른 그룹에 속해 있다」로 집계된다 — 오너가 취할 행동이 화면에 없는
 * 막다른 길이다.
 *
 * 📋 **조사 기록(T-095, 2026-09-05):** 프로덕션 전수 조회에서 기간이 빈 그룹은 **0건**이었고
 * 앱 경로로는 생길 수 없다 — 멤버 날짜가 NOT NULL 이라 `rollupGroupPeriod` 가 항상 실날짜를
 * 내고, 그룹은 날짜 없이 태어나지만 **같은 트랜잭션 안에서** 롤업이 채워진다. 그래서 조회
 * 술어를 넓히는 방어는 넣지 않았다(기간을 모르는 그룹이 날짜와 무관하게 후보로 올라오는
 * 다른 오동작이 된다). 대신 **그 전제 자체를 여기서 고정한다** — 컬럼도 갱신 타입도 null 을
 * 허용하므로, 새 경로가 생기면 아무것도 막지 않은 채 조용히 뚫린다.
 */
describe("롤업 비어있음 방지 (T-101)", () => {
  it("기간이 빈 그룹도 멤버가 있으면 포락선으로 채운다 — 막다른 길의 복구 경로", async () => {
    seedGroup({ id: "g-null", sellerId: "s1", startDate: null, endDate: null });
    seedMember({
      id: "c1",
      sellerId: "s1",
      groupId: "g-null",
      startDate: d("2026-07-03"),
      endDate: d("2026-07-09"),
    });
    seedMember({
      id: "c2",
      sellerId: "s1",
      groupId: "g-null",
      startDate: d("2026-07-01"),
      endDate: d("2026-07-05"),
    });

    const rolled = await recomputeGroupRollup("g-null", hoisted.tx as never);

    expect(rolled?.startDate).toEqual(d("2026-07-01"));
    expect(rolled?.endDate).toEqual(d("2026-07-09"));
    // 저장까지 확인한다 — 반환값만 보면 화면만 맞고 DB 는 빈 채로 남는 회귀를 놓친다.
    const stored = hoisted.state.groups.get("g-null")!;
    expect(stored.startDate).not.toBeNull();
    expect(stored.endDate).not.toBeNull();
  });

  it("그룹을 만드는 자리는 한 곳뿐이고, 그 자리가 같은 트랜잭션에서 롤업을 채운다", () => {
    const root = join(__dirname, "..", "..");
    const service = readFileSync(join(root, "services", "campaignGroupService.ts"), "utf8");

    // ⚠️ 주석을 걷어내고 센다 — 이 트랙의 문서·주석이 금지 문자열을 설명으로 인용해서,
    // 원문 그대로 세면 계약이 자기 주석에 걸린다(레포 선례 다수).
    const stripped = service
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

    const createCalls = stripped.match(/campaignGroupRepository\.create\(/g) ?? [];
    expect(createCalls).toHaveLength(1);

    // 생성 직후 같은 함수 안에서 롤업을 채우는지 — 순서까지 본다.
    const createAt = stripped.indexOf("campaignGroupRepository.create(");
    const recomputeAt = stripped.indexOf("recomputeGroup(created.id", createAt);
    expect(recomputeAt).toBeGreaterThan(createAt);

    // 양성 프로브 — 스캐너가 고장 나도 초록이 되지 않게 한다.
    expect(stripped).toContain("campaignGroupRepository.create(");
    expect(stripped.match(/campaignGroupRepository\.setGroupId\(/g) ?? []).not.toHaveLength(0);
  });

  it("그룹 생성은 서비스 밖에서 일어나지 않는다 — 새 경로가 전제를 우회하지 못하게", () => {
    // 리포지토리 정의(`tx.campaignGroup.create`)와 서비스 호출부 외에는 없어야 한다.
    const out = execFileSync(
      "git",
      ["grep", "-l", "-e", "campaignGroup\\.create(", "-e", "campaignGroupRepository\\.create(", "--", "src", "scripts"],
      { cwd: join(__dirname, "..", "..", ".."), encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => f && !f.includes("__tests__"));

    expect(out.sort()).toEqual([
      "src/repositories/campaignGroupRepository.ts",
      "src/services/campaignGroupService.ts",
    ]);
  });
});
