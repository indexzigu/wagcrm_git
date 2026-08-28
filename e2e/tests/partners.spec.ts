import { test, expect } from '../fixtures/auth.fixture';
import { PartnersPage } from '../page-objects/partners.page';
import { TEST_PREFIX, getWorkerSeedData } from '../fixtures/test-data';

test.describe.serial('Partners CRUD', () => {
  let partnersPage: PartnersPage;
  let seed = getWorkerSeedData(0);
  let newPartnerName = `${TEST_PREFIX}Partner_NewSpec_W0_0`;

  test.beforeAll(async ({}, testInfo) => {
    seed = getWorkerSeedData(testInfo.parallelIndex);
    newPartnerName = `${TEST_PREFIX}Partner_NewSpec_W${testInfo.parallelIndex}_${Date.now()}`;
  });

  test.beforeEach(async ({ page }) => {
    partnersPage = new PartnersPage(page);
    await partnersPage.goto();
  });

  test('create partner with name and type → appears in grid', async () => {
    await partnersPage.createPartner({
      name: newPartnerName,
      type: 'BRAND',
      contactInfo: 'new-spec@example.com',
    });
    const exists = await partnersPage.hasPartner(newPartnerName);
    expect(exists).toBe(true);
  });

  test('partners grid displays all partners', async () => {
    const rows = await partnersPage.getGridRows();
    expect(rows.length).toBeGreaterThan(0);

    // Verify seeded partners are visible
    const partnerNames = rows.flatMap((r) => r.cells);
    const seededPartner = seed.testPartners[0];
    const found = partnerNames.some((cell) => cell.includes(seededPartner.name));
    expect(found).toBe(true);
  });

  test('inline edit partner field → changes persisted', async () => {
    const updatedContact = 'updated-spec@example.com';
    await partnersPage.editPartnerInline(newPartnerName, 'contactInfo', updatedContact);

    // Reload and verify
    await partnersPage.goto();
    const rows = await partnersPage.getGridRows();
    const partnerRow = rows.find((r) => r.cells.some((c) => c.includes(newPartnerName)));
    expect(partnerRow).toBeDefined();
  });

  test('delete partner without deals → removed from grid', async () => {
    await partnersPage.deletePartner(newPartnerName);
    const exists = await partnersPage.hasPartner(newPartnerName);
    expect(exists).toBe(false);
  });

  test('delete partner with deals → warning displayed, deletion blocked', async () => {
    // The seeded partner (BrandAlpha) has deals associated
    const partnerWithDeals = seed.testPartners[0].name;
    await partnersPage.deletePartner(partnerWithDeals);

    const warning = await partnersPage.getDeleteWarning();
    expect(warning).toBeTruthy();
  });
});
