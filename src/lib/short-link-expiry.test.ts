import { describe, expect, it } from "vitest";
import { resolveLinkExpiry, syncCampaignLinkExpiry } from "./short-link";

/**
 * 만료 규칙 = **KST 종료일 다음날 00:00**. 종료일 당일은 종일 유효하고, 날짜가 넘어가는
 * 순간 죽는다.
 *
 * ⏰ 고정 "오늘" 픽스처를 쓰지 않는다(P9) — 입력 종료일과 기대 만료를 한 쌍으로만 단언한다.
 * 밀리초 덧셈(구 규칙 `+30일`)이 아니라 **날짜 경계**인 것이 이 규칙의 전부다: 종료일의
 * 시각 성분이 무엇이든 결과는 같은 순간이어야 한다.
 */
describe("resolveLinkExpiry", () => {
  // KST 자정 = 전날 15:00Z. 아래 상수는 전부 "KST 로 이 날짜"를 UTC 로 적은 것이다.
  const kstMidnight = (isoDate: string) => new Date(`${isoDate}T00:00:00.000+09:00`);

  it("종료일이 없으면 무기한(null)이다", () => {
    expect(resolveLinkExpiry(null)).toBeNull();
  });

  it("KST 종료일의 다음날 00:00 에 죽는다", () => {
    expect(resolveLinkExpiry(kstMidnight("2026-08-23"))).toEqual(kstMidnight("2026-08-24"));
  });

  it("종료일의 시각 성분이 결과를 바꾸지 않는다 — 28일·30일로 갈리던 원인이 이것이다", () => {
    const expected = kstMidnight("2026-08-24");
    expect(resolveLinkExpiry(new Date("2026-08-23T00:00:00.000+09:00"))).toEqual(expected);
    expect(resolveLinkExpiry(new Date("2026-08-23T09:30:00.000+09:00"))).toEqual(expected);
    expect(resolveLinkExpiry(new Date("2026-08-23T23:59:59.999+09:00"))).toEqual(expected);
  });

  it("UTC 자정 근처 종료일도 KST 날짜로 가른다 — UTC 로 자르면 하루가 밀린다", () => {
    // UTC 2026-08-22T15:30Z = KST 2026-08-23 00:30 → KST 기준 8/23 이 종료일이다.
    expect(resolveLinkExpiry(new Date("2026-08-22T15:30:00.000Z"))).toEqual(
      kstMidnight("2026-08-24"),
    );
    // UTC 2026-08-22T14:30Z = KST 2026-08-22 23:30 → 아직 8/22 다.
    expect(resolveLinkExpiry(new Date("2026-08-22T14:30:00.000Z"))).toEqual(
      kstMidnight("2026-08-23"),
    );
  });

  it("종료일 당일 23:59(KST)는 살아 있고 다음날 00:00 은 죽는다", () => {
    const expiresAt = resolveLinkExpiry(kstMidnight("2026-08-23"))!;
    const aliveAt = new Date("2026-08-23T23:59:59.000+09:00");
    const deadAt = new Date("2026-08-24T00:00:00.000+09:00");
    // 리다이렉터의 판정식과 같은 부등호를 쓴다(`ygrd-link/src/index.ts`: expiresAt < now).
    expect(expiresAt < aliveAt).toBe(false);
    expect(expiresAt < deadAt).toBe(false);
    expect(expiresAt <= deadAt).toBe(true);
  });

  it("월·연 경계를 넘긴다", () => {
    expect(resolveLinkExpiry(kstMidnight("2026-08-31"))).toEqual(kstMidnight("2026-09-01"));
    expect(resolveLinkExpiry(kstMidnight("2026-12-31"))).toEqual(kstMidnight("2027-01-01"));
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("발급 경로는 인라인 계산을 갖지 않는다", () => {
  it("ensureCampaignTrackedLink 가 resolveLinkExpiry 를 쓴다", () => {
    const src = readFileSync(join(__dirname, "short-link.ts"), "utf8");
    expect(src).toContain("expiresAt: resolveLinkExpiry(campaign.endDate)");
    // 구 규칙의 밀리초 상수가 되살아나면 계산이 두 벌이 된다.
    expect(src).not.toContain("30 * 24 * 60 * 60 * 1000");
  });
});

type FakeCampaign = { id: string; groupId: string | null; endDate: Date | null };
type FakeLink = { id: string; salesCampaignId: string | null; expiresAt: Date | null };

/** 트랜잭션 클라이언트의 최소 표면만 흉내 낸다 — 이 함수가 쓰는 두 쿼리뿐이다. */
function makeTx(campaigns: FakeCampaign[], links: FakeLink[]) {
  const calls: Array<{ ids: string[]; expiresAt: Date | null }> = [];
  const tx = {
    salesCampaign: {
      async findMany({ where }: { where: { id?: string; groupId?: string } }) {
        return campaigns
          .filter((c) => (where.groupId ? c.groupId === where.groupId : c.id === where.id))
          .map((c) => ({ id: c.id, endDate: c.endDate }));
      },
    },
    trackedLink: {
      async updateMany({
        where,
        data,
      }: {
        where: { salesCampaignId: { in: string[] } };
        data: { expiresAt: Date | null };
      }) {
        calls.push({ ids: where.salesCampaignId.in, expiresAt: data.expiresAt });
        const targets = links.filter(
          (l) => l.salesCampaignId && where.salesCampaignId.in.includes(l.salesCampaignId),
        );
        for (const l of targets) l.expiresAt = data.expiresAt;
        return { count: targets.length };
      },
    },
  };
  return { tx, calls };
}

const kst = (isoDate: string) => new Date(`${isoDate}T00:00:00.000+09:00`);

describe("syncCampaignLinkExpiry", () => {
  it("단독 캠페인의 링크 만료를 새 종료일로 갱신한다", async () => {
    const { tx, calls } = makeTx(
      [{ id: "c1", groupId: null, endDate: kst("2026-09-10") }],
      [{ id: "l1", salesCampaignId: "c1", expiresAt: kst("2026-08-01") }],
    );

    const updated = await syncCampaignLinkExpiry(tx as never, { campaignId: "c1", groupId: null });

    expect(updated).toBe(1);
    expect(calls).toHaveLength(1); // 쓰기는 updateMany 한 번
    expect(calls[0].expiresAt).toEqual(kst("2026-09-11"));
  });

  it("그룹이면 형제 멤버의 링크까지 함께 갱신한다 — 같은 공구는 같은 날 죽는다", async () => {
    const { tx, calls } = makeTx(
      [
        { id: "origin", groupId: "g1", endDate: kst("2026-09-10") },
        { id: "sib", groupId: "g1", endDate: kst("2026-09-10") }, // 팬아웃이 이미 복사한 상태
        { id: "outsider", groupId: null, endDate: kst("2026-07-01") },
      ],
      [
        { id: "l-origin", salesCampaignId: "origin", expiresAt: null },
        { id: "l-sib", salesCampaignId: "sib", expiresAt: null },
        { id: "l-out", salesCampaignId: "outsider", expiresAt: null },
      ],
    );

    const updated = await syncCampaignLinkExpiry(tx as never, {
      campaignId: "origin",
      groupId: "g1",
    });

    expect(updated).toBe(2);
    expect(calls[0].ids.sort()).toEqual(["origin", "sib"]);
    expect(calls[0].expiresAt).toEqual(kst("2026-09-11"));
  });

  it("형제의 종료일이 아직 갱신되지 않았으면 그 형제만 옛 날짜로 계산된다 — 팬아웃 뒤에 불러야 하는 이유", async () => {
    // 이 테스트는 "순서가 왜 계약인가"를 문서화한다. 팬아웃 **앞**에서 부르면 DB 의 형제
    // endDate 가 아직 옛 값이라, 같은 공구의 링크가 서로 다른 날 죽는다.
    const { tx, calls } = makeTx(
      [
        { id: "origin", groupId: "g1", endDate: kst("2026-09-10") },
        { id: "sib", groupId: "g1", endDate: kst("2026-08-20") }, // 팬아웃 전
      ],
      [
        { id: "l-origin", salesCampaignId: "origin", expiresAt: null },
        { id: "l-sib", salesCampaignId: "sib", expiresAt: null },
      ],
    );

    await syncCampaignLinkExpiry(tx as never, { campaignId: "origin", groupId: "g1" });

    // 종료일이 갈리면 만료도 갈린다 — 함수는 각 캠페인의 저장값을 정직하게 따른다.
    // 그래서 호출 위치(팬아웃 뒤)가 이 기능의 계약이다.
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.expiresAt?.toISOString()))).toEqual(
      new Set([kst("2026-09-11").toISOString(), kst("2026-08-21").toISOString()]),
    );
  });

  it("종료일이 비면 무기한으로 되돌린다", async () => {
    const { tx, calls } = makeTx(
      [{ id: "c1", groupId: null, endDate: null }],
      [{ id: "l1", salesCampaignId: "c1", expiresAt: kst("2026-08-01") }],
    );

    await syncCampaignLinkExpiry(tx as never, { campaignId: "c1", groupId: null });

    expect(calls[0].expiresAt).toBeNull();
  });

  it("링크가 없으면 0 이고 호출자 트랜잭션을 깨지 않는다", async () => {
    const { tx } = makeTx([{ id: "c1", groupId: null, endDate: kst("2026-09-10") }], []);
    expect(await syncCampaignLinkExpiry(tx as never, { campaignId: "c1", groupId: null })).toBe(0);
  });

  it("대상 캠페인이 없으면 쓰기를 아예 하지 않는다", async () => {
    const { tx, calls } = makeTx([], []);
    expect(await syncCampaignLinkExpiry(tx as never, { campaignId: "gone", groupId: null })).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("소급 스크립트의 안전 성질", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "scripts", "backfill-tracked-link-expiry.ts"),
    "utf8",
  );

  it("계산을 다시 구현하지 않고 resolveLinkExpiry 를 재사용한다", () => {
    expect(src).toContain("resolveLinkExpiry");
    expect(src).not.toContain("24 * 60 * 60 * 1000");
  });

  it("예행이 기본이다 — --apply 가 있을 때만 쓴다", () => {
    expect(src).toContain('process.argv.includes("--apply")');
    const applyGate = src.indexOf("if (!apply)");
    const write = src.indexOf("prisma.trackedLink.update(");
    expect(applyGate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(applyGate); // 쓰기는 게이트 뒤에만 있다
  });

  it("⛔ isActive 를 건드리지 않는다", () => {
    // 🪤 `not.toContain("isActive")` 로 쓰지 말 것 — 스크립트 헤더의 **경고 주석 자체가**
    // 그 문자열을 담고 있어 자기 자신을 위반으로 잡는다(이 레포의 기존 실사례와 같은 부류).
    // 판정 대상은 서술이 아니라 **쓰기 페이로드**다.
    expect(src).not.toMatch(/isActive\s*:/);
  });
});
