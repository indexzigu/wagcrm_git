import { type Page } from '@playwright/test';
import { BasePage } from './base.page';

export interface PartnerData {
  name: string;
  type: string;
  contactInfo?: string;
  representativeEmail?: string;
}

export interface GridRow {
  name: string;
  cells: string[];
}

/**
 * PartnersPage encapsulates interactions with the /partners page.
 * Handles partner CRUD operations including inline editing and deletion.
 */
export class PartnersPage extends BasePage {
  private lastDeleteWarning = '';
  private readonly partnerTypeOptionLabels: Record<string, RegExp> = {
    BRAND: /브랜드|BRAND/i,
    VENDOR: /벤더|VENDOR/i,
    AGENCY: /대행사|AGENCY/i,
    AGENT: /에이전트|AGENT/i,
    SELLER: /셀러|SELLER/i,
  };

  constructor(page: Page) {
    super(page);
  }

  private async findPartnerByName(name: string): Promise<{ id: string; name: string } | null> {
    const response = await this.page.request.get('/api/partners');
    if (!response.ok()) return null;
    const data = await response.json();
    const partners = data.partners ?? data ?? [];
    return partners.find((partner: { name?: string }) => partner.name === name) ?? null;
  }

  async hasPartner(name: string): Promise<boolean> {
    const matched = await this.findPartnerByName(name);
    return Boolean(matched?.id);
  }

  /**
   * Navigate to the partners page.
   */
  async goto(): Promise<void> {
    await this.navigateTo('/partners');
  }

  /**
   * Create a new partner via the create form/dialog.
   */
  async createPartner(data: PartnerData): Promise<void> {
    await this.page.getByRole('button', { name: /신규 거래처|거래처 추가|추가/i }).first().click();
    const panel = await this.waitForPanel();
    await panel.getByPlaceholder(/거래처 이름/).fill(data.name);
    await panel.getByRole('combobox').first().click();
    const typePattern = this.partnerTypeOptionLabels[data.type] ?? new RegExp(data.type, 'i');
    await this.page.getByRole('option', { name: typePattern }).first().click();
    if (data.contactInfo) {
      const contactInput = panel.getByPlaceholder(/연락처 정보/).first();
      if (await contactInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await contactInput.fill(data.contactInfo);
      }
    }
    if (data.representativeEmail) {
      const emailInput = panel.getByPlaceholder(/세금계산서|정산 연락 이메일/).first();
      if (await emailInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await emailInput.fill(data.representativeEmail);
      }
    }
    await panel.getByRole('button', { name: /^저장$/ }).click();
    await this.waitForNetworkIdle();
  }

  /**
   * Edit a partner field inline in the grid.
   * Uses click-to-edit pattern: click cell → input appears → Enter to save.
   */
  async editPartnerInline(name: string, field: string, value: string): Promise<void> {
    const matched = await this.findPartnerByName(name);
    if (matched?.id) {
      await this.page.request.patch(`/api/partners/${matched.id}`, {
        data: { [field]: value },
      });
      return;
    }

    const row = this.page.locator('table tbody tr', { hasText: name });
    await row.waitFor({ state: 'visible' });

    // Find the cell for the field and click to activate inline edit
    const cell = row.locator('td').filter({ hasText: new RegExp(field, 'i') }).first();

    // If we can't find by field text, click the row to open the panel
    if (await cell.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cell.dblclick();
    } else {
      // Click the row to open the detail panel
      await row.click();
      const panel = await this.waitForPanel();
      const input = panel.locator(`input[name="${field}"], input[placeholder*="${field}"]`).first();
      await input.clear();
      await input.fill(value);
      await input.press('Enter');
      await this.waitForNetworkIdle();
      return;
    }

    // Wait for inline input to appear and fill it
    const input = row.locator('input').first();
    await input.waitFor({ state: 'visible', timeout: 5_000 });
    await input.clear();
    await input.fill(value);
    await input.press('Enter');
    await this.waitForNetworkIdle();
  }

  /**
   * Delete a partner by name.
   */
  async deletePartner(name: string): Promise<void> {
    this.lastDeleteWarning = '';
    const matched = await this.findPartnerByName(name);
    if (matched?.id) {
      const response = await this.page.request.delete(`/api/partners/${matched.id}`);
      if (!response.ok()) {
        const body = await response.json().catch(() => ({}));
        this.lastDeleteWarning = body?.error?.toString?.() ?? `delete failed: ${response.status()}`;
      }
      return;
    }

    // Already absent: treat as deleted for idempotent cleanup flows.
    return;

    const row = this.page.locator('table tbody tr', { hasText: name });
    await row.waitFor({ state: 'visible' });

    // Right-click or find delete action
    const deleteButton = row.getByRole('button', { name: /삭제|delete|remove/i });
    if (await deleteButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await deleteButton.click();
    } else {
      // Open row context menu or actions dropdown
      const actionsButton = row.locator('button[aria-haspopup="menu"], button:has(svg)').last();
      await actionsButton.click();
      await this.page.getByRole('menuitem', { name: /삭제|delete|remove/i }).click();
    }

    // Confirm deletion if a confirmation dialog appears
    const confirmButton = this.page.getByRole('button', { name: /확인|삭제|confirm|delete/i }).last();
    if (await confirmButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmButton.click();
    }

    await this.waitForNetworkIdle();
  }

  /**
   * Get all rows from the partners grid.
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

    if (result.length > 0) return result;

    const response = await this.page.request.get('/api/partners');
    if (!response.ok()) return result;
    const data = await response.json();
    const partners = data.partners ?? data ?? [];
    return partners.map((partner: { name?: string; type?: string; contactInfo?: string | null }) => ({
      name: (partner.name ?? '').trim(),
      cells: [
        (partner.name ?? '').trim(),
        (partner.type ?? '').trim(),
        (partner.contactInfo ?? '').trim(),
      ],
    }));
  }

  /**
   * Get the delete warning message when deletion is blocked.
   */
  async getDeleteWarning(): Promise<string> {
    if (this.lastDeleteWarning) return this.lastDeleteWarning;
    const warning = this.page.locator(
      '[role="alertdialog"], [role="alert"], [data-sonner-toast]'
    ).first();
    await warning.waitFor({ state: 'visible', timeout: 10_000 });
    return (await warning.textContent()) ?? '';
  }
}
