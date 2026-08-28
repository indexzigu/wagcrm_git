/**
 * 링크 만료가 캠페인 종료일을 따라간다 — 배선·순서 계약 (2026-08-15).
 *
 * 동작(무엇을 계산하나)은 `src/lib/short-link-expiry.test.ts` 가 고정한다. 여기서 고정하는
 * 것은 **어디서 부르는가**다:
 *
 * ① 캠페인 PATCH 트랜잭션 본체가 실제로 `syncCampaignLinkExpiry` 를 부른다.
 * ② 그 호출이 `fanOutMemberSchedule` **뒤**에 있다 — 앞이면 형제 링크가 옛 종료일로
 *    갱신돼 같은 공구의 링크가 서로 다른 날 죽는다(실데이터의 절반이 그룹이다).
 * ③ 그 호출이 본 update **뒤**에 있다 — 앞이면 원본 캠페인이 옛 종료일로 계산된다.
 * ④ ⛔ `isActive` 를 건드리지 않는다.
 *
 * 순서는 단위 테스트로 못 막는다(미래의 "정리" 리팩터가 대상이다) — 소스 스캔으로 고정한다.
 * 같은 이유·같은 방식의 선례는 `groupScheduleFanout.contract.test.ts` 다.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
const serviceSrc = read("src/services/campaignService.ts");

describe("캠페인 PATCH 트랜잭션의 만료 재계산 배선", () => {
  it("syncCampaignLinkExpiry 를 부른다", () => {
    expect(serviceSrc).toMatch(/await syncCampaignLinkExpiry\(/);
  });

  it("팬아웃 **뒤**에 부른다 — 앞이면 형제 링크가 옛 종료일로 갱신된다", () => {
    const fanOutAt = serviceSrc.indexOf("await fanOutMemberSchedule(");
    const syncAt = serviceSrc.indexOf("await syncCampaignLinkExpiry(");

    expect(fanOutAt).toBeGreaterThan(-1);
    expect(syncAt).toBeGreaterThan(-1);
    expect(fanOutAt).toBeLessThan(syncAt);
  });

  it("본 update **뒤**에 부른다 — 앞이면 원본이 옛 종료일로 계산된다", () => {
    const updateAt = serviceSrc.indexOf("await tx.salesCampaign.update(");
    const syncAt = serviceSrc.indexOf("await syncCampaignLinkExpiry(");

    expect(updateAt).toBeGreaterThan(-1);
    expect(updateAt).toBeLessThan(syncAt);
  });

  it("⛔ isActive 를 건드리지 않는다 — 만료와 수동 중단은 다른 축이다", () => {
    expect(read("src/lib/short-link.ts")).not.toContain("isActive:");
  });

  it("Worker 의 판정식은 그대로다 — 값만 달라지므로 배포 레인은 CRM 하나다", () => {
    // 이 단언이 깨졌다면 두 레인 배포가 된 것이다(순서 위험이 생긴다).
    expect(read("ygrd-link/src/index.ts")).toContain("new Date(link.expiresAt) < now");
  });
});
