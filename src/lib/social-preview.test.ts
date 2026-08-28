import { describe, expect, it } from "vitest";
import { getSocialPreviewRewritePath } from "./social-preview";

describe("getSocialPreviewRewritePath", () => {
  it("카카오 공유 크롤러의 셀러 상세 요청만 안전한 미리보기 경로로 바꾼다", () => {
    expect(
      getSocialPreviewRewritePath(
        "/sellers/cmph95ltk00cbqe1awe8z4yec",
        "kakaotalk-scrap/1.0",
      ),
    ).toBe("/share/sellers/cmph95ltk00cbqe1awe8z4yec");
  });

  it("일반 브라우저는 기존 로그인 흐름을 유지한다", () => {
    expect(
      getSocialPreviewRewritePath(
        "/sellers/cmph95ltk00cbqe1awe8z4yec",
        "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      ),
    ).toBeNull();
  });

  it("공유 크롤러라도 셀러 목록이나 하위 경로는 바꾸지 않는다", () => {
    expect(getSocialPreviewRewritePath("/sellers", "facebookexternalhit/1.1")).toBeNull();
    expect(getSocialPreviewRewritePath("/sellers/id/history", "Slackbot-LinkExpanding 1.0")).toBeNull();
  });
});
