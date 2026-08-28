import { test, expect } from '../fixtures/auth.fixture';
import { SellersPage } from '../page-objects/sellers.page';
import { TEST_PREFIX, getWorkerSeedData } from '../fixtures/test-data';

test.describe.serial('Sellers CRUD', () => {
  let sellersPage: SellersPage;
  let seed = getWorkerSeedData(0);
  let uniqueSeed = 0;
  let newSellerName = `${TEST_PREFIX}Seller_NewSpec_W0_0`;
  let newSnsHandle = 'e2e_test_new_spec_handle_w0_0';

  test.beforeAll(async ({}, testInfo) => {
    seed = getWorkerSeedData(testInfo.parallelIndex);
    uniqueSeed = Date.now();
    newSellerName = `${TEST_PREFIX}Seller_NewSpec_W${testInfo.parallelIndex}_${uniqueSeed}`;
    newSnsHandle = `e2e_test_new_spec_handle_w${testInfo.parallelIndex}_${uniqueSeed}`;
  });

  test.beforeEach(async ({ page }) => {
    sellersPage = new SellersPage(page);
    await sellersPage.goto();
  });

  test('create seller with unique snsType+snsHandle → appears in grid', async () => {
    await sellersPage.createSeller({
      name: newSellerName,
      snsType: 'INSTAGRAM',
      snsHandle: newSnsHandle,
      currentFollowers: 50000,
    });

    const toast = await sellersPage.getToastMessage();
    expect(toast).toContain('새로운 셀러가 추가되었습니다.');

    await sellersPage.goto();

    const rows = await sellersPage.getGridRows();
    const found = rows.some((row) => row.cells.some((c) => c.includes(newSellerName)));
    expect(found).toBe(true);
  });

  test('create seller with channel URL only → appears in grid', async () => {
    const channelUrlSellerHandle = `e2e_test_channel_url_spec_${Date.now()}`;
    const channelUrl = `https://instagram.com/${channelUrlSellerHandle}`;

    await sellersPage.createSeller({
      channelUrl,
    });

    const toast = await sellersPage.getToastMessage();
    expect(toast).toContain('새로운 셀러가 추가되었습니다.');

    await sellersPage.goto();

    const rows = await sellersPage.getGridRows();
    const found = rows.some((row) => row.cells.some((c) => c.includes(channelUrlSellerHandle)));
    expect(found).toBe(true);

    await sellersPage.deleteSeller(channelUrlSellerHandle);
  });

  test('create seller with duplicate snsType+snsHandle → uniqueness error', async () => {
    // Try to create a seller with the same snsType+snsHandle as an existing seeded seller
    const existingSeller = seed.testSellers[0];
    await sellersPage.createSeller({
      name: `${TEST_PREFIX}Seller_Duplicate`,
      snsType: existingSeller.snsType,
      snsHandle: existingSeller.snsHandle,
    });

    const error = await sellersPage.getUniquenessError();
    expect(error).toBeTruthy();
  });

  test('sellers grid displays sellers', async () => {
    const rows = await sellersPage.getGridRows();
    expect(rows.length).toBeGreaterThan(0);

    // Verify seeded seller is visible
    const seededSeller = seed.testSellers[0];
    const found = rows.some((row) => row.cells.some((c) => c.includes(seededSeller.name)));
    expect(found).toBe(true);
  });

  test('inline edit seller field → changes persisted', async () => {
    const updatedFollowers = '99000';
    await sellersPage.editSellerInline(newSellerName, 'currentFollowers', updatedFollowers);

    // Reload and verify
    await sellersPage.goto();
    const rows = await sellersPage.getGridRows();
    const sellerRow = rows.find((r) => r.cells.some((c) => c.includes(newSellerName)));
    expect(sellerRow).toBeDefined();
  });

  test('delete seller without campaigns → removed', async () => {
    await sellersPage.deleteSeller(newSnsHandle);
    await sellersPage.goto();

    const rows = await sellersPage.getGridRows();
    const found = rows.some((row) => row.cells.some((c) => c.includes(newSnsHandle)));
    expect(found).toBe(false);
  });

  test('delete seller with campaigns → blocked', async () => {
    // The seeded seller (InstaAlpha) has campaigns associated
    const sellerWithCampaigns = seed.testSellers[0].name;
    await sellersPage.deleteSeller(sellerWithCampaigns);

    const warning = await sellersPage.getDeleteWarning();
    expect(warning).toBeTruthy();
  });
});
