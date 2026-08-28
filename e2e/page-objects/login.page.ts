import { type Page } from '@playwright/test';
import { BasePage } from './base.page';

/**
 * LoginPage encapsulates interactions with the /login page.
 * Handles authentication flows including login, error display, and sign-out.
 */
export class LoginPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Log in with email and password via the dev login endpoint.
   * The WAG CRM uses Google OAuth in production but has a dev-login bypass.
   * For E2E tests, we authenticate via the Supabase Auth API directly.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async login(_email: string, _password: string): Promise<void> {
    await this.navigateTo('/login');

    // Use dev-login API directly to avoid coupling tests to login button markup.
    const response = await this.page.request.post('/api/auth/dev-login', {
      failOnStatusCode: false,
    });

    if (![200, 302].includes(response.status())) {
      throw new Error(`Dev login failed: ${response.status()}`);
    }

    await this.navigateTo('/');

    await this.page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
  }

  /**
   * Get the error message displayed on failed login.
   */
  async getErrorMessage(): Promise<string> {
    const errorEl = this.page.locator('[role="alert"], .text-destructive, [data-sonner-toast]').first();
    await errorEl.waitFor({ state: 'visible', timeout: 10_000 });
    return (await errorEl.textContent()) ?? '';
  }

  async hasCredentialForm(): Promise<boolean> {
    const emailInput = this.page.locator('input[type="email"], input[name="email"]');
    return emailInput.isVisible({ timeout: 1_000 }).catch(() => false);
  }

  /**
   * Check if the current page is the login page.
   */
  async isOnLoginPage(): Promise<boolean> {
    await this.page.waitForLoadState('domcontentloaded');
    return this.page.url().includes('/login');
  }

  /**
   * Click the sign-out action to terminate the session.
   * Sign-out is typically in the sidebar footer or user menu.
   */
  async clickSignOut(): Promise<void> {
    // Look for sign-out button in sidebar or user dropdown
    const signOutButton = this.page.getByRole('button', { name: /로그아웃|sign.?out|logout/i });

    if (await signOutButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await signOutButton.click();
    } else {
      // Try user menu first
      const userMenu = this.page.locator('[data-slot="sidebar"] button').last();
      await userMenu.click();
      await this.page.getByRole('menuitem', { name: /로그아웃|sign.?out|logout/i }).click();
    }

    await this.page.waitForURL('**/login', { timeout: 15_000 });
  }
}
