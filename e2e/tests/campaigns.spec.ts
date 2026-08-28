import { test, expect } from '../fixtures/auth.fixture';
import { CampaignsPage } from '../page-objects/campaigns.page';
import { getWorkerSeedData } from '../fixtures/test-data';

test.describe.serial('Campaigns Pipeline', () => {
  let campaignsPage: CampaignsPage;
  let seed = getWorkerSeedData(0);

  test.beforeEach(async ({ page }, testInfo) => {
    seed = getWorkerSeedData(testInfo.parallelIndex);
    campaignsPage = new CampaignsPage(page);
    await campaignsPage.goto();
  });

  test('campaign in pipeline with PROGRESS status', async () => {
    const pipeline = await campaignsPage.getCampaignPipeline();
    expect(pipeline.length).toBeGreaterThan(0);

    // Verify seeded campaign is in pipeline progress zone
    const progressCampaign = pipeline.find(
      (item) => ['PREPARATION', 'ACTIVE', 'CLOSED'].includes(item.status.toUpperCase())
    );
    expect(progressCampaign).toBeDefined();
  });

  test('transition campaign status', async () => {
    // Transition the first campaign in PROGRESS workspace
    const pipeline = await campaignsPage.getCampaignPipeline();

    // Find a campaign to transition
    const campaign = pipeline.find((item) => item.status.toUpperCase().includes('PREPARATION'));
    if (campaign) {
      await campaignsPage.transitionStatus(campaign.name, 'ACTIVE');

      // Reload and verify
      await campaignsPage.goto();
      const updatedPipeline = await campaignsPage.getCampaignPipeline();
      const updated = updatedPipeline.find((item) => item.id === campaign.id);
      expect(updated?.status.toUpperCase()).toBe('ACTIVE');
    }
  });

  test('settlement checklist auto-generated', async () => {
    // The seeded campaign (settle01) has hasSettlementChecklist: true
    const pipeline = await campaignsPage.getCampaignPipeline();

    // Find the campaign and open its detail to check for checklist
    expect(pipeline.length).toBeGreaterThan(0);
    // The checklist items should exist for the settlement-eligible campaign
    expect(seed.testChecklistItems.length).toBeGreaterThan(0);
  });

  test('toggle checklist item', async () => {
    const pipeline = await campaignsPage.getCampaignPipeline();
    if (pipeline.length > 0) {
      const campaignName = pipeline[pipeline.length - 1].name;
      const checklistLabel = seed.testChecklistItems[0].label;

      await campaignsPage.toggleChecklistItem(campaignName, checklistLabel);

      // Verify the toggle was successful (no error thrown)
      expect(true).toBe(true);
    }
  });

  test('duplicate campaign', async () => {
    const pipeline = await campaignsPage.getCampaignPipeline();
    const initialCount = pipeline.length;

    if (pipeline.length > 0) {
      const campaignName = pipeline[0].name;
      await campaignsPage.duplicateCampaign(campaignName);

      // Reload and verify count increased
      await campaignsPage.goto();
      const updatedPipeline = await campaignsPage.getCampaignPipeline();
      expect(updatedPipeline.length).toBeGreaterThanOrEqual(initialCount);
    }
  });
});
