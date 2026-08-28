/**
 * 전 테스트 공통 setup.
 *
 * ⚠️ **이 파일은 `node` 환경에서도 로드된다.** 2026-08-28 부터 기본 환경이 `node` 이고,
 * DOM 이 필요한 파일만 `// @vitest-environment jsdom` 을 선언한다(사유·실측은
 * `vitest.config.ts` 주석). 그래서 여기서 DOM 전역(`Element`·`window`)을 **무조건**
 * 만지면 node 환경 테스트가 전부 죽는다 — 실제로 종전 18행 `Element.prototype` 이
 * `ReferenceError: Element is not defined` 로 모든 파일을 넘어뜨렸다.
 *
 * ⇒ DOM 손질은 `hasDom` 가드 안에서만 한다. `vi.mock` 은 호이스팅되므로 조건 안에
 * 넣을 수 없고, 환경과 무관하므로 최상위에 그대로 둔다.
 */
import { afterEach, vi } from "vitest";

// 환경과 무관한 모듈 모킹 — 호이스팅되므로 조건 안에 넣지 말 것.
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

// next/cache 는 테스트 환경에 store 가 없어 호출 시 던진다.
vi.mock("next/cache", () => ({
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

const hasDom = typeof window !== "undefined" && typeof Element !== "undefined";

if (hasDom) {
  // ⚠️ 동적 import 다 — 정적 import 면 node 환경에서도 모듈이 평가돼
  // `@testing-library/jest-dom` 이 DOM 전역을 건드리며 죽는다.
  const [{ cleanup }] = await Promise.all([
    import("@testing-library/react"),
    import("@testing-library/jest-dom/vitest"),
  ]);

  afterEach(() => {
    cleanup();
  });

  // ResizeObserver 폴리필 (cmdk/radix 가 쓴다)
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // 포인터 캡처 폴리필 (radix-ui)
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }

  // scrollIntoView 폴리필 (cmdk)
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  // 뷰포트를 데스크톱으로 고정한다 — 모바일 분기가 환경에 따라 흔들리지 않게.
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    get() {
      return 1280;
    },
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    get() {
      return 800;
    },
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
