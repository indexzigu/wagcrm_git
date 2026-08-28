import { type Page } from '@playwright/test';
import { BasePage } from './base.page';

export interface OutreachItem {
  dealName: string;
  sellerName: string;
  status: string;
}

export interface OutreachCreateData {
  dealName: string;
  sellerName: string;
  proposalMessage?: string;
}

/**
 * OutreachPage encapsulates interactions with the /outreach page.
 * Handles the seller outreach flow: proposing deals to sellers,
 * accepting outreaches, and managing the outreach list.
 */
export class OutreachPage extends BasePage {
  private lastError = '';

  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigate to the outreach page.
   */
  async goto(): Promise<void> {
    await this.navigateTo('/outreach');
  }

  /**
   * Propose a deal to a seller, creating a new outreach record.
   */
  async proposeDeal(dealId: string, sellerId: string): Promise<void> {
    this.lastError = '';
    const response = await this.page.request.post('/api/outreach', {
      data: {
        dealId,
        sellerId,
        contactChannel: 'DM',
      },
    });
    if (!response.ok()) {
      const body = await response.json().catch(() => ({}));
      this.lastError = body?.error?.toString?.() ?? `create failed: ${response.status()}`;
    }
  }

  async createOutreachViaUi(data: OutreachCreateData): Promise<void> {
    await this.page.getByRole('button', { name: /새 영업 테스크|영업 테스크 추가|테스크 추가/i }).first().click();
    await this.page.getByRole('button', { name: /딜 선택/ }).click();
    const dealDialog = this.page.getByRole('dialog').last();
    await dealDialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dealDialog.getByRole('textbox').first().fill(data.dealName);
    await dealDialog.getByRole('button', { name: new RegExp(data.dealName) }).first().click();
    await dealDialog.getByRole('button', { name: /선택 확인/ }).click();
    await this.page.getByRole('button', { name: /셀러 검색 선택/ }).click();
    const sellerDialog = this.page.getByRole('dialog').last();
    await sellerDialog.waitFor({ state: 'visible', timeout: 10_000 });
    await sellerDialog.getByRole('textbox').first().fill(data.sellerName);
    await sellerDialog.getByRole('button', { name: new RegExp(data.sellerName) }).first().click();
    await sellerDialog.getByRole('button', { name: /선택 확인/ }).click();
    if (data.proposalMessage) {
      await this.page.getByLabel(/제안 메모/).fill(data.proposalMessage);
    }
    await this.page.getByRole('button', { name: /영업 테스크 생성/ }).click();
    await this.waitForNetworkIdle();
  }

  /**
   * Accept an outreach proposal, which auto-creates a SalesCampaign.
   */
  async acceptOutreach(id: string): Promise<void> {
    await this.page.request.patch(`/api/outreach/${id}`, {
      data: {
        status: 'NEGOTIATION',
      },
    });
    await this.page.request.patch(`/api/outreach/${id}`, {
      data: {
        status: 'PENDING_APPROVAL',
        autoCreateCampaign: true,
      },
    });
  }

  /**
   * Get the list of all outreach items displayed on the page.
   */
  async getOutreachList(): Promise<OutreachItem[]> {
    const response = await this.page.request.get('/api/outreach');
    if (!response.ok()) return [];
    const data = await response.json();
    const items = data.outreaches ?? data ?? [];
    return items.map((item: { dealName?: string; sellerName?: string; status?: string }) => ({
      dealName: (item.dealName ?? '').trim(),
      sellerName: (item.sellerName ?? '').trim(),
      status: (item.status ?? '').trim(),
    }));
  }

  /**
   * Get the duplicate error message when creating a duplicate outreach.
   */
  async getDuplicateError(): Promise<string> {
    if (this.lastError) return this.lastError;
    const error = this.page.locator(
      '[role="alert"], .text-destructive, [data-sonner-toast][data-type="error"], [data-sonner-toast]'
    ).first();
    await error.waitFor({ state: 'visible', timeout: 10_000 });
    return (await error.textContent()) ?? '';
  }
}
