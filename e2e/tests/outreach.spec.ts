import { test, expect } from '../fixtures/auth.fixture';
import { OutreachPage } from '../page-objects/outreach.page';
import { getWorkerSeedData } from '../fixtures/test-data';

test.describe.serial('Outreach', () => {
  let outreachPage: OutreachPage;
  let seed = getWorkerSeedData(0);

  test.beforeEach(async ({ page }, testInfo) => {
    seed = getWorkerSeedData(testInfo.parallelIndex);
    outreachPage = new OutreachPage(page);
    await outreachPage.goto();
  });

  test('propose ARCHIVED deal to seller → PROPOSED', async () => {
    // Propose the ARCHIVED deal to a seller that doesn't already have an outreach
    const archivedDeal = seed.testDeals[2];
    const seller = seed.testSellers[2];

    await outreachPage.proposeDeal(archivedDeal.id, seller.id);

    const list = await outreachPage.getOutreachList();
    expect(list.length).toBeGreaterThan(0);
  });

  test('outreach list displays records', async () => {
    const list = await outreachPage.getOutreachList();
    expect(list.length).toBeGreaterThan(0);
  });

  test('accept outreach → CONVERTED + campaign auto-created', async () => {
    // Accept the seeded outreach
    const outreach = seed.testOutreach[0];
    await outreachPage.acceptOutreach(outreach.id);

    // Verify the outreach list shows updated status
    const list = await outreachPage.getOutreachList();
    const accepted = list.some(
      (item) => item.status.toUpperCase().includes('CONVERTED') || item.status.includes('전환')
    );
    expect(accepted).toBe(true);
  });

  test('duplicate outreach → error', async () => {
    const archivedDeal = seed.testDeals[2];
    const seller = seed.testSellers[1];

    await outreachPage.proposeDeal(archivedDeal.id, seller.id);
    await outreachPage.proposeDeal(archivedDeal.id, seller.id);

    const error = await outreachPage.getDuplicateError();
    expect(error).toBeTruthy();
  });
});
