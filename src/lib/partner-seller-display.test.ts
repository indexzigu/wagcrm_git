import { describe, it, expect } from "vitest";
import {
  formatFollowerCount,
  calculateBarWidth,
  formatLastContact,
  getDisplayContact,
  campaignRecency,
  isRecentlyRegistered,
  NEW_SELLER_WINDOW_DAYS,
} from "./partner-seller-display";

type ContactLike = {
  phoneNumber?: string | null;
  email?: string | null;
};

describe("formatFollowerCount", () => {
  it("returns '0' for count 0", () => {
    expect(formatFollowerCount(0)).toBe("0");
  });

  it("formats 10,000 as '1.0만'", () => {
    expect(formatFollowerCount(10000)).toBe("1.0만");
  });

  it("formats 15,300 as '1.5만'", () => {
    expect(formatFollowerCount(15300)).toBe("1.5만");
  });

  it("formats 153,000 as '15.3만'", () => {
    expect(formatFollowerCount(153000)).toBe("15.3만");
  });

  it("formats 300,000 as '30.0만'", () => {
    expect(formatFollowerCount(300000)).toBe("30.0만");
  });

  it("formats 9,500 with comma as '9,500'", () => {
    expect(formatFollowerCount(9500)).toBe("9,500");
  });

  it("formats 300 with comma as '300'", () => {
    expect(formatFollowerCount(300)).toBe("300");
  });

  it("formats 1 as '1'", () => {
    expect(formatFollowerCount(1)).toBe("1");
  });
});

describe("calculateBarWidth", () => {
  it("returns 0 for count 0", () => {
    expect(calculateBarWidth(0)).toBe(0);
  });

  it("returns 0 for negative count", () => {
    expect(calculateBarWidth(-100)).toBe(0);
  });

  it("returns minimum 1% for count 1", () => {
    expect(calculateBarWidth(1)).toBe(1);
  });

  it("returns 50% for 150,000", () => {
    expect(calculateBarWidth(150000)).toBe(50);
  });

  it("returns 100% for 300,000", () => {
    expect(calculateBarWidth(300000)).toBe(100);
  });

  it("returns 100% (capped) for count exceeding 300,000", () => {
    expect(calculateBarWidth(500000)).toBe(100);
  });

  it("returns correct proportional width for 30,000", () => {
    expect(calculateBarWidth(30000)).toBe(10);
  });
});

describe("formatLastContact", () => {
  it("formats date as YYYY-MM-DD", () => {
    const date = new Date(2024, 2, 15); // March 15, 2024
    expect(formatLastContact(date)).toBe("2024-03-15");
  });

  it("pads single-digit month and day", () => {
    const date = new Date(2024, 0, 5); // January 5, 2024
    expect(formatLastContact(date)).toBe("2024-01-05");
  });

  it("handles December 31", () => {
    const date = new Date(2023, 11, 31); // December 31, 2023
    expect(formatLastContact(date)).toBe("2023-12-31");
  });
});

describe("getDisplayContact", () => {
  it("returns empty string for empty array", () => {
    expect(getDisplayContact([])).toBe("");
  });

  it("returns empty string for null/undefined input", () => {
    expect(getDisplayContact(null as unknown as ContactLike[])).toBe("");
    expect(getDisplayContact(undefined as unknown as ContactLike[])).toBe("");
  });

  it("returns phoneNumber of first contact when available", () => {
    const contacts = [
      { phoneNumber: "010-1234-5678", email: "test@example.com" },
      { phoneNumber: "010-9999-8888", email: "other@example.com" },
    ];
    expect(getDisplayContact(contacts)).toBe("010-1234-5678");
  });

  it("returns email of first contact when phoneNumber is null", () => {
    const contacts = [
      { phoneNumber: null, email: "test@example.com" },
      { phoneNumber: "010-9999-8888", email: "other@example.com" },
    ];
    expect(getDisplayContact(contacts)).toBe("test@example.com");
  });

  it("returns email of first contact when phoneNumber is undefined", () => {
    const contacts = [{ email: "test@example.com" }];
    expect(getDisplayContact(contacts)).toBe("test@example.com");
  });

  it("returns empty string when first contact has no phoneNumber or email", () => {
    const contacts = [{ phoneNumber: null, email: null }];
    expect(getDisplayContact(contacts)).toBe("");
  });
});

describe("campaignRecency", () => {
  // 결정적 시각: 2026-07-16T00:00:00Z
  const NOW = Date.parse("2026-07-16T00:00:00Z");
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
  const daysAhead = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

  it("캠페인이 없으면 null (셀은 최근성 줄을 그리지 않는다)", () => {
    expect(campaignRecency([], NOW)).toBeNull();
    expect(campaignRecency(null, NOW)).toBeNull();
    expect(campaignRecency(undefined, NOW)).toBeNull();
  });

  it("기간 안이면 진행 중 — 과거 이력보다 우선한다", () => {
    expect(
      campaignRecency(
        [
          { startDate: daysAgo(3), endDate: daysAhead(4) },
          { startDate: daysAgo(200), endDate: daysAgo(190) },
        ],
        NOW,
      ),
    ).toEqual({ kind: "active", label: "진행 중" });
  });

  it("미래 시작 캠페인이 있으면 시작 예정 — 과거 종료 경과보다 우선한다", () => {
    expect(
      campaignRecency(
        [
          { startDate: daysAhead(7), endDate: daysAhead(14) },
          { startDate: daysAgo(100), endDate: daysAgo(90) },
        ],
        NOW,
      ),
    ).toEqual({ kind: "upcoming", label: "시작 예정" });
  });

  it("과거만 있으면 가장 최근 종료 기준 경과 라벨 (일/개월/년 버킷)", () => {
    expect(campaignRecency([{ startDate: daysAgo(20), endDate: daysAgo(10) }], NOW)).toEqual({
      kind: "past",
      label: "10일 전 종료",
    });
    expect(campaignRecency([{ startDate: daysAgo(100), endDate: daysAgo(90) }], NOW)).toEqual({
      kind: "past",
      label: "3개월 전 종료",
    });
    expect(campaignRecency([{ startDate: daysAgo(800), endDate: daysAgo(780) }], NOW)).toEqual({
      kind: "past",
      label: "2년 전 종료",
    });
  });

  it("여러 과거 캠페인 중 가장 최근 종료를 고른다 (배열 순서 무관)", () => {
    expect(
      campaignRecency(
        [
          { startDate: daysAgo(300), endDate: daysAgo(290) },
          { startDate: daysAgo(30), endDate: daysAgo(15) },
        ],
        NOW,
      ),
    ).toEqual({ kind: "past", label: "15일 전 종료" });
  });

  it("오늘 종료(경과 0일)는 '오늘 종료'", () => {
    expect(campaignRecency([{ startDate: daysAgo(5), endDate: daysAgo(0.5) }], NOW)).toEqual({
      kind: "past",
      label: "오늘 종료",
    });
  });

  it("DROPPED는 관계 신호가 아니다 — 제외하고 판정한다", () => {
    expect(
      campaignRecency(
        [
          { startDate: daysAhead(7), endDate: daysAhead(14), status: "DROPPED" },
          { startDate: daysAgo(100), endDate: daysAgo(90), status: "COMPLETED" },
        ],
        NOW,
      ),
    ).toEqual({ kind: "past", label: "3개월 전 종료" });
    expect(
      campaignRecency([{ startDate: daysAgo(10), endDate: daysAgo(5), status: "DROPPED" }], NOW),
    ).toBeNull();
  });

  it("깨진 날짜는 건너뛴다 — 전부 깨졌으면 null", () => {
    expect(
      campaignRecency(
        [
          { startDate: "not-a-date", endDate: daysAgo(5) },
          { startDate: daysAgo(30), endDate: daysAgo(20) },
        ],
        NOW,
      ),
    ).toEqual({ kind: "past", label: "20일 전 종료" });
    expect(campaignRecency([{ startDate: "x", endDate: "y" }], NOW)).toBeNull();
  });

  describe("캡 무관 서버 집계 신호 (take:12 절단 근본수정)", () => {
    // 회귀 시나리오: 캠페인 13건+ 셀러 — 오래 전 시작해 아직 진행 중인 캠페인이
    // startDate desc 12건 창 밖으로 밀려, 캡 배열만 보면 '종료'로 오판되는 케이스.
    const cappedPastOnly = [{ startDate: daysAgo(25), endDate: daysAgo(15) }];

    it("신호의 진행 중이 캡 배열의 '종료' 판정을 이긴다", () => {
      expect(campaignRecency(cappedPastOnly, NOW, { hasActiveCampaign: true })).toEqual({
        kind: "active",
        label: "진행 중",
      });
    });

    it("신호의 시작 예정이 캡 배열의 '종료' 판정을 이긴다", () => {
      expect(
        campaignRecency(cappedPastOnly, NOW, {
          hasActiveCampaign: false,
          hasUpcomingCampaign: true,
        }),
      ).toEqual({ kind: "upcoming", label: "시작 예정" });
    });

    it("신호의 lastCampaignEndAt이 캡 배열의 더 오래된 종료보다 우선한다", () => {
      expect(
        campaignRecency(cappedPastOnly, NOW, {
          hasActiveCampaign: false,
          hasUpcomingCampaign: false,
          lastCampaignEndAt: daysAgo(10),
        }),
      ).toEqual({ kind: "past", label: "10일 전 종료" });
    });

    it("신호가 아무 판정도 못 내면(캠페인 없음) 캡 배열로 폴백한다", () => {
      expect(
        campaignRecency(cappedPastOnly, NOW, {
          hasActiveCampaign: false,
          hasUpcomingCampaign: false,
          lastCampaignEndAt: null,
        }),
      ).toEqual({ kind: "past", label: "15일 전 종료" });
    });

    it("신호 미제공(구 페이로드·집계 실패)이면 기존 캡 배열 동작 그대로", () => {
      expect(campaignRecency(cappedPastOnly, NOW, undefined)).toEqual({
        kind: "past",
        label: "15일 전 종료",
      });
    });

    it("깨진 lastCampaignEndAt은 무시하고 캡 배열로 폴백한다", () => {
      expect(
        campaignRecency(cappedPastOnly, NOW, { lastCampaignEndAt: "not-a-date" }),
      ).toEqual({ kind: "past", label: "15일 전 종료" });
    });

    it("신호만 있고 배열이 비어도 판정한다 (배열은 판정의 전제조건이 아니다)", () => {
      expect(campaignRecency([], NOW, { hasActiveCampaign: true })).toEqual({
        kind: "active",
        label: "진행 중",
      });
      expect(
        campaignRecency(null, NOW, { lastCampaignEndAt: daysAgo(90) }),
      ).toEqual({ kind: "past", label: "3개월 전 종료" });
    });
  });
});

describe("isRecentlyRegistered", () => {
  const DAY = 86_400_000;
  const now = new Date("2026-07-23T12:00:00Z").getTime();

  it("등록 직후(0일)는 신규다", () => {
    expect(isRecentlyRegistered(new Date(now).toISOString(), now)).toBe(true);
  });

  it("창 안(6일 23시간)은 신규다", () => {
    expect(
      isRecentlyRegistered(new Date(now - (NEW_SELLER_WINDOW_DAYS * DAY - 3_600_000)).toISOString(), now),
    ).toBe(true);
  });

  it("정확히 7일 경과는 신규가 아니다 (창은 미만 반개구간)", () => {
    expect(
      isRecentlyRegistered(new Date(now - NEW_SELLER_WINDOW_DAYS * DAY).toISOString(), now),
    ).toBe(false);
  });

  it("createdAt 부재·파싱 불가는 신규로 꾸미지 않는다", () => {
    expect(isRecentlyRegistered(undefined, now)).toBe(false);
    expect(isRecentlyRegistered(null, now)).toBe(false);
    expect(isRecentlyRegistered("not-a-date", now)).toBe(false);
  });

  it("미래 시각(시계 오차)은 신규로 판정한다", () => {
    expect(isRecentlyRegistered(new Date(now + DAY).toISOString(), now)).toBe(true);
  });
});
