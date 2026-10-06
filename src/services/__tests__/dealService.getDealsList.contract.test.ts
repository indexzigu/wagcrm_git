import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// T-234 — 딜 목록 API(`GET /api/deals` → dealService.getDealsList)의 select 가 딜 그리드가
// 그리는 열을 빠뜨려, SSR 캐시로 그린 첫 화면에는 보이다가 `useDeals` 재조회 순간
// 총수수료·정가·하한가 등이 빈 값으로 바뀌는 값 유실이 있었다. tsc 는
// `mapDealResponse(deal: Record<string, unknown>)` 캐스트 뒤라 이 드리프트를 못 보므로
// 여기서 두 쪽을 기계로 묶는다:
//   ① getDealsList 가 Prisma 에 넘기는 select 에 소비처가 읽는 키가 전부 `true` 로 있고
//      (중첩 `partner.*`·`_count.*` 는 `select.<부모>.select.<자식>` 까지)
//   ② 그 키 목록은 손으로 적은 사본이 아니라 소비처 소스(`useDeals.ts`)를 TypeScript AST 로
//      읽어 파생한다(정규식은 `deal?.x`·주석 속 `deal.foo` 를 잘못 세고 조용히 좁아진다).
// 같은 페이로드를 읽는 다른 소비처(`price-sheet-detail.tsx`·`partners-panel.tsx`)는 현재
// select 안의 키만 쓰므로 범위 밖 — 그쪽이 새 키를 읽기 시작하면 이 계약을 넓힌다.

const findManyMock = vi.fn();

vi.mock("@/repositories/dealRepository", () => ({
  dealRepository: {
    findMany: (...args: unknown[]) => findManyMock(...args),
  },
}));

vi.mock("@/lib/activity-log", () => ({
  recordActivityCreate: vi.fn(),
  recordActivityChange: vi.fn(),
  recordActivityDelete: vi.fn(),
  FIELD_LABELS: {},
  getCompareValue: vi.fn(),
}));

vi.mock("@/lib/asset-storage", () => ({
  googleDriveProvider: { createFolderForEntity: vi.fn() },
}));

import { dealService } from "../dealService";

type ConsumedKeys = { scalar: Set<string>; nested: Map<string, Set<string>> };

/** 괄호·as·non-null 을 벗겨 실제 표현식으로. `(deal.partner as X)?.name` 의 바깥을 뚫는다. */
function unwrap(n: ts.Expression): ts.Expression {
  let cur = n;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

/** `mapDealResponse` 본문에서 매개변수 `deal` 로부터 읽는 키를 AST 로 뽑는다. */
function readConsumedDealKeys(): ConsumedKeys {
  const file = resolve(__dirname, "../../hooks/useDeals.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fn: ts.FunctionDeclaration | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "mapDealResponse") fn = n;
  });
  expect(fn, "useDeals.ts 에 mapDealResponse 함수 선언이 있어야 한다").toBeDefined();
  const param = fn!.parameters[0]?.name;
  expect(param && ts.isIdentifier(param) ? param.text : null).toBe("deal");

  const scalar = new Set<string>();
  const nested = new Map<string, Set<string>>();
  const walk = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n)) {
      const base = unwrap(n.expression);
      if (ts.isIdentifier(base) && base.text === "deal") {
        scalar.add(n.name.text);
      } else if (ts.isPropertyAccessExpression(base)) {
        // `deal.costPrice?.toString?.()` 처럼 호출 대상인 멤버는 데이터 키가 아니다.
        const isCallee = ts.isCallExpression(n.parent) && n.parent.expression === n;
        const root = unwrap(base.expression);
        if (!isCallee && ts.isIdentifier(root) && root.text === "deal") {
          const set = nested.get(base.name.text) ?? new Set<string>();
          set.add(n.name.text);
          nested.set(base.name.text, set);
        }
      }
    }
    n.forEachChild(walk);
  };
  fn!.body?.forEachChild(walk);
  return { scalar, nested };
}

describe("dealService.getDealsList — select 가 그리드 소비 키를 전부 싣는다 (T-234)", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findManyMock.mockResolvedValue([]);
  });

  it("useDeals.mapDealResponse 가 읽는 모든 키(중첩 포함)가 select 에 true 로 있다", async () => {
    await dealService.getDealsList({});
    expect(findManyMock).toHaveBeenCalledTimes(1);
    const select = findManyMock.mock.calls[0][0].select as Record<string, unknown>;

    const { scalar, nested } = readConsumedDealKeys();
    // 양성 대조: 파서가 소비처를 못 읽으면 집합이 비어 "드리프트 0" 으로 보인다 — 실결함이던
    // 키와 중첩 두 가지가 실제로 잡혔는지 먼저 확인한다.
    expect(scalar.has("totalCommissionRate")).toBe(true);
    expect(nested.get("partner")?.has("name")).toBe(true);
    expect(nested.get("_count")?.has("campaigns")).toBe(true);
    expect(scalar.size).toBeGreaterThanOrEqual(15);

    const missingScalar = [...scalar].filter((k) => {
      const v = select[k];
      // 중첩 관계 필드(partner·_count)는 `{ select: {...} }` 객체로 들어간다.
      return !(v === true || (typeof v === "object" && v !== null && "select" in v));
    });
    expect(missingScalar).toEqual([]);

    const missingNested: string[] = [];
    for (const [parent, children] of nested) {
      const sub = (select[parent] as { select?: Record<string, unknown> } | undefined)?.select ?? {};
      for (const child of children) if (sub[child] !== true) missingNested.push(`${parent}.${child}`);
    }
    expect(missingNested).toEqual([]);
  });
});
