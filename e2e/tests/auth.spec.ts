import { test, expect } from '../fixtures/auth.fixture';
import { LoginPage } from '../page-objects/login.page';

test.describe('Authentication', () => {
  test.describe.configure({ mode: 'serial' });

  test('unauthenticated user is redirected to /login', async ({ page }) => {
    const loginPage = new LoginPage(page);

    await page.context().clearCookies();
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await page.goto('/');
    await page.waitForURL('**/login', { timeout: 15_000 });

    expect(await loginPage.isOnLoginPage()).toBe(true);
  });

  test('valid credentials → login success → redirect to dashboard', async ({ page }) => {
    const loginPage = new LoginPage(page);

    const email = process.env.E2E_TEST_EMAIL ?? 'test@example.com';
    const password = process.env.E2E_TEST_PASSWORD ?? 'password123';

    await loginPage.login(email, password);

    // Should be redirected to dashboard after successful login
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });

  test('login page exposes current auth entry points only', async ({ page }) => {
    const loginPage = new LoginPage(page);

    await page.context().clearCookies();
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    expect(await loginPage.isOnLoginPage()).toBe(true);
    await expect(page.getByRole('button', { name: /^Google 계정으로 로그인$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^개발 모드로 바로 진입$/ })).toBeVisible();
    await expect.poll(() => loginPage.hasCredentialForm()).toBe(false);
  });

  test('sign-out → session terminated → redirect to /login', async ({ page }) => {
    const loginPage = new LoginPage(page);

    // Start on dashboard (authenticated via storageState)
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Click sign out
    await loginPage.clickSignOut();

    // Should be redirected to login page
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    expect(await loginPage.isOnLoginPage()).toBe(true);
  });
});
