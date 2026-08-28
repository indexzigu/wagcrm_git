import { test, expect } from '../fixtures/auth.fixture';
import { TEST_PREFIX, getWorkerSeedData } from '../fixtures/test-data';

test.describe('CSV Import', () => {
  function buildRows(workerIndex: number) {
    const seed = getWorkerSeedData(workerIndex);
    const uniqueSeed = Date.now();
    const validRows = [
      {
        dealName: `${TEST_PREFIX}Import_Deal1_W${workerIndex}_${uniqueSeed}`,
        partnerId: seed.testPartners[0].id,
        costPrice: '10000',
        sellingPrice: '20000',
        brandName: 'ImportBrandA',
        status: 'SOURCING',
        sourcingMemo: 'seeded from csv',
      },
      {
        dealName: `${TEST_PREFIX}Import_Deal2_W${workerIndex}_${uniqueSeed}`,
        partnerId: seed.testPartners[0].id,
        costPrice: '12000',
        sellingPrice: '24000',
        brandName: 'ImportBrandB',
        status: 'NEGOTIATING',
        sourcingMemo: 'seeded from csv',
      },
    ];

    const invalidRows = [
      {
        dealName: '',
        partnerId: seed.testPartners[0].id,
        costPrice: '10000',
        sellingPrice: '20000',
        brandName: 'ImportBrandA',
        status: 'SOURCING',
        sourcingMemo: 'missing deal name',
      },
      {
        dealName: `${TEST_PREFIX}Import_Bad_W${workerIndex}_${uniqueSeed}`,
        partnerId: '',
        costPrice: '12000',
        sellingPrice: '24000',
        brandName: 'ImportBrandB',
        status: 'SOURCING',
        sourcingMemo: 'missing partner id',
      },
    ];

    return { validRows, invalidRows };
  }

  const mapping = {
    dealName: 'dealName',
    partnerId: 'partnerId',
    costPrice: 'costPrice',
    sellingPrice: 'sellingPrice',
    brandName: 'brandName',
    status: 'status',
    sourcingMemo: 'sourcingMemo',
  };

  test('upload valid CSV → preview', async ({ page }, testInfo) => {
    const { validRows } = buildRows(testInfo.parallelIndex);
    const response = await page.request.post('/api/import/validate', {
      data: {
        entityType: 'deals',
        mapping,
        rows: validRows,
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.validCount).toBe(2);
    expect(body.errorCount).toBe(0);
    expect(body.validRows[0].dealName).toContain(`${TEST_PREFIX}Import_Deal1_`);
  });

  test('confirm import → success', async ({ page }, testInfo) => {
    const { validRows } = buildRows(testInfo.parallelIndex);
    const validateResponse = await page.request.post('/api/import/validate', {
      data: {
        entityType: 'deals',
        mapping,
        rows: validRows,
      },
    });
    expect(validateResponse.ok()).toBe(true);
    const validated = await validateResponse.json();
    expect(validated.validCount).toBe(2);

    const executeResponse = await page.request.post('/api/import/execute', {
      data: {
        entityType: 'deals',
        validRows: validated.validRows,
      },
    });

    expect(executeResponse.ok()).toBe(true);
    const executed = await executeResponse.json();
    expect(executed.createdCount).toBe(2);
    expect(executed.skippedCount).toBe(0);
  });

  test('CSV with errors → error messages', async ({ page }, testInfo) => {
    const { invalidRows } = buildRows(testInfo.parallelIndex);
    const response = await page.request.post('/api/import/validate', {
      data: {
        entityType: 'deals',
        mapping,
        rows: invalidRows,
      },
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.validCount).toBe(0);
    expect(body.errorCount).toBe(2);
    expect(body.rowErrors.length).toBeGreaterThan(0);
  });
});
