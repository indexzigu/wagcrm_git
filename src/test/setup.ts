import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Auto-cleanup after each test
afterEach(() => {
  cleanup();
});

// Polyfill ResizeObserver for jsdom (used by cmdk/radix)
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Polyfill pointer capture methods (used by radix-ui)
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

// Polyfill scrollIntoView (used by cmdk)
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Polyfill matchMedia for jsdom
Object.defineProperty(window, "innerWidth", {
  configurable: true,
  get() { return 1280; }
});
Object.defineProperty(window, "innerHeight", {
  configurable: true,
  get() { return 800; }
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

// Mock useIsMobile hook to always return false (desktop view) in test environment
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

// Mock next/cache methods to avoid store missing error in test environment
vi.mock("next/cache", () => ({
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
