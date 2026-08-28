import { describe, expect, it } from "vitest";
import { buildPreviewRefreshUrl } from "./short-link";

/**
 * 메신저가 URL 단위로 굳힌 미리보기 캐시를 우회하는 링크.
 *
 * 이 URL 이 성립하는 유일한 근거는 **리다이렉터가 pathname 첫 세그먼트만 코드로
 * 읽는다**는 것이다. 그래서 아래 "코드 세그먼트 불변" 단언이 이 파일의 핵심이고,
 * 나머지는 그 주변이다.
 */
describe("buildPreviewRefreshUrl", () => {
  const SHORT = "https://go.ygrd.kr/Kp7mQ2xd";

  it("단축링크 뒤에 r 접두 꼬리를 붙인다", () => {
    expect(buildPreviewRefreshUrl(SHORT, 1_755_000_000_000)).toMatch(
      /^https:\/\/go\.ygrd\.kr\/Kp7mQ2xd\/r[0-9a-z]+$/,
    );
  });

  it("코드 세그먼트를 바꾸지 않는다 — 리다이렉터가 첫 세그먼트만 읽는다", () => {
    const url = new URL(buildPreviewRefreshUrl(SHORT, 1_755_000_000_000));
    expect(url.pathname.split("/")[1]).toBe("Kp7mQ2xd");
    expect(url.origin).toBe("https://go.ygrd.kr");
    // 쿼리를 만들지 않는다 — 쿼리는 목적지로 병합돼 상품 URL 을 오염시킨다.
    expect(url.search).toBe("");
  });

  it("누를 때마다 다른 URL 이다 — 같은 URL 이면 캐시가 안 깨진다", () => {
    expect(buildPreviewRefreshUrl(SHORT, 1_755_000_000_000)).not.toBe(
      buildPreviewRefreshUrl(SHORT, 1_755_000_000_001),
    );
  });

  it("후행 슬래시를 흡수한다 — // 가 생기면 코드 세그먼트가 빈 문자열이 된다", () => {
    const url = new URL(buildPreviewRefreshUrl(`${SHORT}/`, 1_755_000_000_000));
    expect(url.pathname.split("/")[1]).toBe("Kp7mQ2xd");
  });

  it("셀러가 뒤에 ?s= 를 덧붙여도 정상 합성된다", () => {
    const url = new URL(`${buildPreviewRefreshUrl(SHORT, 1_755_000_000_000)}?s=story1`);
    expect(url.searchParams.get("s")).toBe("story1");
    expect(url.pathname.split("/")[1]).toBe("Kp7mQ2xd");
  });
});
