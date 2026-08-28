/**
 * 그룹 일정 통합 연동(팬아웃) 계약 — 2026-08-04.
 *
 * 조합 캠페인은 **1개 실캠페인 = N개 관리캠페인**이라 기간·반품기간을 통합 운영한다.
 * 한 멤버를 고치면 형제 멤버도 같이 바뀌어야 하는데, 그 구현이 **그룹 스칼라 SoT 가 아니라
 * 멤버 팬아웃**인 데에는 이유가 있다 — 이 파일이 고정하는 것이 바로 그 이유다.
 *
 * ① `fanOutMemberSchedule` 의 동작(형제만·원본 제외·빈 입력 무쓰기·락 두 갈래)
 * ② ⛔ **`returnPeriodEndDate` 를 그룹 읽기 오버레이로 옮기지 말 것** — 대시보드 카운터
 *    3곳이 `toCampaignRow` 를 거치지 않고 **멤버 컬럼을 Prisma `where`/`select` 로 직접**
 *    읽으므로, 그룹 SoT 로 바꾸면 멤버 컬럼이 null 로 남아 **카운터가 조용히 0** 이 된다
 *    (`codebase-map.md` 가 기록한 #196 함정과 같은 부류).
 * ③ 캠페인 PATCH 라우트가 실제로 팬아웃을 부르고, **롤업보다 먼저** 부른다(순서가 뒤집히면
 *    포락선이 팬아웃 이전 값으로 계산된다).
 *
 * ②③ 은 단위 테스트로 못 막는다(미래의 리팩터가 대상이라) — 소스 스캔으로 고정한다.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type FakeCampaign = {
  id: string;
  sellerId: string;
  groupId: string | null;
  startDate: Date;
  endDate: Date;
  returnPeriodEndDate: Date | null;
};

type FakeGroup = { id: string; sellerId: string };

const hoisted = vi.hoisted(() => {
  const state = {
    campaigns: new Map<string, FakeCampaign>(),
    groups: new Map<string, FakeGroup>(),
    lockCalls: [] as string[],
    updateManyCalls: [] as unknown[],
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
    },
    salesCampaign: {
      async updateMany({
        where,
        data,
      }: {
        where: { groupId?: string; id?: { not: string } };
        data: Partial<FakeCampaign>;
      }) {
        state.updateManyCalls.push({ where, data });
        const targets = [...state.campaigns.values()].filter(
          (c) => c.groupId === where.groupId && c.id !== where.id?.not,
        );
        for (const c of targets) Object.assign(c, data);
        return { count: targets.length };
      },
    },
  };

  return { state, tx };
});

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));

import { fanOutMemberSchedule } from "../campaignGroupService";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function seedGroup(id: string, sellerId: string): void {
  hoisted.state.groups.set(id, { id, sellerId });
}

function seedMember(over: Partial<FakeCampaign> & { id: string; groupId: string | null }): FakeCampaign {
  const c: FakeCampaign = {
    sellerId: "s1",
    startDate: d("2026-07-01"),
    endDate: d("2026-07-05"),
    returnPeriodEndDate: null,
    ...over,
  };
  hoisted.state.campaigns.set(c.id, c);
  return c;
}

/** `acquireGroupLock` 은 DATABASE_URL 로 갈린다 — 환경에 맡기면 로컬↔CI 결과가 갈린다(P9). */
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

beforeEach(() => {
  hoisted.state.campaigns.clear();
  hoisted.state.groups.clear();
  hoisted.state.lockCalls = [];
  hoisted.state.updateManyCalls = [];
});

describe("fanOutMemberSchedule", () => {
  it("형제 멤버에 기간을 복사하고 원본은 제외한다 (원본은 호출자가 이미 갱신했다)", async () => {
    seedGroup("g1", "s1");
    seedMember({ id: "origin", groupId: "g1" });
    seedMember({ id: "sib1", groupId: "g1" });
    seedMember({ id: "sib2", groupId: "g1" });
    seedMember({ id: "outsider", groupId: null });

    const count = await fanOutMemberSchedule(
      "g1",
      "origin",
      { startDate: d("2026-08-10"), endDate: d("2026-08-20") },
      hoisted.tx as never,
    );

    expect(count).toBe(2);
    expect(hoisted.state.campaigns.get("sib1")!.endDate).toEqual(d("2026-08-20"));
    expect(hoisted.state.campaigns.get("sib2")!.startDate).toEqual(d("2026-08-10"));
    // 원본은 팬아웃이 건드리지 않는다 — 라우트의 단일 update 가 소유한다.
    expect(hoisted.state.campaigns.get("origin")!.endDate).toEqual(d("2026-07-05"));
    // 미그룹 캠페인은 절대 대상이 아니다.
    expect(hoisted.state.campaigns.get("outsider")!.endDate).toEqual(d("2026-07-05"));
  });

  it("반품기간 종료일도 함께 팬아웃한다 — 멤버 컬럼이 정합해야 대시보드 카운터가 산다", async () => {
    seedGroup("g1", "s1");
    seedMember({ id: "origin", groupId: "g1" });
    seedMember({ id: "sib1", groupId: "g1", returnPeriodEndDate: d("2026-06-01") });

    const count = await fanOutMemberSchedule(
      "g1",
      "origin",
      { returnPeriodEndDate: d("2026-08-19") },
      hoisted.tx as never,
    );

    expect(count).toBe(1);
    expect(hoisted.state.campaigns.get("sib1")!.returnPeriodEndDate).toEqual(d("2026-08-19"));
  });

  it("반품기간을 null 로 지우는 것도 전파된다 — 명시적 삭제와 미설정을 섞지 않는다", async () => {
    seedGroup("g1", "s1");
    seedMember({ id: "origin", groupId: "g1" });
    seedMember({ id: "sib1", groupId: "g1", returnPeriodEndDate: d("2026-06-01") });

    await fanOutMemberSchedule("g1", "origin", { returnPeriodEndDate: null }, hoisted.tx as never);

    expect(hoisted.state.campaigns.get("sib1")!.returnPeriodEndDate).toBeNull();
  });

  it("갱신할 필드가 없으면 쿼리를 아예 보내지 않는다 (정산일만 바뀐 PATCH 가 형제를 건드리면 안 된다)", async () => {
    seedGroup("g1", "s1");
    seedMember({ id: "origin", groupId: "g1" });
    seedMember({ id: "sib1", groupId: "g1" });

    expect(await fanOutMemberSchedule("g1", "origin", {}, hoisted.tx as never)).toBe(0);
    expect(hoisted.state.updateManyCalls).toEqual([]);
    expect(hoisted.state.lockCalls).toEqual([]);
  });

  it("그룹이 없으면 0 — 호출자 트랜잭션을 깨지 않는다", async () => {
    seedMember({ id: "origin", groupId: "gone" });

    expect(
      await fanOutMemberSchedule("gone", "origin", { endDate: d("2026-08-20") }, hoisted.tx as never),
    ).toBe(0);
    expect(hoisted.state.updateManyCalls).toEqual([]);
  });

  it("원격 DB 에서는 셀러 키로 advisory 락을 잡는다", async () => {
    seedGroup("g1", "s1");
    seedMember({ id: "origin", groupId: "g1" });
    seedMember({ id: "sib1", groupId: "g1" });

    await withDatabaseUrl("postgresql://user@example.invalid:5432/db", async () => {
      await fanOutMemberSchedule("g1", "origin", { endDate: d("2026-08-20") }, hoisted.tx as never);
    });

    expect(hoisted.state.lockCalls).toContain("s1");
  });

  it("sqlite 에서는 락을 건너뛰되 팬아웃은 그대로 수행한다", async () => {
    seedGroup("g1", "s1");
    seedMember({ id: "origin", groupId: "g1" });
    seedMember({ id: "sib1", groupId: "g1" });

    await withDatabaseUrl("file:./dev.db", async () => {
      await fanOutMemberSchedule("g1", "origin", { endDate: d("2026-08-20") }, hoisted.tx as never);
    });

    expect(hoisted.state.lockCalls).toEqual([]);
    expect(hoisted.state.campaigns.get("sib1")!.endDate).toEqual(d("2026-08-20"));
  });
});

// ---------------------------------------------------------------------------
// 소스 스캔 — 미래의 "정리" 리팩터가 침묵형 회귀를 만드는 것을 막는다
// ---------------------------------------------------------------------------

const repoRoot = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("⛔ returnPeriodEndDate 는 멤버 컬럼에 남는다 (그룹 오버레이 금지)", () => {
  it("toCampaignRow 가 returnPeriodEndDate 를 그룹 값으로 덮지 않는다", () => {
    const src = read("src/lib/campaign-row.ts");
    const line = src
      .split("\n")
      .find((l) => l.includes("returnPeriodEndDate:") && l.includes("toKstDateStr"));

    expect(line, "campaign-row.ts 의 returnPeriodEndDate 매핑 줄을 찾지 못했다").toBeTruthy();
    // 다른 정산일 9종은 `group?.X === undefined ? campaign.X : group.X` 형태다.
    // 이 필드만 그 형태가 되면 멤버 컬럼을 읽는 아래 프리필터들이 함께 죽는다.
    expect(line).not.toContain("group?.returnPeriodEndDate");
    expect(line).toContain("campaign.returnPeriodEndDate");
  });

  it("대시보드 카운터 3곳이 멤버 컬럼을 직접 읽는 사실을 고정한다 (양성 대조군 포함)", () => {
    // 이 단언들이 깨졌다면 소비처가 옮겨간 것이다 — 그때 위 오버레이 금지를 재검토한다.
    // 정규식이 아니라 실제 문자열이므로 "스캔이 고장 나 늘 통과"하는 실패 모드가 없다.
    expect(read("src/lib/dashboard-data.ts")).toContain('returnPeriodEndDate: { lt: new Date() }');
    expect(read("src/lib/cached-crm-data.ts")).toContain("returnPeriodEndDate: { lt: now }");
    expect(read("src/lib/desktop-dashboard.ts")).toContain("returnPeriodEndDate: true");
  });
});

describe("캠페인 PATCH 트랜잭션 본체의 팬아웃 배선", () => {
  // ⚠️ 스캔 대상은 **리터럴이 실재하는 파일**이다. 2026-08-07 3계층 이관 3단계에서
  // PATCH 의 트랜잭션 본체가 라우트에서 `campaignService.updateCampaign` 으로 옮겨졌다 —
  // 단언(호출 존재·호출 순서·공유필드 집합의 구성)은 그대로 두고 읽는 파일만 옮긴다.
  const serviceSrc = read("src/services/campaignService.ts");

  it("fanOutMemberSchedule 를 import 하고 호출한다", () => {
    expect(serviceSrc).toContain("fanOutMemberSchedule");
    expect(serviceSrc).toMatch(/await fanOutMemberSchedule\(/);
  });

  it("팬아웃이 recomputeGroupRollup 보다 **먼저** 실행된다 — 순서가 뒤집히면 포락선이 낡는다", () => {
    const fanOutAt = serviceSrc.indexOf("await fanOutMemberSchedule(");
    const rollupAt = serviceSrc.indexOf("await recomputeGroupRollup(");

    expect(fanOutAt).toBeGreaterThan(-1);
    expect(rollupAt).toBeGreaterThan(-1);
    expect(fanOutAt).toBeLessThan(rollupAt);
  });

  it("그룹이어도 원본 멤버의 returnPeriodEndDate 를 계속 쓴다", () => {
    // `campaignSharedEventUpdates`(그룹이면 멤버에 안 쓰는 집합)에 이 필드가 들어가면
    // 그룹 캠페인의 멤버 컬럼이 영원히 낡는다.
    const sharedBlockStart = serviceSrc.indexOf("const campaignSharedEventUpdates = {");
    const sharedBlockEnd = serviceSrc.indexOf("const groupSharedEventUpdates = {");
    const sharedBlock = serviceSrc.slice(sharedBlockStart, sharedBlockEnd);

    expect(sharedBlockStart).toBeGreaterThan(-1);
    expect(sharedBlockEnd).toBeGreaterThan(sharedBlockStart);
    expect(sharedBlock).not.toContain("returnPeriodEndDate");
  });

  it("라우트는 트랜잭션 본체를 서비스에 위임한다 — 두 벌이 생기면 순서 계약이 갈린다", () => {
    const routeSrc = read("src/app/api/campaigns/[id]/route.ts");
    expect(routeSrc).toContain("campaignService.updateCampaign(");
    // 팬아웃·롤업 호출이 라우트에 되살아나면 위 순서 스캔이 대상 파일을 잘못 보게 된다.
    expect(routeSrc).not.toContain("await fanOutMemberSchedule(");
    expect(routeSrc).not.toContain("await recomputeGroupRollup(");
  });
});
