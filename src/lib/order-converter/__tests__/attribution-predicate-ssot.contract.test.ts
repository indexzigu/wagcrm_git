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
 * - **C4** 이웃 판정·창 겹침 감지의 집계창(`windowStartMs/EndMs`)을 소비처에서 `resolveSaleWindowStartMs/EndMs`
 *   로 직접 조립하지 않는다 — campaign-match `resolveCampaignWindowMs`(기준 `live`/`stored`)를 쓴다. 같은 조립이
 *   다섯 곳에 있었고 창 기준이 화면마다 갈렸다(주문 관리 카드는 이웃 순번에 따라 저장 창·라이브 창이 섞였다).
 *   모바일 집계(`mobile-pulse-data`)는 판매캠페인 행에서 창을 만들어 이 규칙의 대상이 아니다(입력이 다르다).
 *
 * 판정은 정규식이 아니라 TypeScript AST 의 **호출 노드**로 한다 — 이 파일과 소비처 주석에 금지 이름이
 * 설명으로 인용돼 있어 문자열로 세면 자기 자신을 잡는다.
 */

const SRC = join(__dirname, '..', '..', '..');

const SSOT_CALLEES = new Set(['resolveMainOrderAttribution', 'collectCampaignAttributedOrders']);
const PART_CALLEES = ['pickBestMapping', 'orderProvesOtherProduct', 'orderBelongsToPeerCampaign'];
const PART_OWNERS = new Set(['lib/order-converter/campaign-match.ts', 'lib/order-converter/mapping-match.ts']);

/** 집계창 조립식의 주인 — `windowStartMs: resolveSaleWindowStartMs(…)` 꼴이 허용되는 곳. */
const WINDOW_OWNERS = new Set(['lib/order-converter/campaign-match.ts', 'lib/order-converter/sale-window.ts']);
const WINDOW_PROPS = new Set(['windowStartMs', 'windowEndMs']);
const WINDOW_CALLEES = new Set(['resolveSaleWindowStartMs', 'resolveSaleWindowEndMs']);

const CONSUMERS = [
  'app/order-converter/api/campaigns/campaigns-handler.ts', // 주문 관리 카드
  'lib/order-converter/order-work-summary.ts', // 홈 「오늘 처리할 주문」
  'lib/order-converter/closed-campaign-cache.ts', // 마감 집계(매출 보고 동결본)
  'lib/mobile-pulse-data.ts', // 모바일·매출 상세·일별 집계(attributeOrders)
  'lib/order-converter/purchase-order-rows.ts', // 발주서
  'lib/order-converter/undispatched-orders.ts', // 미발송(발송지연 안내) 목록
];

const parse = (source: string, fileName: string) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

/** 소스에서 호출되는 함수 이름(식별자 또는 `a.b` 의 b) 목록 — 주석·문자열은 보지 않는다. */
function calledNames(source: string | ts.SourceFile, fileName = 'probe.ts'): string[] {
  const sf = typeof source === 'string' ? parse(source, fileName) : source;
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
function importedNames(source: string | ts.SourceFile, fileName = 'probe.ts'): string[] {
  const sf = typeof source === 'string' ? parse(source, fileName) : source;
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

/**
 * 객체 리터럴에서 `windowStartMs/EndMs` 속성 값 **식 안에서** `resolveSaleWindowStartMs/EndMs` 를 호출하는 곳
 * (`속성명 ← 호출명`). `x ?? 호출`·삼항·`as`·괄호·따옴표 키도 잡는다. 단축 속성·스프레드·지역 변수 경유는
 * 세지 않는다 — 막으려는 것은 조립식의 복사다.
 */
function handAssembledWindows(source: string | ts.SourceFile, fileName = 'probe.ts'): string[] {
  const sf = typeof source === 'string' ? parse(source, fileName) : source;
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    const key =
      ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : null;
    if (key && WINDOW_PROPS.has(key)) {
      const findCalls = (n: ts.Node) => {
        const name = ts.isCallExpression(n) ? calleeName(n) : null;
        if (name && WINDOW_CALLEES.has(name)) hits.push(`${key} ← ${name}`);
        ts.forEachChild(n, findCalls);
      };
      findCalls((node as ts.PropertyAssignment).initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** 스캔 대상 소스를 한 번만 읽고 한 번만 파싱한다 — C2·C4 가 공유(종전엔 파일마다 두 번 파싱해 전체 실행 부하에서 5초를 넘겼다). */
let parsedSources: Array<{ file: string; sf: ts.SourceFile }> | null = null;
function scanSources(): Array<{ file: string; sf: ts.SourceFile }> {
  parsedSources ??= listSourceFiles(SRC).map((full) => {
    const file = rel(full);
    return { file, sf: parse(readFileSync(full, 'utf8'), file) };
  });
  return parsedSources;
}

/** 소스 전체 스캔의 시간 한도 — 단독 실행은 2초 안팎이지만 `npm test` 전체 병렬 부하에서 5초 기본값을 넘긴 적이 있다. */
const FULL_SCAN_TIMEOUT_MS = 60_000;

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
    for (const { file, sf } of scanSources()) {
      if (PART_OWNERS.has(file)) continue;
      const called = calledNames(sf);
      const imported = importedNames(sf);
      for (const part of PART_CALLEES) {
        if (called.includes(part)) offenders.push(`${file} → ${part}()`);
        if (imported.includes(part)) offenders.push(`${file} → import ${part}`);
      }
    }
    expect(offenders).toEqual([]);
  }, FULL_SCAN_TIMEOUT_MS);
});

describe('C4 집계창을 소비처에서 손으로 조립하지 않는다', () => {
  it('스캐너 대조군 — 직접 호출은 잡고, 헬퍼 스프레드·지역 변수·무관한 windowStartMs 는 세지 않는다', () => {
    expect(handAssembledWindows('const p = { name: n, windowStartMs: resolveSaleWindowStartMs(c), windowEndMs: sw.resolveSaleWindowEndMs(c) };')).toEqual([
      'windowStartMs ← resolveSaleWindowStartMs',
      'windowEndMs ← resolveSaleWindowEndMs',
    ]);
    // 감싼 꼴도 잡는다(리뷰 지적: 직접 호출만 보면 `?? 호출`·삼항·따옴표 키가 빠져나간다).
    expect(
      handAssembledWindows(
        "const p = { windowStartMs: x ?? resolveSaleWindowStartMs(c), 'windowEndMs': ok ? (resolveSaleWindowEndMs(c) as number) : null };",
      ),
    ).toEqual(['windowStartMs ← resolveSaleWindowStartMs', 'windowEndMs ← resolveSaleWindowEndMs']);
    const allowed = [
      "const p = { id, ...resolveCampaignWindowMs(c, 'live') };",
      'const s = resolveSaleWindowStartMs(c); const d = { windowStartMs: s };',
      'const rate = { windowStartMs: nowMs, count: 1 };',
      '// windowStartMs: resolveSaleWindowStartMs(c) 를 여기서 쓰지 말 것',
    ].join('\n');
    expect(handAssembledWindows(allowed)).toEqual([]);
  });

  it('조립식의 주인이 실제로 그 꼴을 갖고 있다(양성 — 스캐너가 실코퍼스에서도 발화한다)', () => {
    const owner = scanSources().find((s) => s.file === 'lib/order-converter/campaign-match.ts');
    expect(owner).toBeDefined();
    expect(handAssembledWindows(owner!.sf).length).toBeGreaterThan(0);
  }, FULL_SCAN_TIMEOUT_MS);

  it('주인 밖의 소스에 0건', () => {
    const offenders = scanSources()
      .filter(({ file }) => !WINDOW_OWNERS.has(file))
      .flatMap(({ file, sf }) => handAssembledWindows(sf).map((hit) => `${file} → ${hit}`));
    expect(offenders).toEqual([]);
  }, FULL_SCAN_TIMEOUT_MS);
});
