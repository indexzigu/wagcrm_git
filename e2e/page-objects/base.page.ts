import { type Page, type Locator } from '@playwright/test';

/**
 * BasePage provides shared utilities for all page objects.
 * Uses data-sonner-toast for toast messages and standard Playwright
 * waiting strategies for grid loading and network idle.
 */
export class BasePage {
  constructor(protected page: Page) {}

  /**
   * Navigate to a path and wait for the page to be ready.
   */
  async navigateTo(path: string): Promise<void> {
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  }

  /**
   * Wait for the data grid (table) to be visible on the page.
   */
  async waitForGrid(): Promise<void> {
    await this.page.locator('table').first().waitFor({ state: 'visible', timeout: 15_000 });
  }

  /**
   * Get the text content of the most recent toast notification (Sonner).
   */
  async getToastMessage(): Promise<string> {
    const toast = this.page.locator('[data-sonner-toast]').first();
    await toast.waitFor({ state: 'visible', timeout: 10_000 });
    return (await toast.textContent()) ?? '';
  }

  /**
   * Wait for all network requests to settle.
   */
  async waitForNetworkIdle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  }

  /**
   * Get the sidebar navigation element.
   */
  protected getSidebar(): Locator {
    return this.page.locator('[data-slot="sidebar"]');
  }

  /**
   * Click a button by its visible text.
   */
  protected async clickButton(text: string): Promise<void> {
    await this.page.getByRole('button', { name: text }).click();
  }

  /**
   * Wait for a Sheet/dialog panel to open.
   */
  protected async waitForPanel(): Promise<Locator> {
    const panel = this.page.locator('[role="dialog"]');
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    return panel;
  }

  /**
   * Fill an input field by its label text.
   */
  protected async fillField(label: string, value: string): Promise<void> {
    await this.page.getByLabel(label).fill(value);
  }

  /**
   * Select a value from a Select component by its label.
   */
  protected async selectOption(triggerText: string, optionText: string): Promise<void> {
    await this.page.getByRole('combobox', { name: triggerText }).click();
    await this.page.getByRole('option', { name: optionText }).click();
  }
}
