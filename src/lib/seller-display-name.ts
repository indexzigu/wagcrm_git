// 셀러 화면 이름 — 별칭이 있으면 별칭(P2 Seller Alias Priority). 공백뿐인 별칭은 없는 것으로 본다.
// client-safe 순수 함수(의존성 없음) — 서버·화면이 같은 규칙을 쓰게 한 곳에 둔다.
export function sellerDisplayName(seller: { name: string; alias: string | null }): string {
  return seller.alias && seller.alias.trim() !== "" ? seller.alias : seller.name;
}
