import { type Page } from '@playwright/test';
import { BasePage } from './base.page';

export interface SettlementRowItem {
  id: string;
  name: string;
  status: string;
}

export interface SettlementTableRow {
  name: string;
  statusText: string;
}

export class SettlementPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async goto(): Promise<void> {
    await this.navigateTo('/settlement');
  }

  async getVisibleRows(): Promise<SettlementRowItem[]> {
    const response = await this.page.request.get('/api/campaigns?workspace=settlement');
    if (!response.ok()) return [];
    const json = await response.json();
    const campaigns = json.campaigns ?? [];
    return campaigns.map((campaign: {
      id: string;
      status: string;
      campaignName?: string | null;
      dealName?: string;
      sellerName?: string;
    }) => ({
      id: campaign.id,
      status: campaign.status ?? '',
      name: (campaign.campaignName ?? `${campaign.dealName ?? ''} - ${campaign.sellerName ?? ''}`).trim(),
    }));
  }

  async getTableRows(): Promise<SettlementTableRow[]> {
    const loader = this.page.locator('text=정산 목록 로딩 중...');
    await loader.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);

    const table = this.page.locator('table').first();
    await table.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);

    const rows = this.page.locator('table tbody tr');
    await rows.first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined);

    return this.page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('table tbody tr'));
      return trs.map((tr) => {
        const tds = Array.from(tr.querySelectorAll('td'));
        const name = tds[1]?.textContent?.trim() ?? '';
        const statusText = tds[6]?.textContent?.trim() ?? '';
        return { name, statusText };
      });
    });
  }

  async setStatusFilter(
    filter: 'ALL' | 'SETTLEMENT_IN_PROGRESS' | 'COMPLETED',
  ): Promise<void> {
    const labelMap = {
      ALL: '전체',
      SETTLEMENT_IN_PROGRESS: '정산 진행',
      COMPLETED: '정산 완료',
    } as const;

    const responsePromise = this.page.waitForResponse(
      (response) =>
        response.url().includes('/api/reports/settlement') &&
        response.status() === 200,
      { timeout: 10_000 }
    ).catch(() => undefined);

    await this.page.getByRole('button', { name: labelMap[filter] }).click();

    await responsePromise;
    await this.waitForNetworkIdle();

    const loader = this.page.locator('text=정산 목록 로딩 중...');
    await loader.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  async getMonthLabel(): Promise<string> {
    const label = this.page.locator('span').filter({ hasText: /년\s+\d+월/ }).first();
    await label.waitFor({ state: 'visible', timeout: 10_000 });
    return (await label.textContent())?.trim() ?? '';
  }

  async moveToNextMonth(): Promise<void> {
    const responsePromise = this.page.waitForResponse(
      (response) =>
        response.url().includes('/api/reports/settlement') &&
        response.status() === 200,
      { timeout: 10_000 }
    ).catch(() => undefined);

    await this.page.getByRole('button', { name: '다음 월' }).click();

    await responsePromise;
    await this.waitForNetworkIdle();
  }

  async exportCsvAndGetFileName(): Promise<string> {
    const downloadPromise = this.page.waitForEvent('download', { timeout: 15_000 });
    await this.page.getByRole('button', { name: 'CSV 내보내기' }).click();
    const download = await downloadPromise;
    return download.suggestedFilename();
  }

  async openFirstRowDetail(): Promise<void> {
    const detailButton = this.page.locator('table tbody tr button').first();
    await detailButton.waitFor({ state: 'visible', timeout: 10_000 });
    await detailButton.click();
    await this.page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 });
  }

  async toggleChecklistItemInPanel(): Promise<void> {
    const checkbox = this.page.locator('[role="dialog"] input[type="checkbox"]').first();
    await checkbox.waitFor({ state: 'visible', timeout: 10_000 });
    await checkbox.click();
    await this.waitForNetworkIdle();
  }
}
