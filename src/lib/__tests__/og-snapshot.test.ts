import { afterEach, describe, expect, it, vi } from "vitest";
import { collectOgSnapshot, isFetchableDestination, parseOgTags } from "../og-snapshot";

describe("parseOgTags", () => {
  it("og:title·og:image·og:description 을 뽑는다", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="여름 공구 세트" />
        <meta property="og:image" content="https://cdn.example.com/a.png" />
        <meta property="og:description" content="한정 수량" />
      </head><body>본문</body></html>`;
    expect(parseOgTags(html)).toEqual({
      title: "여름 공구 세트",
      image: "https://cdn.example.com/a.png",
      description: "한정 수량",
    });
  });

  it("property 대신 name 을 쓰는 페이지도 읽는다", () => {
    // 국내 쇼핑몰 상당수가 name= 으로 쓴다 — property 만 보면 통째로 놓친다.
    const html = `<meta name="og:image" content="https://cdn.example.com/b.png">`;
    expect(parseOgTags(html).image).toBe("https://cdn.example.com/b.png");
  });

  it("og:title 이 없으면 <title> 로 폴백한다", () => {
    const html = `<html><head><title>  대체 제목  </title></head></html>`;
    expect(parseOgTags(html).title).toBe("대체 제목");
  });

  it("HTML 엔티티를 되돌린다", () => {
    // &amp; 가 그대로 남으면 미리보기 제목에 그 글자가 노출된다.
    const html = `<meta property="og:title" content="A &amp; B &lt;세트&gt;">`;
    expect(parseOgTags(html).title).toBe("A & B <세트>");
  });

  it("작은따옴표 속성도 읽는다", () => {
    const html = `<meta property='og:image' content='https://cdn.example.com/c.png'>`;
    expect(parseOgTags(html).image).toBe("https://cdn.example.com/c.png");
  });

  it("아무것도 없으면 전부 null 이다", () => {
    expect(parseOgTags("<html><body>없음</body></html>")).toEqual({
      title: null,
      image: null,
      description: null,
    });
  });
});

describe("isFetchableDestination", () => {
  it("공개 http/https 주소는 허용한다", () => {
    expect(isFetchableDestination("https://brand.example.com/view/good/AbC123")).toBe(true);
    expect(isFetchableDestination("http://brand.example.com/p/1")).toBe(true);
  });

  it("루프백·사설 대역을 거부한다", () => {
    // 이 fetch 는 프로덕션 호스트에서 나가고 그 기계엔 자체호스팅 Supabase 가
    // 127.0.0.1 로 떠 있다. 가드가 없으면 내부 주소를 대신 열어보는 통로가 된다.
    for (const host of [
      "http://127.0.0.1:8000/x",
      "http://localhost/x",
      "http://[::1]/x",
      "http://10.0.0.5/x",
      "http://192.168.0.1/x",
      "http://172.16.0.1/x",
      "http://172.31.255.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://db.local/x",
    ]) {
      expect(isFetchableDestination(host), host).toBe(false);
    }
  });

  it("사설 대역과 인접한 공개 주소는 막지 않는다", () => {
    // 172.15/172.32 는 사설이 아니다 — 범위를 대충 잡으면 정상 목적지를 막는다.
    expect(isFetchableDestination("http://172.15.0.1/x")).toBe(true);
    expect(isFetchableDestination("http://172.32.0.1/x")).toBe(true);
  });

  it("http/https 가 아니거나 파싱 불가면 거부한다", () => {
    expect(isFetchableDestination("javascript:alert(1)")).toBe(false);
    expect(isFetchableDestination("그냥 문자열")).toBe(false);
  });
});

describe("collectOgSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("목적지 HTML 에서 스냅샷을 만든다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('<meta property="og:image" content="https://cdn.example.com/a.png">', {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      ),
    );
    await expect(collectOgSnapshot("https://brand.example.com/p/1")).resolves.toMatchObject({
      image: "https://cdn.example.com/a.png",
    });
  });

  it("사설 주소는 fetch 자체를 하지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(collectOgSnapshot("http://127.0.0.1:8000/x")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTML 이 아니면 null 이다", async () => {
    // 이미지·PDF 링크를 그대로 파싱하면 쓰레기 제목이 미리보기에 박힌다.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("%PDF-1.4", {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          }),
      ),
    );
    await expect(collectOgSnapshot("https://brand.example.com/a.pdf")).resolves.toBeNull();
  });

  it("응답이 실패거나 fetch 가 던져도 null 로 흡수한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(collectOgSnapshot("https://brand.example.com/p/1")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    await expect(collectOgSnapshot("https://brand.example.com/p/1")).resolves.toBeNull();
  });

  it("리다이렉트가 사설 주소로 착지하면 따라가지 않는다", async () => {
    // 첫 홉만 검사하면 공개 주소로 통과한 뒤 302 로 내부망에 착지할 수 있다.
    // 이 fetch 는 프로덕션 호스트에서 나가므로 홉마다 다시 판정한다.
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:8000/x" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(collectOgSnapshot("https://brand.example.com/p/1")).resolves.toBeNull();
    // 첫 홉은 나갔지만 두 번째 홉은 나가지 않았다
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("공개 주소로의 리다이렉트는 따라간다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { Location: "https://brand.example.com/final" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<meta property="og:title" content="최종 페이지">', {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(collectOgSnapshot("https://brand.example.com/p/1")).resolves.toMatchObject({
      title: "최종 페이지",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("리다이렉트가 너무 길면 포기한다", async () => {
    // 무한 루프에 갇히지 않게 홉 수를 제한한다.
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://brand.example.com/next" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(collectOgSnapshot("https://brand.example.com/p/1")).resolves.toBeNull();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("건질 게 하나도 없으면 null 이다", async () => {
    // 빈 스냅샷을 저장하면 ogFetchedAt 만 찍혀 24시간 동안 폴백조차 막는다.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><body>본문뿐</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );
    await expect(collectOgSnapshot("https://brand.example.com/p/1")).resolves.toBeNull();
  });
});
