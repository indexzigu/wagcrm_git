import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * 주문 → 캠페인 메인 품목 귀속 술어의 **단일 진실** 계약(T-276).
 *
 * 같은 판정(캠페인명·상품번호 → 매핑 폴백 + 상품번호 가드 + 이웃 양보)이 다섯 곳에 복사돼 있었고,
 * 상품번호 가드(#255) 하나를 넣는 데도 다섯 곳을 각각 고쳐야 했다. 그 사이 사본들은 이미 갈라져
 * 있었다 — 발주서·미발송은 매핑을 「글자 포함 · 상품/옵션 중 하나만 맞아도 인정」으로, 모바일은
 * 옵션명 완전일치 우선 규칙과 이웃 양보의 판매기간 조건 없이 봤다.
 *
 * 이 파일이 고정하는 것:
 * - **C1** 소비처는 전부 `resolveMainOrderAttribution`(또는 그것을 감싼 `collectCampaignAttributedOrders`)을
 *   **호출**한다.
 * - **C2** 술어의 부품(`pickBestMapping` · `orderProvesOtherProduct` · `orderBelongsToPeerCampaign`)을
 *   `campaign-match.ts`·`mapping-match.ts` 밖에서 직접 부르지 않는다 — 부품을 다시 조립하는 순간
 *   사본이 생긴다.
 * - **C3** 스캐너 자체가 살아 있다(양성·음성 대조) — 고장 난 스캐너가 초록을 내지 않게.
 *
 * 판정은 정규식이 아니라 TypeScript AST 의 **호출 노드**로 한다 — 이 파일과 소비처 주석에 금지 이름이
 * 설명으로 인용돼 있어 문자열로 세면 자기 자신을 잡는다.
 */

const SRC = join(__dirname, '..', '..', '..');

const SSOT_CALLEES = new Set(['resolveMainOrderAttribution', 'collectCampaignAttributedOrders']);
const PART_CALLEES = ['pickBestMapping', 'orderProvesOtherProduct', 'orderBelongsToPeerCampaign'];
const PART_OWNERS = new Set(['lib/order-converter/campaign-match.ts', 'lib/order-converter/mapping-match.ts']);

const CONSUMERS = [
  'app/order-converter/api/campaigns/campaigns-handler.ts', // 주문 관리 카드
  'lib/order-converter/order-work-summary.ts', // 홈 「오늘 처리할 주문」
  'lib/order-converter/closed-campaign-cache.ts', // 마감 집계(매출 보고 동결본)
  'lib/mobile-pulse-data.ts', // 모바일·매출 상세·일별 집계(attributeOrders)
  'lib/order-converter/purchase-order-rows.ts', // 발주서
  'lib/order-converter/undispatched-orders.ts', // 미발송(발송지연 안내) 목록
];

/** 소스에서 호출되는 함수 이름(식별자 또는 `a.b` 의 b) 목록 — 주석·문자열은 보지 않는다. */
function calledNames(source: string, fileName = 'probe.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.push(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.push(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** import 로 들여오는 원래 이름(`a as b` 의 a) — 별칭으로 호출 스캔을 피하는 경로를 막는다. */
function importedNames(source: string, fileName = 'probe.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
    }
  }
  return names;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const rel = (full: string) => relative(SRC, full).split(sep).join('/');

describe('C3 스캐너 대조군', () => {
  it('호출 노드는 잡는다(양성)', () => {
    expect(calledNames('const r = pickBestMapping(ms, p, o);')).toContain('pickBestMapping');
    expect(calledNames('x.orderProvesOtherProduct(o, id)')).toContain('orderProvesOtherProduct');
  });

  it('별칭 import 도 원래 이름으로 잡는다(양성)', () => {
    expect(importedNames("import { pickBestMapping as pbm } from './mapping-match';")).toContain('pickBestMapping');
  });

  it('주석·문자열·import 는 호출로 세지 않는다(음성)', () => {
    const src = [
      "import { pickBestMapping } from './mapping-match';",
      '// pickBestMapping(ms, p, o) 를 여기서 부르지 말 것',
      "const note = 'orderBelongsToPeerCampaign(...)';",
    ].join('\n');
    expect(calledNames(src)).not.toContain('pickBestMapping');
    expect(calledNames(src)).not.toContain('orderBelongsToPeerCampaign');
  });

  it('스캔 대상이 실제로 존재한다(빈 목록이 초록을 내지 않게)', () => {
    const files = listSourceFiles(SRC).map(rel);
    expect(files.length).toBeGreaterThan(100);
    for (const c of CONSUMERS) expect(files).toContain(c);
    for (const owner of PART_OWNERS) expect(files).toContain(owner);
  });
});

describe('C1 소비처는 SSOT 술어를 호출한다', () => {
  it.each(CONSUMERS)('%s', (file) => {
    const names = calledNames(readFileSync(join(SRC, file), 'utf8'), file);
    expect(names.some((n) => SSOT_CALLEES.has(n))).toBe(true);
  });
});

describe('C2 술어 부품을 SSOT 밖에서 다시 조립하지 않는다', () => {
  it('campaign-match·mapping-match 밖의 소스에 부품 호출·import 0건', () => {
    const offenders: string[] = [];
    for (const full of listSourceFiles(SRC)) {
      const file = rel(full);
      if (PART_OWNERS.has(file)) continue;
      const source = readFileSync(full, 'utf8');
      const called = calledNames(source, file);
      const imported = importedNames(source, file);
      for (const part of PART_CALLEES) {
        if (called.includes(part)) offenders.push(`${file} → ${part}()`);
        if (imported.includes(part)) offenders.push(`${file} → import ${part}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
