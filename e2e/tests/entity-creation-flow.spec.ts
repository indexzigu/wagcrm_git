import { test, expect } from '../fixtures/auth.fixture';
import { CampaignsPage } from '../page-objects/campaigns.page';
import { DealsPage } from '../page-objects/deals.page';
import { getE2ePrismaClient } from '../fixtures/test-prisma';
import { OutreachPage } from '../page-objects/outreach.page';
import { PartnersPage } from '../page-objects/partners.page';
import { SellersPage } from '../page-objects/sellers.page';

const prisma = getE2ePrismaClient();

function buildStamp() {
  return `${Date.now()}`;
}

async function cleanupE2eEntities() {
  const partners = await prisma.partner.findMany({
    where: { name: { startsWith: 'E2E 생성 거래처 ' } },
    select: { id: true },
  });
  const sellers = await prisma.seller.findMany({
    where: {
      OR: [
        { name: { startsWith: 'E2E 셀러 ' } },
        { alias: { startsWith: 'E2E별칭' } },
        { snsHandle: { startsWith: 'e2e_seller_' } },
      ],
    },
    select: { id: true },
  });

  const partnerIds = partners.map((item: { id: string }) => item.id);
  const sellerIds = sellers.map((item: { id: string }) => item.id);

  const deals = await prisma.deal.findMany({
    where: {
      OR: [
        { dealName: { startsWith: 'E2E 생성 딜 ' } },
        { partnerId: { in: partnerIds } },
      ],
    },
    select: { id: true },
  });

  const dealIds = deals.map((item: { id: string }) => item.id);

  const campaigns = await prisma.salesCampaign.findMany({
    where: {
      OR: [
        { sellerId: { in: sellerIds } },
        { dealId: { in: dealIds } },
        { campaignName: { startsWith: 'E2E 생성 딜 ' } },
      ],
    },
    select: { id: true },
  });

  const campaignIds = campaigns.map((item: { id: string }) => item.id);

  await prisma.salesTask.deleteMany({
    where: {
      OR: [
        { sellerId: { in: sellerIds } },
        { dealId: { in: dealIds } },
        { linkedCampaignId: { in: campaignIds } },
      ],
    },
  });
  await prisma.sellerOutreach.deleteMany({
    where: {
      OR: [
        { sellerId: { in: sellerIds } },
        { dealId: { in: dealIds } },
        { linkedCampaignId: { in: campaignIds } },
      ],
    },
  });

  if (campaignIds.length > 0) {
    await prisma.campaignDeal.deleteMany({ where: { campaignId: { in: campaignIds } } }).catch(() => undefined);
    await prisma.campaignChecklistItem.deleteMany({ where: { campaignId: { in: campaignIds } } }).catch(() => undefined);
    await prisma.settlementChecklistItem.deleteMany({
      where: { checklist: { campaignId: { in: campaignIds } } },
    }).catch(() => undefined);
    await prisma.settlementChecklist.deleteMany({ where: { campaignId: { in: campaignIds } } }).catch(() => undefined);
    await prisma.campaignActivity.deleteMany({ where: { campaignId: { in: campaignIds } } }).catch(() => undefined);
    await prisma.campaignNote.deleteMany({ where: { campaignId: { in: campaignIds } } }).catch(() => undefined);
    await prisma.salesCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  }

  await prisma.campaignDeal.deleteMany({ where: { dealId: { in: dealIds } } }).catch(() => undefined);
  await prisma.campaignTemplate.updateMany({
    where: { dealId: { in: dealIds } },
    data: { dealId: null },
  }).catch(() => undefined);
  await prisma.deal.updateMany({
    where: { parentDealId: { in: dealIds } },
    data: { parentDealId: null },
  }).catch(() => undefined);

  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.seller.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.partner.deleteMany({ where: { id: { in: partnerIds } } });
}

test.describe.serial('Entity creation UI flow', () => {
  test.beforeAll(async () => {
    await cleanupE2eEntities();
  });

  test.afterAll(async () => {
    await cleanupE2eEntities();
    await prisma.$disconnect();
  });

  test('creates partner, seller, deal, outreach, and campaign via UI', async ({ authenticatedPage: page }) => {
    const stamp = buildStamp();
    const partnerName = `E2E 생성 거래처 ${stamp}`;
    const sellerName = `E2E 셀러 ${stamp}`;
    const sellerAlias = `E2E별칭${stamp}`;
    const sellerHandle = `e2e_seller_${stamp}`;
    const dealName = `E2E 생성 딜 ${stamp}`;
    const brandName = `E2E 브랜드 ${stamp}`;
    const expectedCampaignName = `${dealName} - ${sellerAlias}`;

    const partnersPage = new PartnersPage(page);
    const sellersPage = new SellersPage(page);
    const dealsPage = new DealsPage(page);
    const outreachPage = new OutreachPage(page);
    const campaignsPage = new CampaignsPage(page);

    await partnersPage.goto();
    await partnersPage.createPartner({
      name: partnerName,
      type: 'BRAND',
      representativeEmail: `tax-${stamp}@example.com`,
    });
    await expect(page.getByText(partnerName).first()).toBeVisible();

    await sellersPage.goto();
    await sellersPage.createSeller({
      name: sellerName,
      alias: sellerAlias,
      snsType: 'Instagram',
      snsHandle: sellerHandle,
    });
    await expect(page.getByText(sellerAlias).first()).toBeVisible();

    await dealsPage.goto();
    await dealsPage.createDeal({
      dealName,
      partnerName,
      brandName,
      costPrice: 10000,
      sellingPrice: 15000,
    });
    await expect(page.getByText(dealName).first()).toBeVisible();

    await outreachPage.goto();
    await outreachPage.createOutreachViaUi({
      dealName,
      sellerName: sellerAlias,
      proposalMessage: 'E2E 제안 메모',
    });
    await expect(page.getByText(dealName).first()).toBeVisible();
    await expect(page.getByText(sellerAlias).first()).toBeVisible();

    await campaignsPage.goto();
    const campaignDefaults = await campaignsPage.createDirectCampaign({
      dealName,
      sellerName: sellerAlias,
    });
    expect(campaignDefaults.selectedDealName).toContain(dealName);
    expect(campaignDefaults.selectedSellerName).toContain(sellerAlias);

    await expect
      .poll(async () => {
        const campaign = await prisma.salesCampaign.findFirst({
          where: { campaignName: expectedCampaignName },
          select: { campaignName: true },
        });
        return campaign?.campaignName ?? null;
      })
      .toBe(expectedCampaignName);
  });
});
