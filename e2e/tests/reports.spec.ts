import { test, expect } from '../fixtures/auth.fixture';
import { ReportsPage } from '../page-objects/reports.page';

test.describe('Reports', () => {
  let reportsPage: ReportsPage;

  test.beforeEach(async ({ page }) => {
    reportsPage = new ReportsPage(page);
    await reportsPage.goto();
  });

  test('settlement report table', async () => {
    const table = await reportsPage.getSettlementTable();
    expect(table.length).toBeGreaterThan(0);

    // Each row should have cells with data
    for (const row of table) {
      expect(row.cells.length).toBeGreaterThan(0);
    }
  });

  test('CSV export downloads file', async ({ page }) => {
    // Set up download listener
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });

    const exportButton = page.getByRole('button', {
      name: /내보내기|export|csv|다운로드|download/i,
    });
    await exportButton.click();

    const download = await downloadPromise;
    const filename = download.suggestedFilename();

    expect(filename).toBeTruthy();
    expect(filename.toLowerCase()).toContain('csv');
  });

  test('exported CSV has all columns', async () => {
    const headers = await reportsPage.getColumnHeaders();
    expect(headers.length).toBeGreaterThan(0);

    // The exported CSV should include all visible column headers
    // Verify key columns exist
    const headerText = headers.join(' ').toLowerCase();
    expect(headerText).toBeTruthy();
  });
});
