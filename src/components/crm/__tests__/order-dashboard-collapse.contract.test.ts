import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 계약: **주문관리 화면은 서버 원본 목록(`rawCampaigns`)을 직접 조회하지 않는다.**
 *
 * 서버는 정산까지 끝난 캠페인을 요약으로 접어 보내고(`settled-campaign-collapse`), 화면은 펼친
 * 것만 단건 조회로 받아 병합본 `campaigns` 를 만든다. 원본을 따로 쓸 수 있게 두면 **렌더는 펼친
 * 데이터를, 모달·조회는 접힌 요약을 보는** 상태가 된다.
 *
 * 그 어긋남은 전부 조용하다 — 리뷰에서 실제로 잡힌 경로가 이랬다: 정산종료 캠페인을 펼치면 카드는
 * 멀쩡히 뜨는데, 거기서 매출리포트를 열면 `dailyStats` 가 없어 **빈 그래프**가 그려지고(저장까지
 * 된다), 인사이트는 통째로 공백이고, 발송 모달은 `sellerName`·`toEmail` 이 비어 나간다. 서버
 * 응답이 any-typed JSON 이라 타입체커가 못 잡고, 화면은 오류 대신 빈 값을 보여줄 뿐이다.
 *
 * 그래서 처방은 규약이 아니라 **이름 덮어쓰기**다(병합본이 `campaigns` 를 차지한다). 이 테스트는
 * 그 구조가 유지되는지만 본다 — `rawCampaigns` 는 오직 병합 한 줄에서만 쓰여야 한다.
 */
const SOURCE_PATH = join(__dirname, '..', 'order-dashboard.tsx');

/** 주석을 걷어낸 코드 줄만 남긴다 — 위 설명문이 자기 자신을 위반으로 잡지 않게. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const CODE = stripComments(readFileSync(SOURCE_PATH, 'utf8'));

describe('주문관리 화면 — 접힌 캠페인 병합본 계약', () => {
  it('원본 목록은 병합 한 줄에서만 쓴다(구조조림 + 병합 = 2회)', () => {
    const uses = CODE.match(/\brawCampaigns\b/g) ?? [];
    expect(
      uses.length,
      `rawCampaigns 사용이 ${uses.length}회다 — 원본을 직접 보는 코드가 생기면 펼친 캠페인이 모달에서 빈 값으로 보인다`,
    ).toBe(2);
  });

  it('원본을 직접 조회·순회하지 않는다', () => {
    for (const forbidden of ['rawCampaigns.find', 'rawCampaigns.filter', 'rawCampaigns.some']) {
      expect(CODE, `${forbidden} 는 접힌 요약을 집는다 — 병합본 campaigns 를 쓸 것`).not.toContain(forbidden);
    }
  });

  it('병합본이 campaigns 라는 이름을 차지하고, 병합 규칙은 SSOT 에 위임한다', () => {
    // 규칙 자체(언제 사본을 끼우나)는 `settled-campaign-collapse` 가 갖는다 — 여기서 손으로
    // 다시 쓰면 "서버 최신본이 낡은 사본에 지는" GPT 검수 지적이 화면에서만 되살아난다.
    expect(CODE).toMatch(/const campaigns = mergeExpandedCampaignDetails\(rawCampaigns,/);
  });

  it('쓰기가 성공하면 펼친 사본을 버린다 — 저장 전 값이 되살아나지 않게', () => {
    // 접힌 채로 내용만 바뀌는 경우(설정 저장)는 병합 규칙만으로 못 거른다. 쓰기 4곳
    // (마감·마감취소·수정·삭제)이 사본을 버려야 한다.
    // 선언은 `forgetSettledDetail = (` 라 이 정규식에 안 걸린다 — 세는 것은 **호출**뿐이다.
    const evictions = CODE.match(/forgetSettledDetail\(/g) ?? [];
    expect(
      evictions.length,
      `forgetSettledDetail 호출이 ${evictions.length}회다 — 마감·마감취소·수정·삭제 4곳이어야 한다`,
    ).toBe(4);
  });

  it('조회는 병합본을 본다 — campaigns.find 가 살아 있다(양성 대조)', () => {
    // 위 금지 단언들이 "그 표현이 파일에 아예 없어서" 통과하는 것을 막는 대조군.
    // 모달들이 실제로 id 로 캠페인을 되찾는 경로가 존재해야 이 계약이 의미를 갖는다.
    expect(CODE).toContain('campaigns.find(');
  });
});
