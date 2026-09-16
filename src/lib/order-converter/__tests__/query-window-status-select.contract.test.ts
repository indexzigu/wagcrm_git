import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 계약: **조회창 시작일을 `resolveCampaignQueryStartMs` 로 구하는 라우트는 `salesCampaigns` 에
 * `status` 를 함께 select 해야 한다.**
 *
 * 왜 기계로 막는가: `status` 는 "끝난 회차(정산 락)를 창 계산에서 뺀다"는 게이트의 **유일한
 * 입력**인데, 그 값이 없을 때의 동작이 **크래시가 아니라 fail-safe(락 아님)** 다. 그래서 select
 * 에서 빠지면 게이트만 조용히 죽고 창은 종전처럼 넓어진다 — 화면도 로그도 아무 말을 하지 않고,
 * 증상은 "주문확인이 느리다" 하나뿐이다. 응답이 any-typed 라 타입체커도 못 잡는다.
 *
 * 실사고(2026-09-16): 2차 주문캠페인에 1차 판매캠페인 3건(완료·정산중)이 연결된 채 남아 있어
 * 주문확인이 캠페인 기간(9/10~) 대신 **6/12부터 97일**을 훑었다.
 *
 * `campaigns-handler.ts` 는 같은 계약을 `campaigns-handler.contract.test.ts` 가 이미 지킨다
 * (그쪽은 정산 락 동결 게이트라는 **다른 이유**로도 `status` 를 쓴다) — 중복 등재하지 않는다.
 */
const ROUTES_REQUIRING_STATUS = [
  'src/app/order-converter/api/campaigns/[id]/execute/route.ts',
  'src/app/order-converter/api/campaigns/[id]/execute/stream/route.ts',
];

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** 주석을 걷어낸 코드 줄만 남긴다 — 위 설명문이 자기 자신을 증거로 삼지 않게 한다. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('조회창 라우트의 salesCampaigns select 계약', () => {
  it.each(ROUTES_REQUIRING_STATUS)('%s 는 status 를 select 한다', (relativePath) => {
    const code = stripComments(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
    const selectBlock = code.match(/salesCampaigns:\s*\{\s*select:\s*\{([^}]*)\}/)?.[1];

    expect(selectBlock, `${relativePath} 에서 salesCampaigns select 블록을 찾지 못했다`).toBeDefined();
    expect(selectBlock).toMatch(/\bstatus:\s*true/);
    // 창 계산의 나머지 입력도 함께 고정한다 — 이 셋 중 하나만 빠져도 증상이 같다.
    expect(selectBlock).toMatch(/\bstartDate:\s*true/);
    expect(selectBlock).toMatch(/\bendDate:\s*true/);
  });

  it.each(ROUTES_REQUIRING_STATUS)('%s 는 실제로 조회창 SSOT 를 부른다', (relativePath) => {
    // 위 select 단언이 의미를 갖는 전제 — 이 라우트가 창 계산을 직접 손으로 하지 않고
    // SSOT 에 위임하고 있는가. 위임이 사라지면 select 만 지켜도 계약이 공허해진다.
    const code = stripComments(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
    expect(code).toMatch(/resolveCampaignQueryStartMs\s*\(/);
  });
});
