import { type Page } from '@playwright/test';
import { BasePage } from './base.page';

export interface SettlementRow {
  cells: string[];
}

/**
 * ReportsPage encapsulates interactions with the /reports/settlement page.
 * Handles viewing settlement data, exporting CSV, and inspecting table columns.
 */
export class ReportsPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigate to the settlement reports page.
   */
  async goto(): Promise<void> {
    await this.navigateTo('/reports/settlement');
  }

  /**
   * Get the settlement table data (all rows).
   */
  async getSettlementTable(): Promise<SettlementRow[]> {
    await this.waitForGrid();
    const rows = this.page.locator('table tbody tr');
    const count = await rows.count();
    const result: SettlementRow[] = [];

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const cells = await row.locator('td').allTextContents();
      result.push({ cells: cells.map((c) => c.trim()) });
    }

    return result;
  }

  /**
   * Click the CSV export button and wait for the download.
   * Returns the download object for further assertions.
   */
  async exportCsv(): Promise<void> {
    // Set up download listener before clicking
    const downloadPromise = this.page.waitForEvent('download', { timeout: 15_000 });

    // Click the export/download button
    const exportButton = this.page.getByRole('button', { name: /내보내기|export|csv|다운로드|download/i });
    await exportButton.click();

    // Wait for the download to start
    const download = await downloadPromise;
    // Save the filename for later retrieval
    const filename = download.suggestedFilename();
    await download.saveAs(`/tmp/e2e-download-${filename}`);
  }

  /**
   * Get the filename of the most recently exported CSV file.
   */
  async getExportedFileName(): Promise<string> {
    // Set up download listener and trigger export
    const downloadPromise = this.page.waitForEvent('download', { timeout: 15_000 });

    const exportButton = this.page.getByRole('button', { name: /내보내기|export|csv|다운로드|download/i });
    await exportButton.click();

    const download = await downloadPromise;
    return download.suggestedFilename();
  }

  /**
   * Get the column headers of the settlement table.
   */
  async getColumnHeaders(): Promise<string[]> {
    await this.waitForGrid();
    const headers = this.page.locator('table thead th');
    const texts = await headers.allTextContents();
    return texts.map((t) => t.trim()).filter((t) => t.length > 0);
  }
}
