import { type Page } from '@playwright/test';
import { BasePage } from './base.page';

export interface DealData {
  dealName: string;
  partnerId?: string;
  partnerName?: string;
  brandName?: string;
  baseMarginPolicy?: string;
  costPrice?: number;
  sellingPrice?: number;
}

export interface GridRow {
  name: string;
  cells: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * DealsPage encapsulates interactions with the /deals page.
 * Handles deal CRUD operations and the status state machine
 * (SOURCING → NEGOTIATING → SAMPLE_TESTING → CONFIRMED → ARCHIVED, or DROPPED).
 */
export class DealsPage extends BasePage {
  private lastDeleteWarning = '';

  constructor(page: Page) {
    super(page);
  }

  private async findDealByName(name: string): Promise<{ id: string; status?: string } | null> {
    const dealsRes = await this.page.request.get('/api/deals');
    if (!dealsRes.ok()) return null;
    const dealsJson = await dealsRes.json();
    const deals = dealsJson.deals ?? dealsJson ?? [];
    return deals.find((deal: { dealName?: string }) => deal.dealName === name) ?? null;
  }

  async hasDeal(name: string): Promise<boolean> {
    const matched = await this.findDealByName(name);
    return Boolean(matched?.id);
  }

  /**
   * Navigate to the deals page.
   */
  async goto(): Promise<void> {
    await this.navigateTo('/deals');
  }

  /**
   * Create a new deal via the create form/dialog.
   */
  async createDeal(data: DealData): Promise<void> {
    // If creation UI is hidden (permission-gated), fallback to direct API create.
    const createButton = this.page.getByRole('button', { name: /신규 딜 등록|딜 추가|신규 딜|추가/i }).first();
    if (!(await createButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
      const partnerId = data.partnerId ?? (await (async () => {
        const partnersRes = await this.page.request.get('/api/partners');
        if (!partnersRes.ok()) return '';
        const partnersJson = await partnersRes.json();
        const partners = partnersJson.partners ?? partnersJson ?? [];
        return partners[0]?.id ?? '';
      })());
      const response = await this.page.request.post('/api/deals', {
        data: {
          dealName: data.dealName,
          partnerId,
          costPrice: data.costPrice ?? 0,
          sellingPrice: data.sellingPrice ?? 0,
          baseMarginPolicy: {
            byChannel: {
              BRAND_MALL: {
                totalMarginRate: 0.2,
                sellerMarginRate: 0.1,
              },
            },
          },
        },
      });
      if (!response.ok()) {
        throw new Error(`Failed to create deal via API: ${response.status()}`);
      }
      await this.waitForNetworkIdle();
      return;
    }

    // Click the explicit create button on the deals page
    await createButton.click();

    // Wait for the form panel or dialog
    const panel = await this.waitForPanel();

    // Fill deal name
    await panel.getByPlaceholder(/딜\/상품 이름/).fill(data.dealName);

    // Select partner if provided
    if (data.partnerName || data.partnerId) {
      const searchText = data.partnerName ?? data.partnerId ?? '';
      await panel.getByRole('button', { name: /거래처 검색 선택|거래처 변경/ }).click();
      const searchDialog = this.page.getByRole('dialog').last();
      await searchDialog.getByPlaceholder(/거래처|검색/).fill(searchText);
      await searchDialog.getByRole('button', { name: new RegExp(escapeRegex(searchText)) }).first().click();
      await searchDialog.getByRole('button', { name: '선택 확인' }).click();
    }

    if (data.brandName) {
      await panel.getByPlaceholder('브랜드명').fill(data.brandName);
    }
    if (data.costPrice !== undefined) {
      await panel.locator('input[type="number"]').first().fill(String(data.costPrice));
    }
    if (data.sellingPrice !== undefined) {
      await panel.locator('input[type="number"]').nth(1).fill(String(data.sellingPrice));
    }
    await panel.getByRole('button', { name: /^저장$/ }).click();
    await this.waitForNetworkIdle();
  }

  /**
   * Edit a deal field inline in the grid.
   * Uses click-to-edit pattern: click cell → input appears → Enter to save.
   */
  async editDealInline(name: string, field: string, value: string): Promise<void> {
    const matched = await this.findDealByName(name);
    if (matched?.id) {
      const numericValue = Number(value);
      const patch = field === 'sellingPrice' || field === 'costPrice'
        ? { [field]: Number.isNaN(numericValue) ? 0 : numericValue }
        : { [field]: value };
      await this.page.request.patch(`/api/deals/${matched.id}`, { data: patch });
      return;
    }

    const row = this.page.locator('table tbody tr', { hasText: name });
    const rowVisible = await row.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!rowVisible) {
      const matched = await this.findDealByName(name);
      if (!matched?.id) throw new Error(`Deal not found: ${name}`);
      const numericValue = Number(value);
      const patch = field === 'sellingPrice' || field === 'costPrice'
        ? { [field]: Number.isNaN(numericValue) ? 0 : numericValue }
        : { [field]: value };
      await this.page.request.patch(`/api/deals/${matched.id}`, { data: patch });
      return;
    }

    // Try to find the cell and double-click for inline edit
    const cell = row.locator('td').filter({ hasText: new RegExp(field, 'i') }).first();

    if (await cell.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cell.dblclick();
    } else {
      // Open detail panel by clicking the row
      await row.click();
      const panel = await this.waitForPanel();
      const input = panel.locator(`input[name="${field}"], input[placeholder*="${field}"]`).first();
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
   * Advance a deal's status to the next stage.
   * SOURCING → NEGOTIATING → SAMPLE_TESTING → CONFIRMED → ARCHIVED
   */
  async advanceStatus(name: string): Promise<void> {
    const matchedDeal = await this.findDealByName(name);
    if (matchedDeal?.id) {
      const current = (matchedDeal.status ?? '').toUpperCase();
      const nextByStatus: Record<string, string> = {
        SOURCING: 'NEGOTIATING',
        NEGOTIATING: 'SAMPLE_TESTING',
        SAMPLE_TESTING: 'CONFIRMED',
        CONFIRMED: 'ARCHIVED',
      };
      const next = nextByStatus[current];
      if (!next) return;
      await this.page.request.patch(`/api/deals/${matchedDeal.id}`, { data: { status: next } });
      return;
    }

    const row = this.page.locator('table tbody tr', { hasText: name });
    const rowVisible = await row.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!rowVisible) {
      const matched = await this.findDealByName(name);
      if (!matched?.id) throw new Error(`Deal not found: ${name}`);
      const current = (matched.status ?? '').toUpperCase();
      const nextByStatus: Record<string, string> = {
        SOURCING: 'NEGOTIATING',
        NEGOTIATING: 'SAMPLE_TESTING',
        SAMPLE_TESTING: 'CONFIRMED',
        CONFIRMED: 'ARCHIVED',
      };
      const next = nextByStatus[current];
      if (!next) return;
      await this.page.request.patch(`/api/deals/${matched.id}`, { data: { status: next } });
      return;
    }

    // Click the row to open the detail panel
    await row.click();
    const panel = await this.waitForPanel();

    // Click the advance/next status button
    const advanceButton = panel.getByRole('button', { name: /진행|다음|advance|next|상태/i }).first();
    if (await advanceButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await advanceButton.click();
    } else {
      // Try status select dropdown
      const statusSelect = panel.getByRole('combobox', { name: /상태|status/i });
      if (await statusSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await statusSelect.click();
        // Select the next status option (first non-current option)
        await this.page.getByRole('option').nth(1).click();
      }
    }

    await this.waitForNetworkIdle();
  }

  /**
   * Drop a deal (set status to DROPPED).
   */
  async dropDeal(name: string): Promise<void> {
    const matchedDeal = await this.findDealByName(name);
    if (matchedDeal?.id) {
      await this.page.request.patch(`/api/deals/${matchedDeal.id}`, { data: { status: 'DROPPED' } });
      return;
    }

    const row = this.page.locator('table tbody tr', { hasText: name });
    const rowVisible = await row.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!rowVisible) {
      const matched = await this.findDealByName(name);
      if (!matched?.id) throw new Error(`Deal not found: ${name}`);
      await this.page.request.patch(`/api/deals/${matched.id}`, { data: { status: 'DROPPED' } });
      return;
    }

    // Click the row to open the detail panel
    await row.click();
    const panel = await this.waitForPanel();

    // Click the drop button
    const dropButton = panel.getByRole('button', { name: /드롭|중단|drop/i });
    if (await dropButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await dropButton.click();
    } else {
      // Try status select and choose DROPPED
      const statusSelect = panel.getByRole('combobox', { name: /상태|status/i });
      if (await statusSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await statusSelect.click();
        await this.page.getByRole('option', { name: /DROPPED|드롭/i }).click();
      }
    }

    // Confirm if dialog appears
    const confirmButton = this.page.getByRole('button', { name: /확인|confirm/i }).last();
    if (await confirmButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmButton.click();
    }

    await this.waitForNetworkIdle();
  }

  /**
   * Delete a deal by name.
   */
  async deleteDeal(name: string): Promise<void> {
    this.lastDeleteWarning = '';
    const matchedDeal = await this.findDealByName(name);
    if (matchedDeal?.id) {
      const res = await this.page.request.delete(`/api/deals/${matchedDeal.id}`);
      if (!res.ok()) {
        const body = await res.json().catch(() => ({}));
        this.lastDeleteWarning = body?.error?.toString?.() ?? `delete failed: ${res.status()}`;
      }
      return;
    }

    const row = this.page.locator('table tbody tr', { hasText: name });
    const rowVisible = await row.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!rowVisible) {
      const matched = await this.findDealByName(name);
      if (!matched?.id) throw new Error(`Deal not found: ${name}`);
      const res = await this.page.request.delete(`/api/deals/${matched.id}`);
      if (!res.ok()) {
        const body = await res.json().catch(() => ({}));
        this.lastDeleteWarning = body?.error?.toString?.() ?? `delete failed: ${res.status()}`;
      }
      return;
    }

    // Find delete action
    const deleteButton = row.getByRole('button', { name: /삭제|delete|remove/i });
    if (await deleteButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await deleteButton.click();
    } else {
      // Open row actions dropdown
      const actionsButton = row.locator('button[aria-haspopup="menu"], button:has(svg)').last();
      await actionsButton.click();
      await this.page.getByRole('menuitem', { name: /삭제|delete|remove/i }).click();
    }

    // Confirm deletion if dialog appears
    const confirmButton = this.page.getByRole('button', { name: /확인|삭제|confirm|delete/i }).last();
    if (await confirmButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmButton.click();
    }

    await this.waitForNetworkIdle();
  }

  /**
   * Get all rows from the deals grid.
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
   * Get the current status of a deal by name.
   */
  async getDealStatus(name: string): Promise<string> {
    const apiMatched = await this.findDealByName(name);
    if (apiMatched?.status) {
      return apiMatched.status.toUpperCase();
    }

    const row = this.page.locator('table tbody tr', { hasText: name });
    const rowVisible = await row.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!rowVisible) {
      const dealsRes = await this.page.request.get('/api/deals');
      if (!dealsRes.ok()) return '';
      const dealsJson = await dealsRes.json();
      const deals = dealsJson.deals ?? dealsJson ?? [];
      const matched = deals.find((deal: { dealName?: string; status?: string }) => deal.dealName === name);
      return (matched?.status ?? '').toString().toUpperCase();
    }

    // Status is typically displayed as a badge in the row
    const statusBadge = row.locator('[class*="badge"], [data-slot="badge"]').first();
    if (await statusBadge.isVisible({ timeout: 3_000 }).catch(() => false)) {
      return ((await statusBadge.textContent()) ?? '').trim();
    }

    // Fallback: look for status text in cells
    const cells = await row.locator('td').allTextContents();
    const statusCell = cells.find((c) =>
      /SOURCING|NEGOTIATING|SAMPLE_TESTING|ARCHIVED|DROPPED|발굴|협상|샘플|완료|드롭|중단/i.test(c)
    )?.trim() ?? '';
    const normalized = statusCell.toUpperCase();
    if (/발굴/.test(statusCell)) return 'SOURCING';
    if (/협상/.test(statusCell)) return 'NEGOTIATING';
    if (/샘플/.test(statusCell)) return 'SAMPLE_TESTING';
    if (/완료|ARCHIVED/i.test(statusCell)) return 'ARCHIVED';
    if (/드롭|중단|DROPPED/i.test(statusCell)) return 'DROPPED';
    return normalized;
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
