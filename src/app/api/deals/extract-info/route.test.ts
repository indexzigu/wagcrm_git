import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const HUBRON_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>휴브론 | 3 in 1 무선고데기 - 스타일링 혁신</title>
  <meta property="og:title" content="휴브론 3 in 1 무선고데기 - 휴브론" />
  <meta name="description" content="휴브론 | 3 in 1 무선고데기. 기내 반입 가능하고 사용성이 뛰어난 스타일링 도구." />
  <meta name="keywords" content="무선고데기, 3 in 1 고데기, 기내 반입 고데기, 스타일링 도구, 휴브론" />
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Product","name":"휴브론 3 in 1 무선고데기","description":"기내 반입이 가능한 3배럴 헤드 무선고데기!","brand":{"@type":"Brand","name":"휴브론"}}
  </script>
</head>
<body></body>
</html>
`;

function mockFetchSequence(responses: Array<() => Promise<Response> | Response>) {
  let call = 0;
  return vi.fn(async () => {
    const handler = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return handler();
  });
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/deals/extract-info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/deals/extract-info", () => {
  const originalEnv = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.GEMINI_API_KEY = originalEnv;
    vi.unstubAllGlobals();
  });

  it("정상 크롤링 + 정상 JSON 응답: searchKeyword/modelName/crawl.ok=true를 반환한다", async () => {
    const fetchMock = mockFetchSequence([
      () => new Response(HUBRON_HTML, { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ searchKeyword: "휴브론 3 in 1 무선고데기", modelName: null }) }],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      makeRequest({ url: "https://hubron.co.kr/product/x/21/", brandName: "휴브론", dealName: "휴브론 3 in 1 무선고데기" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.searchKeyword).toBe("휴브론 3 in 1 무선고데기");
    expect(data.searchKeyword).toContain("3 in 1"); // 핵심 회귀: "3 in 1"이 오폭 제거되지 않아야 한다
    expect(data.crawl).toEqual({ attempted: true, ok: true });
  });

  it("크롤링 실패(비200)를 조용히 삼키지 않고 crawl.ok=false + httpStatus를 노출한다", async () => {
    const fetchMock = mockFetchSequence([
      () => new Response("Bad Gateway", { status: 502 }),
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: JSON.stringify({ searchKeyword: "뉴트리원 오메가3", modelName: null }) }] } },
            ],
          }),
          { status: 200 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      makeRequest({ url: "https://nutrione.example.com/product/1", brandName: "뉴트리원", dealName: "오메가3" }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.crawl.attempted).toBe(true);
    expect(data.crawl.ok).toBe(false);
    expect(data.crawl.httpStatus).toBe(502);
    // 크롤링 실패해도 CRM 데이터만으로 추출은 계속 진행된다(silent degradation 제거 ≠ 추출 중단)
    expect(data.searchKeyword).toBe("뉴트리원 오메가3");
  });

  it("URL이 없으면 crawl.attempted=false이고 추출은 CRM 데이터만으로 진행된다", async () => {
    const fetchMock = mockFetchSequence([
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ searchKeyword: "종근당 락토핏 골드", modelName: null }) }] } }],
          }),
          { status: 200 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ brandName: "종근당", dealName: "락토핏 골드" }));
    const data = await res.json();

    expect(data.crawl).toEqual({ attempted: false, ok: false });
    expect(data.searchKeyword).toBe("종근당 락토핏 골드");
  });

  it("Gemini가 비JSON 텍스트를 반환하면 전체 텍스트를 searchKeyword로, modelName은 null로 폴백한다", async () => {
    const fetchMock = mockFetchSequence([
      () => new Response(HUBRON_HTML, { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "휴브론 3 in 1 무선고데기" }] } }],
          }),
          { status: 200 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ url: "https://hubron.co.kr/product/x/21/", brandName: "휴브론", dealName: "휴브론 3 in 1 무선고데기" }));
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.searchKeyword).toBe("휴브론 3 in 1 무선고데기");
    expect(data.modelName).toBeNull();
  });

  it("Gemini가 modelName을 채워 반환하면 그대로 전달한다", async () => {
    const fetchMock = mockFetchSequence([
      () => new Response(HUBRON_HTML, { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ searchKeyword: "파워브랜드 파워뱅크 보조배터리", modelName: "PB-10000X" }) }],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ url: "https://example.com/x", brandName: "파워브랜드", dealName: "파워뱅크 보조배터리" }));
    const data = await res.json();

    expect(data.modelName).toBe("PB-10000X");
  });

  it("[Major 1 회귀] Gemini가 마크다운 코드펜스로 감싼 JSON을 반환해도 펜스를 벗겨 깨끗하게 파싱한다", async () => {
    const fencedJson = '```json\n{"searchKeyword": "휴브론 3 in 1 무선고데기", "modelName": null}\n```';
    const fetchMock = mockFetchSequence([
      () => new Response(HUBRON_HTML, { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: fencedJson }] } }],
          }),
          { status: 200 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      makeRequest({ url: "https://hubron.co.kr/product/x/21/", brandName: "휴브론", dealName: "휴브론 3 in 1 무선고데기" }),
    );
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.searchKeyword).toBe("휴브론 3 in 1 무선고데기");
    expect(data.searchKeyword).not.toContain("```");
    expect(data.modelName).toBeNull();
  });

  it("[Major 1 회귀] 언어태그 없는 코드펜스(```...```)도 벗겨 파싱한다", async () => {
    const fencedJson = '```\n{"searchKeyword": "종근당 락토핏 골드", "modelName": null}\n```';
    const fetchMock = mockFetchSequence([
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: fencedJson }] } }],
          }),
          { status: 200 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(makeRequest({ brandName: "종근당", dealName: "락토핏 골드" }));
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.searchKeyword).toBe("종근당 락토핏 골드");
  });
});
