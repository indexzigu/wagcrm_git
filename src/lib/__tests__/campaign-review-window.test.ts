import { describe, expect, it } from "vitest";
import {
  CONTENT_REVIEW_TRAIL_DAYS,
  isContentReviewOpen,
} from "@/lib/campaign-review-window";

const DAY_MS = 24 * 60 * 60 * 1000;
// 중립 픽스처 — 실제 운영 캠페인의 날짜를 쓰지 않는다(공개 레포 P0: 실측치는 대화 보고에만).
const END = new Date("2030-03-10T00:00:00.000Z");

describe("isContentReviewOpen", () => {
  it("캠페인 진행 중이면 열려 있다", () => {
    expect(isContentReviewOpen(END, new Date(END.getTime() - 5 * DAY_MS))).toBe(true);
  });

  it("수집창 트레일(마감 +1일)이 지나도 유예 기간 안이면 계속 열려 있다", () => {
    // 마감 다음 날 후보가 통째로 사라지면 검토 기회 자체가 없어진다 — 유예의 존재 이유.
    expect(isContentReviewOpen(END, new Date(END.getTime() + 2 * DAY_MS))).toBe(true);
  });

  it("마감 + 유예 경계 시각은 아직 열려 있다(경계 포함)", () => {
    const boundary = new Date(END.getTime() + CONTENT_REVIEW_TRAIL_DAYS * DAY_MS);
    expect(isContentReviewOpen(END, boundary)).toBe(true);
  });

  it("경계를 1ms라도 넘기면 닫힌다", () => {
    const past = new Date(END.getTime() + CONTENT_REVIEW_TRAIL_DAYS * DAY_MS + 1);
    expect(isContentReviewOpen(END, past)).toBe(false);
  });

  it("마감 열흘 뒤에는 닫혀 있다 — 이 기능이 겨냥하는 상태", () => {
    expect(isContentReviewOpen(END, new Date(END.getTime() + 10 * DAY_MS))).toBe(false);
  });

  it("ISO 문자열 마감일도 같은 판정을 한다", () => {
    expect(
      isContentReviewOpen(END.toISOString(), new Date(END.getTime() + 10 * DAY_MS)),
    ).toBe(false);
  });

  it("마감일이 없으면 열어둔다 — 닫을 근거가 없는데 닫으면 콘텐츠가 조용히 사라진다", () => {
    expect(isContentReviewOpen(null, new Date("2030-01-01T00:00:00.000Z"))).toBe(true);
    expect(isContentReviewOpen(undefined, new Date("2030-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("파싱 불가한 마감일도 열어둔다(판정 불가 → 숨기지 않는다)", () => {
    expect(isContentReviewOpen("not-a-date", new Date("2030-01-01T00:00:00.000Z"))).toBe(true);
  });
});
