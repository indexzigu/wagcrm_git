import { test, expect } from '../fixtures/auth.fixture';
import { SettlementPage } from '../page-objects/settlement.page';

test.describe.serial('Settlement Workspace', () => {
  let settlementPage: SettlementPage;

  test.beforeEach(async ({ page }) => {
    settlementPage = new SettlementPage(page);
    await settlementPage.goto();
  });

  test('shows settlement workspace rows and status boundary', async () => {
    const rows = await settlementPage.getVisibleRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['SETTLEMENT_IN_PROGRESS', 'COMPLETED']).toContain(row.status);
    }
  });

  test('applies status filter for in-progress and completed', async () => {
    await settlementPage.setStatusFilter('SETTLEMENT_IN_PROGRESS');
    const inProgressRows = await settlementPage.getTableRows();
    for (const row of inProgressRows) {
      expect(row.statusText).toContain('정산 진행');
    }

    await settlementPage.setStatusFilter('COMPLETED');
    const completedRows = await settlementPage.getTableRows();
    for (const row of completedRows) {
      expect(row.statusText).toContain('정산 완료');
    }
  });

  test('moves month and exports csv', async () => {
    const filename = await settlementPage.exportCsvAndGetFileName();
    expect(filename).toContain('settlement-workspace-');
    expect(filename.toLowerCase()).toContain('.csv');

    const before = await settlementPage.getMonthLabel();
    await settlementPage.moveToNextMonth();
    const after = await settlementPage.getMonthLabel();
    expect(after).not.toBe(before);
  });

  test('opens detail panel and toggles checklist item', async ({ page }) => {
    await settlementPage.openFirstRowDetail();
    await settlementPage.toggleChecklistItemInPanel();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
  });
});
