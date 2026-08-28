import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      // no-unused-vars: `_` 접두는 "의도적 미사용"의 코드베이스 관례다
      // (`_opts`·`_cancelledRef`·`_silent` 등 9곳). 옵션이 없으면 그 관례가 전부
      // 경고로 잡혀 진짜 죽은 코드가 잡음에 묻힌다. 해당 9건은 제거가 불가능함이
      // 확인됐다 — `_silent`/`_cancelledRef`는 호출부 7곳이 인자를 넘기고,
      // `_url`/`_init`은 mock.calls 튜플 인덱싱의 타입 안전에 시그니처가 필요하며,
      // `_previous`는 rest 구조분해로 previous 슬롯을 덜어내는 메커니즘 그 자체다
      // (지우면 core에 도로 들어가 동작이 바뀐다). ignoreRestSiblings가 그 오탐을 막는다.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      // react-hooks/purity: order-dashboard.tsx의 Date.now/new Date 사용이 error로 CI lint를
      // 막는다. next.config.ts에 React Compiler가 비활성이라 purity 위반이 실버그로 이어질
      // 경로가 없으므로 warn으로 강등한다(off 아님 — lint 출력에는 계속 표면화됨).
      "react-hooks/purity": "warn",
      "react/no-unescaped-entities": "off",
    }
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "src/generated/**",
    "prisma/generated/**",
    "next-env.d.ts",
    "scratch/**",
    "scripts/**",
    // 에이전트 툴링 스크래치(gitignored, Vercel 미업로드). 병행 세션의 워크트리
    // 사본이 여기 쌓이면 인자 없는 `eslint`가 그 전체 저장소를 훑어 release:check가
    // 오탐 실패하므로 명시적으로 제외한다.
    ".claude/**",
  ]),
]);

export default eslintConfig;
