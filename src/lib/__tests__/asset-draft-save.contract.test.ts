import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * 채택분 저장 스키마의 계약 (C3 M4).
 *
 * 라우트의 zod 스키마와 **같은 정의를 여기 복제해 고정한다** — 라우트는 Prisma
 * 를 물고 있어 단위 테스트에서 임포트하면 DB 연결이 필요해진다. 스키마가 갈리면
 * 이 테스트가 의미를 잃으므로, 라우트를 고칠 때 여기도 함께 고쳐야 한다.
 *
 * 지키는 선:
 * - **BLOCK 은 저장 대상이 아니다** — 애초에 운영자에게 나가지 않는다(C3 §4-2).
 *   저장 시점에 BLOCK 을 받아주면 "내보내지 않은 것"이 이력에 남는 모순이 생긴다.
 * - 빈 본문 저장 금지 — 무엇을 보냈는지가 이 테이블의 존재 이유다.
 */

const createSchema = z.object({
  body: z.string().trim().min(1, "저장할 내용이 없습니다").max(20000),
  gateVerdict: z.enum(["PASS", "WARN"], {
    message: "게이트를 통과한 자료만 저장할 수 있습니다",
  }),
  claimIds: z.array(z.string()).max(50).optional(),
  proofCardIncluded: z.boolean().optional(),
  model: z.string().trim().max(100).optional().nullable(),
  kind: z.string().trim().max(40).optional(),
});

const valid = { body: "## 상품 요약\n내용", gateVerdict: "PASS" as const };

describe("asset-draft 저장 스키마", () => {
  it("최소 입력(본문 + 게이트 판정)으로 통과한다", () => {
    expect(createSchema.safeParse(valid).success).toBe(true);
  });

  it("WARN 도 저장한다 — 운영자가 판단해 내보낸 것이다", () => {
    expect(
      createSchema.safeParse({ ...valid, gateVerdict: "WARN" }).success,
    ).toBe(true);
  });

  it("BLOCK 은 거부한다 — 내보내지 않은 것이 이력에 남으면 모순이다", () => {
    const r = createSchema.safeParse({ ...valid, gateVerdict: "BLOCK" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe(
        "게이트를 통과한 자료만 저장할 수 있습니다",
      );
    }
  });

  it("빈 본문은 거부한다 — 무엇을 보냈는지가 이 기록의 존재 이유다", () => {
    for (const body of ["", "   "]) {
      const r = createSchema.safeParse({ ...valid, body });
      expect(r.success, `body=${JSON.stringify(body)}`).toBe(false);
    }
  });

  it("에러 메시지가 한국어다 — 운영자에게 영문이 노출되지 않게", () => {
    const r = createSchema.safeParse({ body: "", gateVerdict: "PASS" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe("저장할 내용이 없습니다");
    }
  });

  it("클레임 id 목록은 선택이고 상한이 있다", () => {
    expect(createSchema.safeParse({ ...valid, claimIds: [] }).success).toBe(
      true,
    );
    expect(
      createSchema.safeParse({ ...valid, claimIds: ["a", "b"] }).success,
    ).toBe(true);
    expect(
      createSchema.safeParse({
        ...valid,
        claimIds: Array.from({ length: 51 }, (_, i) => `c${i}`),
      }).success,
    ).toBe(false);
  });

  it("본문 상한을 넘기면 거부한다 (저장 비용 방어)", () => {
    expect(
      createSchema.safeParse({ ...valid, body: "x".repeat(20001) }).success,
    ).toBe(false);
  });
});
