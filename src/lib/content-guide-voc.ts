// 콘텐츠 가이드용 소비자 VOC — 네이버 블로그 후기 검색(무료 공식 오픈API, 비로그인 서버-투-서버).
// R4 라우트가 "이 상품 콘텐츠 가이드" 요청 시 상품명으로 실시간 호출해, 소구점을 실제 소비자
// 후기 언어에 근거하게 한다. price-monitor/market-fetch.ts(shop.json)는 다른 세션 WIP라 건드리지
// 않고, blog.json 호출을 이 모듈로 분리한다. 인증은 헤더의 Client ID/Secret뿐(env 재사용).

/** 네이버 검색 응답의 HTML 하이라이트 태그·엔티티를 제거한다. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/**
 * 상품명으로 네이버 블로그 후기를 검색해 소비자 소구점 후보(설명 스니펫)를 반환한다.
 * 키 미설정·빈 쿼리·HTTP 실패·예외·0건이면 빈 배열(비차단 — 가이드는 후기 없이도 생성된다).
 *
 * @param query 정밀한 상품 쿼리. 브랜드명 단독은 동음이의 노이즈가 크므로(예: '나리'=공압부품),
 *              호출부에서 딜의 searchKeyword(가격 모니터링용 정밀 쿼리)를 우선 넘긴다.
 * @param max   반환 스니펫 상한(기본 6).
 */
export async function fetchNaverBlogVoc(query: string, max = 6): Promise<string[]> {
  const clientId = process.env.NAVER_SEARCH_CLIENT_ID;
  const clientSecret = process.env.NAVER_SEARCH_CLIENT_SECRET;
  if (!clientId || !clientSecret || query.trim().length === 0) return [];

  try {
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(
      `${query} 후기`
    )}&display=15&sort=sim`;
    const res = await fetch(url, {
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as { items?: { description?: string }[] };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of data.items ?? []) {
      const desc = stripHtml(String(item.description ?? ""));
      if (desc.length < 20) continue; // 스니펫이 너무 짧으면 신호 가치 낮음
      const dedupeKey = desc.slice(0, 30);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(desc);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}
