import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 계약: 주문 카드의 진행 오버레이(발주 메일·엑셀 업로드 등 긴 작업 중 카드를 덮는 판)는
 * **블러 없는 완전 불투명 카드 면**(`bg-card`)이다.
 *
 * 콘텐츠 면을 불투명 헤어라인 질감으로 바꾸면서 종전 `bg-white/80 backdrop-blur-sm` 의 블러를 뺐다.
 * 블러가 없으면 반투명 판(예: `bg-card/90`) 아래로 카드 글자가 선명한 잔상으로 비쳐 진행 메시지와
 * 겹쳐 읽힌다. 작업 중 카드를 막는 판이라 비칠 이유가 없으므로 완전 불투명으로 둔다(디자인 검토 2026-10-21).
 * 누군가 블러를 되살리거나 불투명도를 낮추면 이 테스트가 깨진다.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'order-dashboard.tsx'), 'utf8');

function overlayClassTokens(): string[] {
  const anchor = SOURCE.indexOf('진행률 오버레이 UI');
  expect(anchor, '진행률 오버레이 앵커 주석을 찾지 못했다 — 오버레이 위치가 바뀌었다면 이 계약도 함께 고칠 것').toBeGreaterThan(-1);
  const match = SOURCE.slice(anchor).match(/className="([^"]*absolute inset-0[^"]*)"/);
  expect(match, '오버레이 className(absolute inset-0)을 찾지 못했다').not.toBeNull();
  return match![1].split(/\s+/).filter(Boolean);
}

describe('주문 카드 진행 오버레이 — 블러 없는 불투명 면', () => {
  it('완전 불투명 카드 면(bg-card)을 쓴다', () => {
    const bg = overlayClassTokens().find((t) => t.startsWith('bg-'));
    expect(bg, '오버레이 배경 클래스가 없다').toBeDefined();
    const m = bg!.match(/^bg-card(?:\/(\d+))?$/);
    expect(m, `오버레이 배경이 ${bg} 다 — bg-card 계열이어야 한다`).not.toBeNull();
    const opacity = m![1] === undefined ? 100 : Number(m![1]);
    expect(opacity, `오버레이 불투명도 ${opacity} — 블러가 없으니 100 미만이면 아래 글자가 비친다`).toBe(100);
  });

  it('backdrop-blur 를 쓰지 않는다', () => {
    expect(overlayClassTokens().filter((t) => t.includes('backdrop-blur'))).toEqual([]);
  });
});
