import { type Page } from '@playwright/test';
import { BasePage } from './base.page';

export interface CampaignPipelineItem {
  id: string;
  name: string;
  status: string;
  dealName: string;
  sellerName: string;
}

export interface ActivityLogEntry {
  action: string;
  timestamp: string;
}

export interface DirectCampaignCreateResult {
  selectedDealName: string;
  selectedSellerName: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitCampaignName(campaignName: string): DirectCampaignCreateResult {
  const [selectedDealName = '', ...sellerParts] = campaignName.split(' - ');
  return {
    selectedDealName: selectedDealName.trim(),
    selectedSellerName: sellerParts.join(' - ').trim(),
  };
}

/**
 * CampaignsPage encapsulates interactions with the /pipeline page.
 * Handles campaign pipeline view, status transitions, settlement checklist,
 * and campaign duplication.
 */
export class CampaignsPage extends BasePage {
  private async fetchPipelineCampaigns(): Promise<Array<{
    id: string;
    status: string;
    campaignName?: string | null;
    dealName?: string;
    sellerName?: string;
    checklistSummary?: { total: number };
  }>> {
    const response = await this.page.request.get('/api/campaigns?workspace=pipeline');
    if (!response.ok()) return [];
    const data = await response.json();
    return data.campaigns ?? data ?? [];
  }

  private async findCampaignByName(name: string): Promise<{ id: string; status: string } | null> {
    const campaigns = await this.fetchPipelineCampaigns();
    const matched = campaigns.find((campaign) => {
      const displayName = campaign.campaignName ?? `${campaign.dealName ?? ''} - ${campaign.sellerName ?? ''}`;
      return displayName.trim() === name.trim();
    });
    if (!matched) return null;
    return { id: matched.id, status: matched.status };
  }

  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigate to the pipeline/campaigns page.
   */
  async goto(): Promise<void> {
    await this.navigateTo('/pipeline');
  }

  /**
   * Get all campaigns in the pipeline view.
   */
  async getCampaignPipeline(): Promise<CampaignPipelineItem[]> {
    const campaigns = await this.fetchPipelineCampaigns();
    return campaigns.map((campaign) => ({
      id: campaign.id,
      name: (campaign.campaignName ?? `${campaign.dealName ?? ''} - ${campaign.sellerName ?? ''}`).trim(),
      dealName: campaign.dealName ?? '',
      sellerName: campaign.sellerName ?? '',
      status: campaign.status ?? '',
    }));
  }

  /**
   * Transition a campaign's status to a new status.
   */
  async transitionStatus(name: string, status: string): Promise<void> {
    const matched = await this.findCampaignByName(name);
    if (!matched) throw new Error(`Campaign not found: ${name}`);
    const response = await this.page.request.patch(`/api/campaigns/${matched.id}`, {
      data: { status },
      timeout: 60_000,
    });
    if (!response.ok()) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`Failed to transition campaign: ${response.status()} ${JSON.stringify(body)}`);
    }
  }

  /**
   * Toggle a settlement checklist item for a campaign.
   */
  async toggleChecklistItem(campaignName: string, itemLabel: string): Promise<void> {
    const matched = await this.findCampaignByName(campaignName);
    if (!matched) throw new Error(`Campaign not found: ${campaignName}`);

    const checklistRes = await this.page.request.get(`/api/campaigns/${matched.id}/checklist`);
    if (!checklistRes.ok()) return;
    const checklist = await checklistRes.json();
    const target = (checklist.items ?? []).find(
      (item: { label?: string }) => (item.label ?? '').includes(itemLabel)
    ) ?? checklist.items?.[0];
    if (!target?.id) return;

    await this.page.request.patch(`/api/campaign-checklist/items/${target.id}`, {
      data: { isChecked: !Boolean(target.isChecked) },
    });
  }

  /**
   * Duplicate a campaign by name.
   */
  async duplicateCampaign(name: string): Promise<void> {
    const matched = await this.findCampaignByName(name);
    if (!matched) throw new Error(`Campaign not found: ${name}`);

    // pick a different seeded seller as duplicate target
    const sellersRes = await this.page.request.get('/api/sellers');
    if (!sellersRes.ok()) return;
    const sellersJson = await sellersRes.json();
    const sellers = sellersJson.sellers ?? sellersJson ?? [];

    const sourceCampaignRes = await this.page.request.get(`/api/campaigns/${matched.id}`);
    if (!sourceCampaignRes.ok()) return;
    const sourceCampaign = await sourceCampaignRes.json();
    const targetSeller = sellers.find((seller: { id?: string }) => seller.id !== sourceCampaign.sellerId);
    if (!targetSeller?.id) return;

    await this.page.request.post('/api/campaigns/duplicate', {
      data: {
        sourceCampaignId: matched.id,
        sellerId: targetSeller.id,
      },
    });
  }

  async createDirectCampaignFromCurrentDefaults(): Promise<DirectCampaignCreateResult> {
    await this.page.getByRole('button', { name: /새 캠페인|캠페인 생성|직접 생성|추가/i }).first().click();
    const dialog = await this.waitForPanel();
    const campaignName = (await dialog.locator('input[disabled]').first().inputValue()).trim();
    const { selectedDealName, selectedSellerName } = splitCampaignName(campaignName);
    if (!selectedDealName || !selectedSellerName) {
      throw new Error('Campaign create dialog did not expose default selections');
    }
    await dialog.getByRole('button', { name: /캠페인 생성/ }).click();
    await this.waitForNetworkIdle();
    return { selectedDealName, selectedSellerName };
  }

  async createDirectCampaign(params: {
    dealName: string;
    sellerName: string;
  }): Promise<DirectCampaignCreateResult> {
    await this.page.getByRole('button', { name: /새 캠페인|캠페인 생성|직접 생성|추가/i }).first().click();
    const dialog = await this.waitForPanel();

    await dialog.getByRole('button', { name: /딜 선택|딜 변경/ }).first().click();
    const dealDialog = this.page.getByRole('dialog').last();
    await dealDialog.getByPlaceholder(/딜|거래처|검색/).fill(params.dealName);
    await dealDialog.getByRole('button', { name: new RegExp(escapeRegex(params.dealName)) }).first().click();
    await dealDialog.getByRole('button', { name: '선택 확인' }).click();

    await dialog.getByRole('button', { name: /셀러 검색 선택|셀러 변경/ }).first().click();
    const sellerDialog = this.page.getByRole('dialog').last();
    await sellerDialog.getByPlaceholder(/셀러|검색/).fill(params.sellerName);
    await sellerDialog.getByRole('button', { name: new RegExp(escapeRegex(params.sellerName)) }).first().click();
    await sellerDialog.getByRole('button', { name: '선택 확인' }).click();

    const campaignName = (await dialog.locator('input[disabled]').first().inputValue()).trim();
    await dialog.getByRole('button', { name: /캠페인 생성/ }).click();
    await this.waitForNetworkIdle();

    return splitCampaignName(campaignName);
  }

  /**
   * Get the activity log entries for a campaign.
   */
  async getActivityLog(name: string): Promise<ActivityLogEntry[]> {
    // Open the campaign detail panel
    const row = this.page.locator('table tbody tr, [class*="card"]', { hasText: name }).first();
    await row.waitFor({ state: 'visible' });
    await row.click();
    const panel = await this.waitForPanel();

    // Look for activity log section
    const logEntries = panel.locator('[class*="activity"], [class*="log"], [class*="timeline"]').locator('li, [class*="entry"], [class*="item"]');
    const count = await logEntries.count();
    const entries: ActivityLogEntry[] = [];

    for (let i = 0; i < count; i++) {
      const entry = logEntries.nth(i);
      const text = (await entry.textContent()) ?? '';
      entries.push({
        action: text.trim(),
        timestamp: '',
      });
    }

    return entries;
  }
}
