import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SUPPLEMENT_PRODUCT_CLASS } from '../product-class';

/**
 * 추가구성상품 판정은 `product-class.ts` **한 곳**에만 있어야 한다.
 *
 * **왜 계약인가:** 이 술어는 주문 귀속의 분기점이라 집계 표면마다 필요한데, 종전에는 7곳에
 * 손으로 복사돼 있었다. 사본이 갈려도 **타입도 테스트도 잡지 못하고**, 실패가 조용하다 —
 * 라인이 메인으로 오분류되면 매칭에 실패해 집계에서 사라질 뿐 오류가 나지 않는다.
 * `INVALID_ORDER_STATUSES` 가 오타 하나로 전 지표를 부풀린 것과 같은 부류다(P7).
 *
 * **왜 AST 인가:** 이 레포의 소스 스캔 계약은 정규식으로 반복해 뚫렸다. 여기서는 특히
 * ①주석 속 인용(이 SSOT 의 설명 주석이 리터럴을 인용한다 — 정규식이면 자기 자신을 위반으로
 * 잡는다)과 ②유니코드 이스케이프(`'추가…'`)가 문제인데, `StringLiteral.text` 는
 * 주석을 애초에 노드로 갖지 않고 이스케이프를 해석한 값을 주므로 둘 다 구조적으로 막힌다.
 */

const SSOT = 'src/lib/order-converter/product-class.ts';

/** 판정을 소비하는 집계·발주 표면. 되돌아가면 그 자리만 조용히 갈린다. */
const CONSUMERS = [
  'src/app/order-converter/api/campaigns/campaigns-handler.ts',
  'src/app/order-converter/api/campaigns/[id]/execute/route.ts',
  'src/app/order-converter/api/campaigns/[id]/execute/stream/route.ts',
  'src/lib/mobile-pulse-data.ts',
  'src/lib/order-converter/closed-campaign-cache.ts',
  'src/lib/order-converter/campaign-orders.ts',
  'src/lib/order-converter/undispatched-orders.ts',
] as const;

/** `src` 아래 타입스크립트 소스 전수(레포 관행: 셸이 아니라 readdirSync 재귀). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (rel.endsWith('.ts') || rel.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

/**
 * 테스트 파일은 스캔에서 뺀다 — 픽스처의 리터럴은 **판정이 아니라 데이터**다
 * ("네이버가 이 값을 준다"의 재현). SSOT 상수로 바꾸면 동어반복 테스트가 된다.
 */
function isTestFile(rel: string): boolean {
  return rel.includes('/__tests__/') || rel.endsWith('.test.ts') || rel.endsWith('.test.tsx');
}

/**
 * 이 파일이 추가구성상품 문자열 리터럴을 들고 있는가.
 *
 * 템플릿 리터럴(치환 없는 것)까지 보는 이유: `` `추가구성상품` `` 로 적으면 형태만 바꿔
 * 같은 사본이 부활한다. NFC 로 맞춰 비교하므로 NFD 로 적은 리터럴도 걸린다.
 */
function parse(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    readFileSync(join(process.cwd(), rel), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

/**
 * 이 파일이 `isSupplementProduct(...)` 를 **호출**하는가.
 *
 * 🪤 `source.includes('isSupplementProduct')` 로 재면 안 된다 — 호출부를 리터럴 비교로
 * 되돌려도 `import` 줄이 남아 초록이다(변이 테스트로 실측). 재려는 것은 "이름이 파일에
 * 있다"가 아니라 "판정을 거친다"이므로 호출 노드를 센다.
 */
function callsSsotPredicate(rel: string): boolean {
  const source = parse(rel);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'isSupplementProduct') {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function supplementLiterals(rel: string): string[] {
  const source = parse(rel);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text.normalize('NFC') === SUPPLEMENT_PRODUCT_CLASS) {
        hits.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('추가구성상품 판정 단일화', () => {
  it('SSOT 자신은 리터럴을 갖는다 — 스캐너가 고장 나면 이 단언이 먼저 깨진다', () => {
    // 🪤 「없음」 단언만 두면 스캐너가 죽어도 초록이다(레포 선례 다수). 이 양성 프로브가
    //    깨지는 순간 아래 "0건"은 근거가 아니라 침묵이라는 뜻이다.
    expect(supplementLiterals(SSOT).length).toBeGreaterThan(0);
  });

  it('스캐너는 유니코드 이스케이프로 우회한 리터럴도 잡는다', () => {
    // 정규식 프리필터가 이 형태에 뚫린 레포 선례가 있다. AST 는 해석된 값을 보므로 걸린다.
    const escaped = ts.createSourceFile(
      'probe.ts',
      "const x = '\\uCD94\\uAC00\\uAD6C\\uC131\\uC0C1\\uD488';",
      ts.ScriptTarget.Latest,
      true,
    );
    let found = false;
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && node.text.normalize('NFC') === SUPPLEMENT_PRODUCT_CLASS) found = true;
      ts.forEachChild(node, visit);
    };
    visit(escaped);
    expect(found).toBe(true);
  });

  it('제품 코드 어디에도 SSOT 밖의 추가구성상품 리터럴이 없다', () => {
    const strays = sourceFiles('src')
      .filter((rel) => rel !== SSOT && !isTestFile(rel))
      .flatMap(supplementLiterals);
    expect(strays).toEqual([]);
  });

  it('집계·발주 표면은 SSOT 판정을 거친다', () => {
    // 리터럴 스캔은 "사본이 없다"만 말한다 — 소비처가 판정을 **자기 방식으로 다시 짜는**
    // 경우(예: productClass 를 다른 값으로 비교)는 그 스캔에 안 걸리므로 따로 고정한다.
    const missing = CONSUMERS.filter((rel) => !callsSsotPredicate(rel));
    expect(missing).toEqual([]);
  });

  it('SSOT 리터럴은 NFC 로 커밋돼 있다 — NFD 로 저장되면 판정이 통째로 뒤집힌다', () => {
    const raw = readFileSync(join(process.cwd(), SSOT), 'utf8');
    expect(raw).toBe(raw.normalize('NFC'));
  });
});
