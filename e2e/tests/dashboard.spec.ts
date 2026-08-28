import { test, expect } from '../fixtures/auth.fixture';
import { DashboardPage } from '../page-objects/dashboard.page';

test.describe('Dashboard', () => {
  let dashboardPage: DashboardPage;

  test.beforeEach(async ({ page }) => {
    dashboardPage = new DashboardPage(page);
    await dashboardPage.goto();
  });

  test('dashboard displays KPI cards on load', async () => {
    const kpiCards = await dashboardPage.getKpiCards();
    expect(kpiCards.length).toBeGreaterThan(0);
  });

  test('dashboard renders chart components', async () => {
    const hasCharts = await dashboardPage.hasCharts();
    expect(hasCharts).toBe(true);
  });

  test('dashboard shows summary metrics', async () => {
    const metrics = await dashboardPage.getSummaryMetrics();
    expect(metrics.length).toBeGreaterThan(0);
    // Each metric should have non-empty text
    for (const metric of metrics) {
      expect(metric.text).toBeTruthy();
    }
  });
});
