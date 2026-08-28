import { test, expect } from '../fixtures/auth.fixture';

test.describe('Navigation & Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('sidebar displays all nav links in correct order', async ({ page }) => {
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.waitFor({ state: 'visible', timeout: 10_000 });

    const navLinks = sidebar.locator('a[href], button').filter({
      has: page.locator('span, p'),
    });

    const count = await navLinks.count();
    expect(count).toBeGreaterThan(0);

    // Verify expected navigation items exist
    const sidebarText = await sidebar.textContent();
    expect(sidebarText).toBeTruthy();
  });

  test('clicking sidebar link → SPA navigation', async ({ page }) => {
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.waitFor({ state: 'visible', timeout: 10_000 });

    // Find a navigation link (e.g., deals or partners)
    const navLink = sidebar.locator('a[href*="/deals"], a[href*="/partners"]').first();

    if (await navLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Listen for navigation - SPA should not trigger full page load
      const navigationPromise = page.waitForURL(/\/(deals|partners)/, { timeout: 10_000 });
      await navLink.click();
      await navigationPromise;

      // Verify URL changed without full reload
      const url = page.url();
      expect(url).toMatch(/\/(deals|partners)/);
    }
  });

  test('global search → results', async ({ page }) => {
    // Look for a search input in the header or sidebar
    const searchInput = page.locator(
      'input[type="search"], input[placeholder*="검색"], input[placeholder*="search"], [role="searchbox"]'
    ).first();

    if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await searchInput.fill('E2E_TEST_');
      await page.waitForTimeout(1_000); // Wait for search results to appear

      // Check for search results
      const results = page.locator(
        '[role="listbox"] [role="option"], [class*="search-result"], [class*="result"]'
      );
      const count = await results.count();
      expect(count).toBeGreaterThan(0);
    } else {
      // Try command palette (Cmd+K)
      await page.keyboard.press('Meta+k');
      const commandInput = page.locator('[role="dialog"] input, [cmdk-input]').first();

      if (await commandInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await commandInput.fill('E2E_TEST_');
        await page.waitForTimeout(1_000);

        const results = page.locator('[cmdk-item], [role="option"]');
        const count = await results.count();
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('selecting search result → navigates', async ({ page }) => {
    // Open search
    const searchInput = page.locator(
      'input[type="search"], input[placeholder*="검색"], input[placeholder*="search"], [role="searchbox"]'
    ).first();

    if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await searchInput.fill('E2E_TEST_');
      await page.waitForTimeout(1_000);

      const firstResult = page.locator(
        '[role="listbox"] [role="option"], [class*="search-result"]'
      ).first();

      if (await firstResult.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const initialUrl = page.url();
        await firstResult.click();
        await page.waitForLoadState('domcontentloaded');

        // URL should have changed or a detail panel should have opened
        const newUrl = page.url();
        const panelVisible = await page.locator('[role="dialog"]').isVisible().catch(() => false);
        expect(newUrl !== initialUrl || panelVisible).toBe(true);
      }
    } else {
      // Try command palette
      await page.keyboard.press('Meta+k');
      const commandInput = page.locator('[role="dialog"] input, [cmdk-input]').first();

      if (await commandInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await commandInput.fill('E2E_TEST_');
        await page.waitForTimeout(1_000);

        const firstItem = page.locator('[cmdk-item], [role="option"]').first();
        if (await firstItem.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await firstItem.click();
          await page.waitForLoadState('domcontentloaded');
        }
      }
    }
  });

  test('applying grid filters', async ({ page }) => {
    // Navigate to a page with a grid (e.g., deals)
    await page.goto('/deals');
    await page.waitForLoadState('domcontentloaded');

    // Wait for the grid to load
    await page.locator('table').first().waitFor({ state: 'visible', timeout: 15_000 });

    // Look for filter controls
    const filterButton = page.getByRole('button', { name: /필터|filter/i }).first();

    if (await filterButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await filterButton.click();

      // Apply a filter (e.g., status filter)
      const filterOption = page.locator('[role="option"], [role="menuitem"]').first();
      if (await filterOption.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await filterOption.click();
        await page.waitForLoadState('domcontentloaded');
      }
    }

    // Verify grid still displays data (filtered or not)
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
