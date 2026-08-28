// 읽기 전용 dev 레인(`DB_READ_ONLY=1`)의 쓰기 차단 계약 (2026-07-31).
//
// 배경: 이 레포 `.env` 의 `DATABASE_URL` 은 프로덕션 Supabase 다(AGENTS.md P0). 로컬
// `npm run dev` 에서 저장 버튼 오조작 한 번이 곧 프로덕션 변경이고, 지금까지 그것을
// 막는 장치가 없었다. `npm run dev:ro` 가 그 레인을 가른다.
//
// 이 계약이 고정하는 것은 세 가지다:
//   ① 분류가 **화이트리스트**로 남는가 — 모르는 오퍼레이션은 차단돼야 한다. 블랙리스트로
//      퇴화하면 Prisma 가 새 쓰기 op 를 추가할 때 조용히 통과한다(6.x 의
//      `createManyAndReturn`·`updateManyAndReturn` 이 실제로 그렇게 늘었다).
//   ② 확장이 **읽기를 막지 않는가** — 음성 대조군. 가드가 "전부 차단"으로 퇴화하면
//      읽기 전용 레인 자체가 무용지물이 되고, 아무도 안 쓰게 된다.
//   ③ 생성 지점이 **세 갈래 모두**에 가드를 씌우는가 — 데모·sqlite·postgres 중 하나가
//      가드 없이 빠져나가면 그 레인만 조용히 무방비다.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  READ_ONLY_ENV_KEY,
  isReadOnlyMode,
  isReadOperation,
  readOnlyBlockMessage,
  readOnlyExtension,
} from "../db-read-only";

describe("읽기 전용 모드 판정", () => {
  const original = process.env[READ_ONLY_ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[READ_ONLY_ENV_KEY];
    else process.env[READ_ONLY_ENV_KEY] = original;
  });

  it("`1` 일 때만 켜진다", () => {
    expect(isReadOnlyMode({ [READ_ONLY_ENV_KEY]: "1" })).toBe(true);
  });

  // 미설정이 곧 "꺼짐"이어야 한다 — 여기서 fail-closed 로 뒤집으면 프로덕션 런타임과
  // 크론 전체가 쓰기를 잃는다(collect-mode 와 위험의 비대칭이 반대다).
  it("미설정·빈값·다른 값에서는 꺼진다", () => {
    expect(isReadOnlyMode({})).toBe(false);
    expect(isReadOnlyMode({ [READ_ONLY_ENV_KEY]: "" })).toBe(false);
    expect(isReadOnlyMode({ [READ_ONLY_ENV_KEY]: "true" })).toBe(false);
    expect(isReadOnlyMode({ [READ_ONLY_ENV_KEY]: "0" })).toBe(false);
  });
});

describe("오퍼레이션 분류", () => {
  it.each([
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "aggregate",
    "count",
    "groupBy",
  ])("읽기 op 는 통과한다: %s", (op) => {
    expect(isReadOperation(op)).toBe(true);
  });

  it.each([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "upsert",
    "delete",
    "deleteMany",
  ])("쓰기 op 는 차단된다: %s", (op) => {
    expect(isReadOperation(op)).toBe(false);
  });

  // raw 의 판정 기준은 이름이 아니라 용도다 — 조회는 통과, 실행은 차단.
  it("raw 는 조회만 통과한다", () => {
    expect(isReadOperation("$queryRaw")).toBe(true);
    expect(isReadOperation("$queryRawUnsafe")).toBe(true);
    expect(isReadOperation("$executeRaw")).toBe(false);
    expect(isReadOperation("$executeRawUnsafe")).toBe(false);
  });

  // Prisma 는 모델 op(`findMany`)와 raw op(`$queryRaw`)의 접두사 규약이 다르다.
  it("`$` 접두사 유무와 무관하게 같은 판정을 준다", () => {
    expect(isReadOperation("queryRaw")).toBe(isReadOperation("$queryRaw"));
    expect(isReadOperation("executeRaw")).toBe(isReadOperation("$executeRaw"));
  });

  // ① 화이트리스트 계약: 모르는 op 는 막는다. 이 단언이 깨졌다면 분류가
  //    블랙리스트로 뒤집힌 것이고, 그때부터 Prisma 의 신규 쓰기 op 가 조용히 샌다.
  it("모르는 오퍼레이션은 차단된다(화이트리스트 유지)", () => {
    expect(isReadOperation("someFutureWriteOperation")).toBe(false);
    expect(isReadOperation("")).toBe(false);
  });
});

describe("차단 문구", () => {
  it("무엇이 막혔고 어떻게 푸는지를 함께 말한다", () => {
    const message = readOnlyBlockMessage("update", "Seller");
    expect(message).toContain("Seller.update");
    expect(message).toContain(READ_ONLY_ENV_KEY);
    // 레인 전환 방법이 없으면 사용자는 가드를 "고장"으로 오인한다.
    expect(message).toContain("npm run dev");
  });

  it("모델 없는 raw op 도 문구가 성립한다", () => {
    expect(readOnlyBlockMessage("$executeRaw")).toContain("$executeRaw");
  });
});

describe("Prisma 확장 동작", () => {
  const handler = readOnlyExtension.query.$allOperations;

  it("쓰기 op 는 원본 쿼리에 도달하지 못한다", async () => {
    const query = vi.fn();
    await expect(
      handler({ model: "Seller", operation: "update", args: {}, query }),
    ).rejects.toThrow(/읽기 전용 모드/);
    expect(query).not.toHaveBeenCalled();
  });

  // ② 음성 대조군 — 읽기까지 막으면 이 레인은 아무도 안 쓴다.
  it("읽기 op 는 인자 그대로 원본 쿼리에 전달된다", async () => {
    const query = vi.fn().mockResolvedValue(["행"]);
    const args = { where: { id: "seller-1" } };
    await expect(
      handler({ model: "Seller", operation: "findMany", args, query }),
    ).resolves.toEqual(["행"]);
    expect(query).toHaveBeenCalledWith(args);
  });

  it("raw 실행은 모델이 없어도 차단된다", async () => {
    const query = vi.fn();
    await expect(
      handler({ operation: "$executeRaw", args: [], query }),
    ).rejects.toThrow(/읽기 전용 모드/);
    expect(query).not.toHaveBeenCalled();
  });
});

// ③ 생성 지점 계약 — 소스 스캔으로 고정한다. 런타임 검증으로 잡으려면 데모·sqlite·
//    postgres 세 환경을 각각 띄워야 하는데, 정작 놓치는 실패 모드는 "새 분기를 추가하며
//    래핑을 빠뜨리는 것"이라 구조를 보는 편이 정확하다.
describe("클라이언트 생성 지점", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/prisma-client.ts"),
    "utf8",
  );

  it("createPrismaClient 가 가드를 거쳐 반환한다", () => {
    expect(source).toMatch(/createPrismaClient[\s\S]{0,200}withReadOnlyGuard\(/);
  });

  it("가드가 세 갈래를 한 곳에서 감싼다(분기별 중복 래핑이 아니다)", () => {
    // 선언(`function withReadOnlyGuard(`)을 뺀 **호출**이 한 번뿐이어야 한다 —
    // 분기마다 각자 래핑하는 형태로 바뀌면 새 분기에서 누락이 난다.
    const calls = source.match(/(?<!function )withReadOnlyGuard\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});
