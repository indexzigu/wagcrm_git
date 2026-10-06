/**
 * 실효 역할 해석(`resolveUserRole`) — 이 프로젝트에서 가장 되돌리기 쉬운 지점이다.
 * 종전 기본값이 `"admin"` 이라, 허가목록에 이메일 하나를 추가하는 것이 곧 전체 권한
 * 부여였다. 여기 단언들은 그 기본값이 되살아나는지를 감시한다.
 *
 * ⚠️ 인자는 **`app_metadata.role`**(service_role 만 쓸 수 있는 필드)이다.
 * `user_metadata` 를 넘기는 호출부가 생기면 사용자가 스스로 admin 이 된다 —
 * 호출부 감시는 `middleware-role-gate.test.ts` 의 자기 승격 차단 단언이 담당한다.
 * ⚠️ 이메일로 admin 을 주는 경로는 없다(2026-10-06 — 공개 레포에 이메일을 두지 않는다).
 */
import { describe, expect, it } from "vitest";
import { resolveUserRole } from "@/lib/auth-allowlist";

describe("resolveUserRole — 기본값", () => {
  it("역할 미지정 계정은 operator 다 (fail-closed)", () => {
    // ⛔ 여기가 "admin" 으로 바뀌면 승인만 된 계정이 곧바로 전체 권한을 얻는다.
    expect(resolveUserRole(undefined)).toBe("operator");
    expect(resolveUserRole(null)).toBe("operator");
  });
});

describe("resolveUserRole — 명시 지정과 이상값", () => {
  it("app_metadata.role 이 유효하면 그것을 쓴다", () => {
    expect(resolveUserRole("operator")).toBe("operator");
    expect(resolveUserRole("admin")).toBe("admin");
  });

  it("알 수 없는 역할 값은 무시하고 operator 로 떨어진다", () => {
    expect(resolveUserRole("superuser")).toBe("operator");
    expect(resolveUserRole("Admin")).toBe("operator");
    expect(resolveUserRole({ role: "admin" })).toBe("operator");
  });
});
