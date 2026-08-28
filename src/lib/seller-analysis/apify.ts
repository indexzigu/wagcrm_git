// Apify 토큰 로테이션 — env 기반 (원천 influencer-commerce-admin/src/lib/apify.ts의 스크래퍼 클라이언트 부분만 이관).
// 데이터 형상 타입·미디어/타임스탬프 헬퍼는 types.ts로 분리됨. 여기엔 스크래퍼가 쓰는 토큰 로테이션만 둔다.
//
// 시작 오프셋 무작위화: 서버리스는 콜드스타트마다 모듈이 새로 로드되어 tokenIndex가 0으로 리셋된다.
// 0 고정이면 매 인스턴스가 tokens[0]부터 시작해 첫 토큰(계정)에 호출이 몰린다. 무작위 시작으로
// 여러 계정에 고르게 분산한다(같은 인스턴스 내 연속 호출은 여전히 라운드로빈).
let tokenIndex = Math.floor(Math.random() * 1000);

export function getApifyToken(): string | undefined {
  const tokensStr = process.env.APIFY_API_TOKENS;
  const singleToken = process.env.APIFY_API_TOKEN;
  const tokens: string[] = [];
  if (tokensStr) tokens.push(...tokensStr.split(",").map((t) => t.trim()).filter(Boolean));
  if (singleToken && !tokens.includes(singleToken)) tokens.push(singleToken);
  if (tokens.length === 0) return undefined;
  const token = tokens[tokenIndex % tokens.length];
  tokenIndex++;
  return token;
}
