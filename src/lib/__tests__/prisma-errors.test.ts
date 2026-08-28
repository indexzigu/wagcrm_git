import { describe, expect, it } from "vitest";
import { isSerializationConflict, isUniqueViolation } from "@/lib/prisma-errors";

// Prisma 에러는 실제로는 PrismaClientKnownRequestError 인스턴스지만, 가드는
// sqlite/postgres 생성 클라이언트 차이 때문에 code 문자열만 본다 — 형태만 맞추면 충분하다.
function prismaError(code: string): Error {
  const error = new Error(`prisma error ${code}`);
  (error as Error & { code: string }).code = code;
  return error;
}

describe("isUniqueViolation (P2002)", () => {
  it("code가 P2002인 에러 객체를 참으로 판정한다", () => {
    expect(isUniqueViolation(prismaError("P2002"))).toBe(true);
    // Error 인스턴스가 아니어도 code만 맞으면 참(클라이언트 종류 비의존)
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
  });

  it("다른 Prisma 코드는 거짓이다", () => {
    expect(isUniqueViolation(prismaError("P2034"))).toBe(false);
    expect(isUniqueViolation(prismaError("P2025"))).toBe(false);
  });

  it("code 없는 에러·원시값·null은 거짓이다(런타임 안전)", () => {
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation("P2002")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation({ code: 2002 })).toBe(false);
  });
});

describe("isSerializationConflict (P2034)", () => {
  it("code가 P2034인 에러 객체를 참으로 판정한다", () => {
    expect(isSerializationConflict(prismaError("P2034"))).toBe(true);
  });

  it("P2002·code 없음·null은 거짓이다", () => {
    expect(isSerializationConflict(prismaError("P2002"))).toBe(false);
    expect(isSerializationConflict(new Error("plain"))).toBe(false);
    expect(isSerializationConflict(null)).toBe(false);
  });
});
