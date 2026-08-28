import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchNaverBlogVoc } from "../content-guide-voc";

const okResponse = (items: unknown[]) => ({ ok: true, json: async () => ({ items }) });

describe("fetchNaverBlogVoc", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.NAVER_SEARCH_CLIENT_ID = "test-id";
    process.env.NAVER_SEARCH_CLIENT_SECRET = "test-secret";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...origEnv };
  });

  it("블로그 후기 description을 HTML 태그·엔티티 제거해 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse([
          { description: "<b>휙</b> 스타일러 285g 가벼움 &amp; 다이슨 대비 가성비 후기입니다" },
          { description: "가방 구성이 좋아서 여행에 챙기기 편했어요 정말 만족스러웠습니다" },
        ])
      )
    );
    const out = await fetchNaverBlogVoc("휙 스타일러");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("휙 스타일러 285g");
    expect(out[0]).not.toContain("<b>");
    expect(out[0]).toContain("&"); // &amp; → &
  });

  it("20자 미만 스니펫은 제외한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse([
          { description: "짧음" },
          { description: "이건 충분히 긴 소비자 후기 스니펫입니다 정말로 그렇습니다" },
        ])
      )
    );
    expect(await fetchNaverBlogVoc("제품")).toHaveLength(1);
  });

  it("최대 6건으로 제한한다", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      description: `충분히 긴 소비자 후기 스니펫 번호 ${i} 입니다 정말로 그렇습니다`,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(many)));
    expect(await fetchNaverBlogVoc("제품")).toHaveLength(6);
  });

  it("res.ok=false면 빈 배열", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await fetchNaverBlogVoc("제품")).toEqual([]);
  });

  it("items가 없으면 빈 배열", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([])));
    expect(await fetchNaverBlogVoc("제품")).toEqual([]);
  });

  it("fetch 예외면 빈 배열(비차단)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      })
    );
    expect(await fetchNaverBlogVoc("제품")).toEqual([]);
  });

  it("키 미설정이면 fetch 호출 없이 빈 배열", async () => {
    delete process.env.NAVER_SEARCH_CLIENT_ID;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await fetchNaverBlogVoc("제품")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("빈/공백 쿼리면 fetch 호출 없이 빈 배열", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await fetchNaverBlogVoc("   ")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
