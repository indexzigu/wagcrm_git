import { test, expect } from '../fixtures/auth.fixture';
import { DealsPage } from '../page-objects/deals.page';
import { TEST_PREFIX, getWorkerSeedData } from '../fixtures/test-data';

test.describe.serial('Deals CRUD & Status Machine', () => {
  let dealsPage: DealsPage;
  let seed = getWorkerSeedData(0);
  let newDealName = `${TEST_PREFIX}Deal_NewSpec_W0_0`;

  test.beforeAll(async ({}, testInfo) => {
    seed = getWorkerSeedData(testInfo.parallelIndex);
    newDealName = `${TEST_PREFIX}Deal_NewSpec_W${testInfo.parallelIndex}_${Date.now()}`;
  });

  test.beforeEach(async ({ page }) => {
    dealsPage = new DealsPage(page);
    await dealsPage.goto();
  });

  test('create deal → status is SOURCING', async () => {
    await dealsPage.createDeal({
      dealName: newDealName,
      partnerId: seed.testPartners[0].id,
      partnerName: seed.testPartners[0].name,
      baseMarginPolicy: 'FIXED_RATE',
      costPrice: 12000,
      sellingPrice: 30000,
    });

    const status = await dealsPage.getDealStatus(newDealName);
    expect(status.toUpperCase()).toContain('SOURCING');
  });

  test('deals grid displays deals', async () => {
    const rows = await dealsPage.getGridRows();
    expect(rows.length).toBeGreaterThan(0);

    // Verify seeded deal is visible
    const seededDeal = seed.testDeals[0];
    const found = rows.some((row) => row.cells.some((c) => c.includes(seededDeal.dealName)));
    expect(found).toBe(true);
  });

  test('inline edit deal field', async () => {
    const updatedPrice = '32000';
    await dealsPage.editDealInline(newDealName, 'sellingPrice', updatedPrice);

    // Reload and verify the deal still exists
    await dealsPage.goto();
    const rows = await dealsPage.getGridRows();
    const dealRow = rows.find((r) => r.cells.some((c) => c.includes(newDealName)));
    expect(dealRow).toBeDefined();
  });

  test('advance status full chain (SOURCING → NEGOTIATING → SAMPLE_TESTING → CONFIRMED → ARCHIVED)', async () => {
    // Advance from SOURCING → NEGOTIATING
    await dealsPage.advanceStatus(newDealName);
    let status = await dealsPage.getDealStatus(newDealName);
    expect(status.toUpperCase()).toContain('NEGOTIATING');

    // Advance from NEGOTIATING → SAMPLE_TESTING
    await dealsPage.advanceStatus(newDealName);
    status = await dealsPage.getDealStatus(newDealName);
    expect(status.toUpperCase()).toContain('SAMPLE_TESTING');

    // Advance from SAMPLE_TESTING → CONFIRMED
    await dealsPage.advanceStatus(newDealName);
    status = await dealsPage.getDealStatus(newDealName);
    expect(status.toUpperCase()).toContain('CONFIRMED');

    // Advance from CONFIRMED → ARCHIVED
    await dealsPage.advanceStatus(newDealName);
    status = await dealsPage.getDealStatus(newDealName);
    expect(status.toUpperCase()).toContain('ARCHIVED');
  });

  test('drop deal → DROPPED', async () => {
    // Use the seeded SOURCING deal for drop test
    const sourcingDeal = seed.testDeals[0].dealName;
    await dealsPage.dropDeal(sourcingDeal);

    const status = await dealsPage.getDealStatus(sourcingDeal);
    expect(status.toUpperCase()).toContain('DROPPED');
  });

  test('delete deal without campaigns → removed', async () => {
    // The newly created deal (now ARCHIVED) should be deletable if no campaigns
    await dealsPage.deleteDeal(newDealName);
    const exists = await dealsPage.hasDeal(newDealName);
    expect(exists).toBe(false);
  });

  test('delete deal with campaigns → blocked', async () => {
    // The seeded ARCHIVED deal has campaigns associated
    const dealWithCampaigns = seed.testDeals[2].dealName;
    await dealsPage.deleteDeal(dealWithCampaigns);

    const warning = await dealsPage.getDeleteWarning();
    expect(warning).toBeTruthy();
  });
});
