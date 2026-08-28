/**
 * 품목별 매출 리스트의 공통 접두어(딜명·셀러·카테고리 라벨 등)를 한 번만 남기고
 * 각 항목에서 제거해, 구분되는 꼬리(옵션값)만 노출하기 위한 순수 계산.
 *
 * 배경: 네이버 표시명은 "[셀러 X 브랜드] 딜명 · 카테고리: [옵션코드] 용량 색상" 꼴로,
 * 한 캠페인 안에서는 앞쪽 접두어가 대부분 동일하고 뒤쪽(옵션값)만 달라진다. 모바일
 * 좁은 폭에서 접두어가 자리를 다 먹으면 정작 구분 기준인 옵션값이 잘려 비교가 안 된다.
 *
 * 설계 — "여러 케이스" 대응이 목적이라 다음을 모두 한 규칙으로 처리한다:
 * - **다수결(strict majority):** 각 토큰 위치에서 현재 그룹의 과반이 공유하는 토큰만
 *   공통으로 인정하고, 그 토큰을 가진 행으로 그룹을 좁혀 나간다. 옵션코드가 반반으로
 *   갈리는 지점(예: VA-115 vs VA-123)에서 자연히 멈춰, 구분 코드는 꼬리에 남는다.
 * - **outlier 보존:** 사은품/이종상품처럼 접두어가 다른 소수 항목은 공통 접두어에
 *   매칭되지 않으므로 원문 그대로 유지된다.
 * - **토큰 = 공백 분리:** 네이버 표시명의 자연 구분자(· : [ ])는 공백에 붙어 오므로
 *   공백 분리만으로 안전하게 경계가 잡힌다(단어 중간을 자르지 않는다).
 * - **빈 꼬리 방지:** 접두어를 떼면 빈 문자열이 되는 항목은 떼지 않고 원문을 유지한다.
 * - **실익 게이트:** 실제로 2개 미만 항목만 짧아지면 이득이 없다고 보고 원문을 그대로 둔다.
 */
export type CommonPrefixResult = {
  /** 과반이 공유하는 공통 접두어(표시용, 끝 구분자 정리됨). 없으면 "" */
  shared: string;
  /** names 와 1:1 대응. 공통 접두어가 제거된 표시명(미해당 항목은 원문 유지) */
  labels: string[];
};

/** 표시명 배열에서 공통 선두 접두어를 뽑아내고, 각 항목의 꼬리 라벨을 반환한다. */
export function extractCommonItemPrefix(names: string[]): CommonPrefixResult {
  const passthrough: CommonPrefixResult = { shared: "", labels: names.slice() };
  if (names.length < 2) return passthrough;

  const tokenized = names.map((name) => name.trim().split(/\s+/).filter(Boolean));

  // 공통 접두어 토큰을 누적하고, 접두어를 실제로 공유하는 행(alive)만 남겨 나간다.
  // 임계값 분모는 항상 "전체 개수"로 고정한다 — 그래야 소수 하위계열(예: 옵션코드가
  // 2:1 로 갈리는 지점)의 다수 토큰까지 빨아들이지 않고, 전체 과반이 공유하는 지점까지만
  // 접힌다. 동시에 소수 outlier(사은품 등)는 일찍 탈락시켜 stripping 을 막지 않는다.
  const total = names.length;
  const prefix: string[] = [];
  let alive = tokenized.map((_, index) => index);

  for (let pos = 0; alive.length >= 2; pos++) {
    const counts = new Map<string, number>();
    for (const index of alive) {
      const token = tokenized[index][pos];
      if (token === undefined) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    if (counts.size === 0) break;

    let modeToken = "";
    let modeCount = 0;
    for (const [token, count] of counts) {
      if (count > modeCount) {
        modeToken = token;
        modeCount = count;
      }
    }

    // 전체의 "과반 초과"만 공통으로 인정 — 반반(동률)이면 여기서 멈춰 구분값을 남긴다.
    if (modeCount <= total / 2) break;

    prefix.push(modeToken);
    alive = alive.filter((index) => tokenized[index][pos] === modeToken);
  }

  if (prefix.length === 0) return passthrough;

  // 각 항목: 공통 접두어로 시작하면 그만큼 제거, 아니면 원문 유지.
  let strippedCount = 0;
  const labels = tokenized.map((tokens, index) => {
    const matchesPrefix = prefix.every((token, j) => tokens[j] === token);
    if (!matchesPrefix) return names[index];
    const tail = tokens.slice(prefix.length).join(" ").trim();
    if (!tail) return names[index]; // 꼬리가 비면 원문 유지(빈 행 방지)
    strippedCount += 1;
    return tail;
  });

  if (strippedCount < 2) return passthrough; // 실질 이득 없음 → 원문 유지

  return { shared: tidyShared(prefix.join(" ")), labels };
}

/** 공통 접두어 표시 정리 — 끝에 매달린 구분자(· : ,)와 잉여 공백 제거. */
function tidyShared(shared: string): string {
  return shared.replace(/[\s·:,]+$/u, "").trim();
}
