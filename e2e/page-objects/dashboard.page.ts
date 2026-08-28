import { type Page, type Locator } from '@playwright/test';
import { BasePage } from './base.page';

/**
 * DashboardPage encapsulates interactions with the main dashboard (/).
 * The dashboard displays KPI cards, charts, and summary metrics.
 */
export class DashboardPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigate to the dashboard.
   */
  async goto(): Promise<void> {
    await this.navigateTo('/');
  }

  /**
   * Get all KPI card elements on the dashboard.
   * KPI cards are typically rendered as card components with metric values.
   */
  async getKpiCards(): Promise<Locator[]> {
    await this.waitForNetworkIdle();
    const cards = this.page.locator('[class*="card"], [data-slot="card"]').filter({
      has: this.page.locator('h3, [class*="title"], [class*="metric"], p'),
    });
    await cards.first().waitFor({ state: 'visible', timeout: 15_000 });
    return cards.all();
  }

  /**
   * Check if chart components are rendered on the dashboard.
   * Charts use canvas elements or SVG-based rendering (recharts).
   */
  async hasCharts(): Promise<boolean> {
    await this.waitForNetworkIdle();
    const charts = this.page.locator('canvas, svg.recharts-surface, [class*="chart"], [data-chart]');
    return charts.count().then((count) => count > 0);
  }

  /**
   * Get summary metrics displayed on the dashboard.
   * Returns an object with counts/values for key entities.
   */
  async getSummaryMetrics(): Promise<{ text: string }[]> {
    await this.waitForNetworkIdle();
    const metricElements = this.page.locator(
      '[class*="card"] [class*="value"], [class*="card"] .text-2xl, [class*="card"] .text-3xl, [data-slot="card"] p.text-2xl, [data-slot="card"] p.text-3xl'
    );
    await metricElements.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    const elements = await metricElements.all();
    const metrics: { text: string }[] = [];
    for (const el of elements) {
      const text = (await el.textContent()) ?? '';
      metrics.push({ text: text.trim() });
    }
    return metrics;
  }
}
