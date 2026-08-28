/**
 * 접근 판정(`resolveAccess`)의 4갈래를 고정한다.
 * ⚠️ 상태·역할은 반드시 app_metadata 에서만 읽는다 — user_metadata 는 사용자 본인이
 * 쓸 수 있어 권한 상승 구멍이 된다.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_EMAILS, resolveAccess } from "@/lib/auth-allowlist";

const OWNER_EMAIL = DEFAULT_ADMIN_EMAILS[0];
const STAFF_EMAIL = "staff@example.com";

describe("resolveAccess", () => {
  it("오너 바닥은 metadata 가 무엇이든 approved + admin 이다", () => {
    const decision = resolveAccess(
      { status: "rejected", role: "operator" },
      OWNER_EMAIL,
    );
    expect(decision).toEqual({ approved: true, status: "approved", role: "admin" });
  });

  it("status 가 없으면 대기다", () => {
    const decision = resolveAccess({}, STAFF_EMAIL);
    expect(decision.approved).toBe(false);
    expect(decision.status).toBe("pending");
  });

  it("status 가 rejected 면 차단이다", () => {
    const decision = resolveAccess({ status: "rejected" }, STAFF_EMAIL);
    expect(decision.approved).toBe(false);
    expect(decision.status).toBe("rejected");
  });

  it("approved 면 통과하고 역할은 app_metadata.role 을 따른다", () => {
    const decision = resolveAccess(
      { status: "approved", role: "operator" },
      STAFF_EMAIL,
    );
    expect(decision).toEqual({ approved: true, status: "approved", role: "operator" });
  });

  it("approved 인데 role 이 없으면 operator 로 떨어진다(fail-closed)", () => {
    const decision = resolveAccess({ status: "approved" }, STAFF_EMAIL);
    expect(decision.role).toBe("operator");
  });

  it("중첩된 user_metadata 안의 승인 값은 읽지 않는다", () => {
    const decision = resolveAccess(
      { user_metadata: { status: "approved", role: "admin" } } as Record<string, unknown>,
      STAFF_EMAIL,
    );
    expect(decision.approved).toBe(false);
    expect(decision.status).toBe("pending");
  });

});
