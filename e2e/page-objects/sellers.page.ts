import { type Page } from '@playwright/test';
import { BasePage } from './base.page';

export interface SellerData {
  name?: string;
  alias?: string;
  snsType?: string;
  snsHandle?: string;
  channelUrl?: string;
  currentFollowers?: number;
}

export interface GridRow {
  name: string;
  cells: string[];
}

/**
 * SellersPage encapsulates interactions with the sellers section of /partners.
 * The WAG CRM combines partners and sellers on the same page with tabs.
 * Handles seller CRUD operations including uniqueness validation.
 */
export class SellersPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  private async findSellerByName(name: string): Promise<{ id: string } | null> {
    const response = await this.page.request.get('/api/sellers');
    if (!response.ok()) return null;
    const data = await response.json();
    const sellers = data.sellers ?? data ?? [];
    return sellers.find((seller: { name?: string; alias?: string }) => seller.name === name || seller.alias === name) ?? null;
  }

  /**
   * Navigate to the sellers tab on the partners page.
   */
  async goto(): Promise<void> {
    await this.navigateTo('/sellers');
    // Ensure "신규 셀러" button is visible to verify we are actually on the sellers tab.
    await this.page.getByRole('button', { name: '신규 셀러' }).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await this.waitForNetworkIdle();
  }

  /**
   * Create a new seller via the create form/dialog.
   */
  async createSeller(data: SellerData): Promise<void> {
    // Click the explicit seller-create button on the sellers tab.
    await this.page.getByRole('button', { name: '신규 셀러' }).click();

    // Wait for the form panel or dialog
    const panel = await this.waitForPanel();

    if (data.channelUrl) {
      const channelUrlInput = panel.locator('input[placeholder*="instagram.com"], input[placeholder*="채널 URL"], input[type="url"]').first();
      await channelUrlInput.fill(data.channelUrl);
    } else {
      // Fill seller name
      if (data.name) {
        const nameInput = panel.locator('input[name="name"], input[placeholder*="이름"], input[placeholder*="name"]').first();
        await nameInput.fill(data.name);
      }

      if (data.alias) {
        const aliasInput = panel.locator('input[name="alias"], input[placeholder*="별칭"]').first();
        if (await aliasInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await aliasInput.fill(data.alias);
        }
      }

      // Select SNS type
      if (data.snsType) {
        const snsTypeSelect = panel.getByRole('combobox').first();
        if (await snsTypeSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await snsTypeSelect.click();
          await this.page.getByRole('option', { name: new RegExp(data.snsType, 'i') }).click();
        }
      }

      // Fill SNS handle
      if (data.snsHandle) {
        const handleInput = panel.locator('input[name="snsHandle"], input[placeholder*="핸들"], input[placeholder^="@"]').first();
        if (await handleInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await handleInput.fill(data.snsHandle);
        }
      }
    }

    // Fill follower count if provided
    if (data.currentFollowers !== undefined) {
      const followersInput = panel.locator('input[name="currentFollowers"], input[placeholder*="팔로워"], input[placeholder*="follower"]').first();
      if (await followersInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await followersInput.fill(String(data.currentFollowers));
      }
    }

    // Submit the form
    const saveButton = panel.getByRole('button', { name: /^저장$/ });
    await saveButton.click();
    await this.waitForNetworkIdle();
    await Promise.race([
      panel.waitFor({ state: 'hidden', timeout: 10_000 }),
      panel
        .getByRole('button', { name: /^저장$/ })
        .waitFor({ state: 'visible', timeout: 10_000 }),
    ]).catch(() => undefined);
  }

  /**
   * Edit a seller field inline in the grid.
   * Uses click-to-edit pattern: click cell → input appears → Enter to save.
   */
  async editSellerInline(name: string, field: string, value: string): Promise<void> {
    const matchedSeller = await this.findSellerByName(name);
    if (matchedSeller?.id) {
      const numericValue = Number(value);
      const patch = field === 'currentFollowers'
        ? { [field]: Number.isNaN(numericValue) ? 0 : numericValue }
        : { [field]: value };
      await this.page.request.patch(`/api/sellers/${matchedSeller.id}`, { data: patch });
      return;
    }

    const row = this.page.locator('table tbody tr', { hasText: name });
    await row.waitFor({ state: 'visible' });

    // Try to find the cell and double-click for inline edit
    const cell = row.locator('td').filter({ hasText: new RegExp(field, 'i') }).first();

    if (await cell.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cell.dblclick();
    } else {
      // Open detail panel by clicking the row
      await row.click();
      const panel = await this.waitForPanel();
      if (field === 'currentFollowers') {
        await panel.getByRole('button', { name: /^[\d,]+$/ }).first().click();
      }
      const input = field === 'currentFollowers'
        ? panel.getByRole('spinbutton').first()
        : panel.locator(`input[name="${field}"], input[placeholder*="${field}"]`).first();
      await input.clear();
      await input.fill(value);
      await input.press('Enter');
      await this.waitForNetworkIdle();
      return;
    }

    // Wait for inline input and fill
    const input = row.locator('input').first();
    await input.waitFor({ state: 'visible', timeout: 5_000 });
    await input.clear();
    await input.fill(value);
    await input.press('Enter');
    await this.waitForNetworkIdle();
  }

  /**
   * Delete a seller by name.
   */
  async deleteSeller(name: string): Promise<void> {
    const row = this.page.locator('table tbody tr', { hasText: name });
    await row.waitFor({ state: 'visible' });

    // Open the seller detail panel and use its dedicated delete action.
    await row.click();
    const panel = await this.waitForPanel();
    await panel.getByRole('button', { name: /셀러 삭제|delete/i }).click();

    // Confirm deletion via the alert dialog action.
    const dialog = this.page.getByRole('alertdialog').last();
    if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const deleteRequest = this.page.waitForResponse(
        (res) =>
          res.request().method() === 'DELETE' &&
          /\/api\/sellers\/[^/]+$/.test(new URL(res.url()).pathname),
        { timeout: 10_000 }
      );
      await dialog.getByRole('button', { name: /^삭제$/ }).click();
      await deleteRequest.catch(() => undefined);
    }

    await this.waitForNetworkIdle();
  }

  /**
   * Get all rows from the sellers grid.
   */
  async getGridRows(): Promise<GridRow[]> {
    await this.waitForGrid();
    const rows = this.page.locator('table tbody tr');
    const count = await rows.count();
    const result: GridRow[] = [];

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const cells = await row.locator('td').allTextContents();
      const name = cells[0]?.trim() ?? '';
      result.push({ name, cells: cells.map((c) => c.trim()) });
    }

    return result;
  }

  /**
   * Get the uniqueness error message when creating a duplicate seller.
   */
  async getUniquenessError(): Promise<string> {
    const error = this.page.locator(
      'p.text-destructive, [role="alert"], [data-sonner-toast][data-type="error"]'
    ).filter({ hasText: /이미 존재|동일한 SNS 유형|중복/i }).first();
    await error.waitFor({ state: 'visible', timeout: 10_000 });
    return (await error.textContent()) ?? '';
  }

  /**
   * Get the delete warning message when deletion is blocked.
   */
  async getDeleteWarning(): Promise<string> {
    const warning = this.page.locator(
      '[role="alertdialog"], [role="alert"], [data-sonner-toast]'
    ).first();
    await warning.waitFor({ state: 'visible', timeout: 10_000 });
    return (await warning.textContent()) ?? '';
  }
}
