/**
 * 캠페인 **단건 조회 페이로드가 그룹 배지 숫자를 싣는다**는 계약 (T-100).
 *
 * 카드의 「조합 그룹 N건」 배지는 `toCampaignRow` 의 `groupMemberCount` 하나에서 나오고,
 * 그 값은 include 트리의 `group._count.members` 에서만 온다. 종전 `CAMPAIGN_DETAIL_INCLUDE`
 * 는 `group: true`(스칼라만)라 **목록 읽기 경로만** 숫자를 실었다.
 *
 * 그래서 쓰기 직후 행을 다시 읽는 화면들(그룹 묶기·합류·제외, 정산 수취 결정)이 받은 행은
 * 배지 숫자를 **잃었다** — 숫자가 틀린 게 아니라 사라졌으므로, 그룹에서 한 건을 뺀 뒤 형제
 * 행을 다시 읽어 숫자를 고치는 것이 **원리적으로 불가능**했다.
 *
 * ⚠️ 이 회귀는 **조용하다** — 타입은 `_count` 를 옵셔널로 선언하고(여러 쿼리가 공유한다),
 * 화면은 값이 없으면 아이콘만 그린다. tsc·기존 테스트 어디도 잡지 못한다.
 */

import { describe, it, expect } from "vitest";
import { CAMPAIGN_DETAIL_INCLUDE } from "../campaignService";
import { toCampaignRow } from "@/lib/campaign-row";

/**
 * `toCampaignRow` 의 입력 중 **이 계약과 무관한 필드**를 채우는 베이스.
 * 검사 대상(`group`)은 각 케이스가 명시적으로 얹으므로 타입 검사를 그대로 받는다.
 */
const baseCampaign: Parameters<typeof toCampaignRow>[0] = {
  id: "c1",
  dealId: "d1",
  sellerId: "s1",
  groupId: "g1",
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  startDate: new Date("2026-09-01T00:00:00Z"),
  endDate: new Date("2026-09-07T00:00:00Z"),
  salesChannel: "SELLER_MALL",
  baseNaverLink: "",
  generatedTrackingLink: "",
  actualSales: 0,
  totalMarginRate: 0,
  sellerMarginRate: 0,
  netMarginRate: 0,
  status: "PROPOSAL",
  isManualMargin: false,
  deal: { dealName: "딜A", costPrice: 0, sellingPrice: 0, partner: null },
  seller: { name: "셀러", snsType: "INSTAGRAM", snsHandle: "@seller" },
};

describe("CAMPAIGN_DETAIL_INCLUDE — 그룹 배지 숫자 (T-100)", () => {
  it("그룹 관계에 멤버 수를 함께 싣는다", () => {
    const group = CAMPAIGN_DETAIL_INCLUDE.group;
    // ⛔ `group: true` 로 되돌리지 말 것 — 그러면 이 단언이 깨진다(그게 목적이다).
    expect(group).not.toBe(true);
    expect(group).toMatchObject({ include: { _count: { select: { members: true } } } });
  });

  it("스칼라를 좁히지 않는다 — `select` 로 바꾸면 그룹 컬럼이 사라진다", () => {
    // `campaign-update-plan.ts` 의 「전체 행」 전제와 정산일 9종 오버레이가 여기 걸려 있다.
    expect(CAMPAIGN_DETAIL_INCLUDE.group).not.toHaveProperty("select");
  });

  it("그 모양이 실제로 `groupMemberCount` 로 이어진다 — 소비처까지 확인", () => {
    // 형태만 보면 매퍼가 다른 경로로 읽도록 바뀌었을 때 초록으로 남는다.
    const row = toCampaignRow({
      ...baseCampaign,
      group: { _count: { members: 3 } },
    });
    expect(row.groupMemberCount).toBe(3);

    // 음성 대조군 — `_count` 가 없으면 값이 안 생긴다(그게 종전 상태였다).
    const without = toCampaignRow({ ...baseCampaign, group: {} });
    expect(without.groupMemberCount).toBeUndefined();
  });
});
