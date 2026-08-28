/**
 * Global setup: seeds deterministic test data via Prisma and authenticates via browser.
 * Saves storageState for session reuse across all test specs.
 */
import { getE2ePrismaClient } from './fixtures/test-prisma';
import { chromium } from '@playwright/test';
import { buildSeedData, getWorkerNamespace } from './fixtures/test-data';

const E2E_BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

function resolveWorkerSeedCount(): number {
  const raw = process.env.E2E_SEED_WORKER_COUNT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return process.env.CI ? 2 : 3;
}

async function globalSetup() {
  const prisma = getE2ePrismaClient();

  try {
    const workerSeedCount = resolveWorkerSeedCount();

    for (let i = 0; i < workerSeedCount; i += 1) {
      const seed = buildSeedData(getWorkerNamespace(i));

      for (const partner of seed.testPartners) {
        await prisma.partner.upsert({
          where: { id: partner.id },
          update: {
            name: partner.name,
            type: partner.type,
            contactInfo: partner.contactInfo,
          },
          create: {
            id: partner.id,
            name: partner.name,
            type: partner.type,
            contactInfo: partner.contactInfo,
          },
        });
      }

      for (const seller of seed.testSellers) {
        await prisma.seller.upsert({
          where: { id: seller.id },
          update: {
            name: seller.name,
            snsType: seller.snsType,
            snsHandle: seller.snsHandle,
            currentFollowers: seller.currentFollowers,
          },
          create: {
            id: seller.id,
            name: seller.name,
            snsType: seller.snsType,
            snsHandle: seller.snsHandle,
            currentFollowers: seller.currentFollowers,
          },
        });
      }

      for (const deal of seed.testDeals) {
        await prisma.deal.upsert({
          where: { id: deal.id },
          update: {
            dealName: deal.dealName,
            partnerId: deal.partnerId,
            status: deal.status,
            baseMarginPolicy: deal.baseMarginPolicy,
            costPrice: deal.costPrice,
            sellingPrice: deal.sellingPrice,
          },
          create: {
            id: deal.id,
            dealName: deal.dealName,
            partnerId: deal.partnerId,
            status: deal.status,
            baseMarginPolicy: deal.baseMarginPolicy,
            costPrice: deal.costPrice,
            sellingPrice: deal.sellingPrice,
          },
        });
      }

      for (const outreach of seed.testOutreach) {
        await prisma.salesTask.upsert({
          where: { id: outreach.id },
          update: {
            dealId: outreach.dealId,
            sellerId: outreach.sellerId,
            status: outreach.status,
            contactChannel: 'DM',
            proposalMessage: 'E2E seeded outreach task',
          },
          create: {
            id: outreach.id,
            dealId: outreach.dealId,
            sellerId: outreach.sellerId,
            status: outreach.status,
            contactChannel: 'DM',
            proposalMessage: 'E2E seeded outreach task',
          },
        });
      }

      for (const campaign of seed.testCampaigns) {
        await prisma.salesCampaign.upsert({
          where: { id: campaign.id },
          update: {
            dealId: campaign.dealId,
            sellerId: campaign.sellerId,
            status: campaign.status,
            salesChannel: campaign.salesChannel,
            startDate: new Date(campaign.startDate),
            endDate: new Date(campaign.endDate),
            baseNaverLink: 'https://example.com',
            generatedTrackingLink: 'https://example.com?seed=1',
          },
          create: {
            id: campaign.id,
            dealId: campaign.dealId,
            sellerId: campaign.sellerId,
            status: campaign.status,
            salesChannel: campaign.salesChannel,
            startDate: new Date(campaign.startDate),
            endDate: new Date(campaign.endDate),
            baseNaverLink: 'https://example.com',
            generatedTrackingLink: 'https://example.com?seed=1',
          },
        });
      }

      await prisma.settlementChecklist.upsert({
        where: { id: seed.testSettlementChecklist.id },
        update: {
          campaignId: seed.testSettlementChecklist.campaignId,
        },
        create: {
          id: seed.testSettlementChecklist.id,
          campaignId: seed.testSettlementChecklist.campaignId,
        },
      });

      for (const item of seed.testChecklistItems) {
        await prisma.settlementChecklistItem.upsert({
          where: { id: item.id },
          update: {
            checklistId: item.checklistId,
            label: item.label,
            sortOrder: item.sortOrder,
            isChecked: item.isChecked,
          },
          create: {
            id: item.id,
            checklistId: item.checklistId,
            label: item.label,
            sortOrder: item.sortOrder,
            isChecked: item.isChecked,
          },
        });
      }
    }

    // ─── Authenticate via Browser ──────────────────────────────────────────────
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    const loginResponse = await context.request.post(`${E2E_BASE_URL}/api/auth/dev-login`, {
      failOnStatusCode: false,
    });

    // dev-login may return 302 (redirect) or 200 after redirect following.
    if (![200, 302].includes(loginResponse.status())) {
      throw new Error(`E2E dev-login failed: ${loginResponse.status()}`);
    }

    await page.goto(`${E2E_BASE_URL}/`);

    // Verify session cookie is accepted and app is no longer on /login.
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });

    // Save authenticated state
    await context.storageState({ path: 'e2e/.auth/storageState.json' });
    await browser.close();
  } finally {
    await prisma.$disconnect();
  }
}

export default globalSetup;
