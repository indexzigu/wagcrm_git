import { test as base, expect, type Page } from '@playwright/test';

/**
 * Extended test fixture that provides an authenticated page.
 * storageState is already loaded via playwright.config.ts,
 * so all tests automatically have an authenticated session.
 */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, runAuthenticatedPage) => {
    // storageState already loaded via config — page is authenticated
    await runAuthenticatedPage(page);
  },
});

export { expect };
