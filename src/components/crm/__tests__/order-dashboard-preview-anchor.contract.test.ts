import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 계약: **발주·송장 미리보기 표는 조회한 캠페인 카드 바로 아래에 붙는다.**
 *
 * 정산까지 끝난 캠페인을 한 줄 요약으로 접는 기능(`settled-campaign-collapse`)이 들어간 뒤,
 * 미리보기 표가 캠페인 목록 **맨 끝**에 고정돼 있어 방금 조회한 카드와 표 사이에 접힌 줄들이
 * 끼어들었다 — 눌러서 받은 데이터가 화면 밖으로 밀려나 "어디로 갔나"가 됐다(오너 신고).
 *
 * 이 계약이 고정하는 것은 셋이고, 셋 다 **깨져도 화면이 조용하다**:
 *
 * ① 표는 캠페인 목록과 **같은 배열** 안에서 렌더된다. 두 자리(앵커 카드 아래 / 목록 끝)를
 *    서로 다른 부모에서 따로 렌더하면 자리 이동이 언마운트·리마운트가 되어, 표 안에 있던
 *    포커스가 body 로 떨어지고 스크롤이 튄다. 오류는 나지 않는다.
 * ② 그 배열 안에서 **고정 key** 를 유지한다. key 가 없거나 자리마다 다르면 ①의 구조를
 *    지켜도 React 가 이동으로 처리하지 못한다.
 * ③ 앵커 판정은 **접힘 여부를 보지 않는다.** 접혔다는 이유로 표를 목록 끝으로 보내면
 *    오너가 신고한 바로 그 화면이 그대로 재현된다 — 폴백이 증상을 되살리면 폴백이 아니다.
 *
 * 그리고 위치용 앵커는 감사 로그 귀속용 `previewCampaign` 과 **분리돼 있어야** 한다. 두 탭이
 * 서로 다른 캠페인 데이터를 담을 수 있어, 합치면 '확정' 재등록 로그가 엉뚱한 캠페인에 붙는다.
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

describe('주문관리 화면 — 미리보기 표 앵커 계약', () => {
  it('표는 캠페인 목록과 같은 배열 안에서, 두 분기 **모두**에 자리를 갖는다', () => {
    // 목록을 배열로 펼쳐(flatMap) 카드와 표를 같은 형제로 두는 구조가 ①의 실체다.
    // ⚠️ 서식이 아니라 구조를 본다 — 리터럴 대조는 arrow-paren 설정·줄바꿈 하나에 거짓 빨강이 된다.
    expect(CODE, '목록을 flatMap 으로 펼치지 않으면 표를 카드 사이에 끼울 자리가 없다').toMatch(
      /campaigns\s*\.\s*flatMap\s*\(/,
    );

    // ⛔ 배치를 **개수로 세지 말 것** — 개수는 "어느 자리인가"를 구분하지 못한다. 접힌 줄 배치를
    // 지우고 엉뚱한 곳에 하나 끼워 넣어도 총계는 그대로라 초록이다(리뷰에서 잡힌 실제 공백).
    // 그래서 분기를 잘라 **그 안에** 자리가 있는지 본다.
    const listBody = CODE.slice(CODE.search(/campaigns\s*\.\s*flatMap\s*\(/));
    // ⚠️ 분기를 자를 때 **끝 경계를 반드시 잡는다.** 파일 끝까지 슬라이스하면 나중에 이 컴포넌트
    // 아무 데나 같은 호출이 생겼을 때 분기에서 자리를 지워도 초록이 된다(거짓 통과).
    const fallbackAt = listBody.indexOf('...(!isPreviewAnchored');
    expect(fallbackAt, '목록 끝 폴백을 찾지 못했다 — 분기 끝 경계를 잡을 수 없다').toBeGreaterThan(0);
    const flatMapBody = listBody.slice(0, fallbackAt);

    const expandedAt = flatMapBody.indexOf('<div key={camp.id}');
    const collapsedAt = flatMapBody.indexOf('if (isCollapsedCampaign(camp))');
    expect(collapsedAt, '접힘 분기를 찾지 못했다').toBeGreaterThanOrEqual(0);
    expect(expandedAt, '펼친 카드 분기를 찾지 못했다').toBeGreaterThan(collapsedAt);

    // 자리는 **그 줄/카드 아래**여야 한다 — 오너 지시의 핵심이 "밑으로"다. 분기 안에 있기만
    // 하면 통과시키면, 위로 올려도 계약이 초록이라 지시의 절반만 지켜진다.
    const collapsedBranch = flatMapBody.slice(collapsedAt, expandedAt);
    expect(
      collapsedBranch,
      '접힌 요약 줄 아래에 자리가 없다 — 접힌 캠페인을 조회하면 표가 목록 끝으로 밀려난다(신고된 증상)',
    ).toContain('anchorSlot(camp.id)');
    expect(
      collapsedBranch.indexOf('anchorSlot(camp.id)'),
      '자리가 접힌 줄보다 **위**에 있다 — 표가 줄 위로 올라간다',
    ).toBeGreaterThan(collapsedBranch.indexOf('/>,'));

    const expandedBranch = flatMapBody.slice(expandedAt);
    expect(expandedBranch, '펼친 카드 아래에 자리가 없다').toContain('anchorSlot(camp.id)');
    expect(
      expandedBranch.indexOf('anchorSlot(camp.id)'),
      '자리가 카드보다 **위**에 있다 — 표가 카드 위로 올라간다',
    ).toBeGreaterThan(expandedBranch.indexOf('</div>,'));

    // 목록 끝 폴백도 **같은 배열 안**이어야 한다(다른 부모로 나가면 자리 이동이 리마운트가 된다).
    expect(
      listBody.slice(fallbackAt),
      '목록 끝 폴백이 배열 밖으로 나갔다 — key 가 있어도 이동이 아니라 리마운트가 된다',
    ).toMatch(/!isPreviewAnchored\s*&&\s*dataPreviewPanel\s*\?\s*\[dataPreviewPanel\]\s*:\s*\[\]/);
  });

  it('앵커 자리의 조건은 한 곳이 소유한다 — 두 분기가 각자 적지 않는다', () => {
    expect(CODE, 'anchorSlot 선언이 없다').toMatch(/const anchorSlot = \(campaignId: string\)/);
    // 조건을 손으로 다시 적은 분기가 있으면, 앵커 규칙이 바뀔 때 한쪽만 고쳐져 조용히 갈린다.
    // ⚠️ **양방향으로 센다** — 비교 순서만 뒤집어 적으면(`camp.id === previewAnchorCampaignId`)
    // 한 방향 패턴은 조용히 초록이다. 이 단언이 막으려는 바로 그 중복이 그렇게 빠져나간다.
    const inlined = CODE.match(
      /(previewAnchorCampaignId\s*===\s*camp\.id|camp\.id\s*===\s*previewAnchorCampaignId)/g,
    ) ?? [];
    expect(
      inlined.length,
      `앵커 조건을 분기에서 직접 적은 곳이 ${inlined.length}곳이다 — anchorSlot 에 위임할 것`,
    ).toBe(0);
  });

  it('붙었을 때의 테두리는 섹션 경계 등급이다(P8 구분선 2단)', () => {
    // 카드 테두리(`border-slate-200`)를 그대로 두르면 틴트로 지운 "독립 박스" 인상이
    // 테두리에서 되살아난다 — 위치를 옮긴 목적이 절반만 전달된다.
    const anchoredVariant = CODE.match(/isPreviewAnchored\s*\n?\s*\?\s*'[^']*'/)?.[0] ?? '';
    expect(anchoredVariant, '앵커 변형의 className 분기를 찾지 못했다').not.toBe('');
    expect(anchoredVariant, '앵커 변형이 섹션 경계 등급을 쓰지 않는다').toContain(
      'border-slate-200/60',
    );
  });

  it('배열 안에서 고정 key 를 유지한다 — 자리 이동이 리마운트가 되지 않게', () => {
    expect(
      CODE,
      'dataPreviewPanel 루트에 고정 key 가 없다 — 자리를 옮길 때 포커스·스크롤이 날아간다',
    ).toMatch(/key="campaign-data-preview"/);
  });

  it('앵커 판정은 접힘 여부를 보지 않는다 — 접힌 줄 아래에도 붙는다', () => {
    const anchorDecision = CODE.match(/const isPreviewAnchored =[\s\S]*?;/)?.[0] ?? '';
    expect(anchorDecision, 'isPreviewAnchored 선언을 찾지 못했다').not.toBe('');
    expect(
      anchorDecision,
      '앵커 판정이 접힘 여부를 본다 — 접혔다고 목록 끝으로 보내면 신고된 화면이 재현된다',
    ).not.toContain('isCollapsedCampaign');
    // 양성 대조: 판정이 실제로 병합본 목록에서 캠페인을 찾고 있어야 위 금지가 의미를 갖는다.
    expect(anchorDecision).toContain('campaigns.some(');
  });

  it('위치용 앵커와 감사 로그 귀속은 다른 state 다', () => {
    expect(CODE).toMatch(/const \[previewAnchorCampaignId, setPreviewAnchorCampaignId\]/);
    // 감사 로그 귀속은 **송장 탭 소유자**가 계속 갖는다 — 앵커(위치)나 발주 탭 소유자로
    // 갈아끼우면 탭이 어긋날 때 '확정' 재등록이 다른 캠페인 이름으로 기록된다.
    expect(
      CODE,
      "'확정' 재등록 로그 귀속이 previewTrackingCampaign 에서 떨어져 나갔다",
    ).toMatch(/submitTrackingData\(previewTracking, \{[^}]*campaign: previewTrackingCampaign/);
  });

  it('탭마다 자기 캠페인을 따로 든다 — 두 탭은 서로 다른 캠페인 것일 수 있다', () => {
    // 하나로 합치면 한쪽 탭의 이름표가 반드시 거짓말이 된다(발주=A · 송장=B 인 상태가 실재한다).
    for (const owner of ['previewOrdersCampaign', 'previewTrackingCampaign']) {
      expect(CODE, `${owner} state 가 없다 — 탭 소속을 표시할 근거가 사라진다`).toMatch(
        new RegExp(`const \\[${owner}, set${owner[0].toUpperCase()}${owner.slice(1)}\\]`),
      );
    }
    // 두 생산 경로가 각자 자기 소유자를 채워야 이름표가 실제 데이터를 따라간다.
    expect(CODE, '발주 경로가 자기 탭 소유자를 기록하지 않는다').toContain(
      'setPreviewOrdersCampaign(',
    );
    expect(CODE, '송장 경로가 자기 탭 소유자를 기록하지 않는다').toContain(
      'setPreviewTrackingCampaign(',
    );
  });

  it('두 탭 모두 자기 소유자를 화면에 적는다', () => {
    // 한쪽만 적으면 어긋남이 비대칭으로 보여 오히려 오독을 부른다.
    const tabs = [...CODE.matchAll(/<PreviewTab[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(tabs.length, `PreviewTab 이 ${tabs.length}개다 — 발주·송장 2개여야 한다`).toBe(2);
    expect(tabs[0]).toContain('campaignName={previewOrdersCampaign?.name');
    expect(tabs[1]).toContain('campaignName={previewTrackingCampaign?.name');
  });

  it('소속 줄은 캠페인이 없어도 자리를 지킨다 — 탭바가 흔들리지 않게', () => {
    // 조건부로 마운트하면 한 탭만 이름을 가질 때 두 탭의 높이가 어긋난다(P8 Layout Stability ②).
    // ⚠️ 끝 경계를 `\n}` 로 잡으면 **구조분해 타입의 닫는 중괄호**(`}) {`)에서 먼저 끊긴다 —
    //    함수 본문을 한 줄도 못 본 채 통과·실패한다. 자기 줄에 홀로 선 `}` 까지 가야 한다.
    const tabComponent = CODE.match(/function PreviewTab\([\s\S]*?\n\}\n/)?.[0] ?? '';
    expect(tabComponent, 'PreviewTab 선언을 찾지 못했다').not.toBe('');
    expect(
      tabComponent,
      '소속 줄을 조건부로 렌더한다 — 없을 때도 자리를 채울 것(`?? \'—\'` 형태)',
    ).toMatch(/campaignName \?\? '—'/);
    expect(
      tabComponent,
      '긴 캠페인명을 잘라 쓰지 않는다 — 줄바꿈되면 탭 높이가 이름 길이에 따라 달라진다',
    ).toContain('truncate');
  });
});
