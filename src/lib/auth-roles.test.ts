import { describe, expect, it } from "vitest";
import {
  isOperatorAllowedPath,
  OPERATOR_HOME,
  parseRole,
} from "./auth-roles";

describe("parseRole", () => {
  it("알려진 역할만 통과시킨다", () => {
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("operator")).toBe("operator");
  });

  it("모르는 값은 null — 임의 문자열이 역할로 승격되지 않는다", () => {
    // 대소문자 변형·오타·주입 시도가 조용히 admin 이 되면 안 된다(호출부가 폴백을 적용한다).
    for (const value of ["Admin", "ADMIN", "superuser", "", " admin", 1, null, undefined, {}]) {
      expect(parseRole(value)).toBeNull();
    }
  });
});

describe("isOperatorAllowedPath — 화이트리스트", () => {
  it("업로드 화면과 업로드 API 를 허용한다", () => {
    expect(isOperatorAllowedPath(OPERATOR_HOME)).toBe(true);
    expect(isOperatorAllowedPath("/api/kakao-uploads")).toBe(true);
  });

  it("로그인·로그아웃 흐름을 허용한다 (막으면 세션을 끝낼 수 없다)", () => {
    expect(isOperatorAllowedPath("/login")).toBe(true);
    expect(isOperatorAllowedPath("/auth/callback")).toBe(true);
    expect(isOperatorAllowedPath("/api/auth/signout")).toBe(true);
  });

  it("업무 화면·API 는 전부 막는다", () => {
    for (const path of [
      "/",
      "/pipeline",
      "/deals",
      "/sellers",
      "/partners",
      "/settlement",
      "/reports/pnl",
      "/settings/operations",
      "/assistant",
      "/order-converter",
      "/assets",
      "/api/sellers",
      "/api/partners",
      "/api/campaigns",
      "/api/settlements",
      "/api/chat-room-mappings/manage",
    ]) {
      expect(isOperatorAllowedPath(path), path).toBe(false);
    }
  });

  it("허용 경로의 접두사 확장으로 새 표면이 새지 않는다", () => {
    // `/assets/katalk` 은 정확 일치라 하위·형제 경로가 딸려 들어오지 않아야 한다.
    expect(isOperatorAllowedPath("/assets/katalk/export")).toBe(false);
    expect(isOperatorAllowedPath("/assets/katalk-admin")).toBe(false);
    // `/api/kakao-uploads` 도 마찬가지.
    expect(isOperatorAllowedPath("/api/kakao-uploads/all")).toBe(false);
    // 접두사 허용은 슬래시까지 포함해야 `/authx`·`/api/authz` 를 오매칭하지 않는다.
    expect(isOperatorAllowedPath("/authx")).toBe(false);
    expect(isOperatorAllowedPath("/api/authz/keys")).toBe(false);
  });

  it("OPERATOR_HOME 은 허용 목록 안에 있다 (리다이렉트 루프 방지)", () => {
    // 미들웨어가 막힌 경로를 OPERATOR_HOME 으로 되돌리므로, 여기가 막히면 무한 루프다.
    expect(isOperatorAllowedPath(OPERATOR_HOME)).toBe(true);
  });
});
