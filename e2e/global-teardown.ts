/**
 * Global teardown: cleans up all test data created during the E2E run.
 * Deletes records in FK-safe order using the E2E_TEST_ prefix.
 */
import { getE2ePrismaClient } from './fixtures/test-prisma';
import { TEST_PREFIX } from './fixtures/test-data';

async function globalTeardown() {
  const prisma = getE2ePrismaClient();

  try {
    // ─── Collect entity IDs before deletion (needed for ActivityLog/Notification cleanup)
    const testPartnerIds = (
      await prisma.partner.findMany({
        where: { name: { startsWith: TEST_PREFIX } },
        select: { id: true },
      })
    ).map((r: { id: string }) => r.id);

    const testSellerIds = (
      await prisma.seller.findMany({
        where: { name: { startsWith: TEST_PREFIX } },
        select: { id: true },
      })
    ).map((r: { id: string }) => r.id);

    const testDealIds = (
      await prisma.deal.findMany({
        where: { dealName: { startsWith: TEST_PREFIX } },
        select: { id: true },
      })
    ).map((r: { id: string }) => r.id);

    const testCampaignIds = (
      await prisma.salesCampaign.findMany({
        where: { deal: { dealName: { startsWith: TEST_PREFIX } } },
        select: { id: true },
      })
    ).map((r: { id: string }) => r.id);

    const testOutreachIds = (
      await prisma.salesTask.findMany({
        where: { deal: { dealName: { startsWith: TEST_PREFIX } } },
        select: { id: true },
      })
    ).map((r: { id: string }) => r.id);

    // ─── Delete in FK-safe order ───────────────────────────────────────────────

    // 1. SettlementChecklistItems
    await prisma.settlementChecklistItem.deleteMany({
      where: {
        checklist: {
          campaign: {
            deal: {
              dealName: { startsWith: TEST_PREFIX },
            },
          },
        },
      },
    });

    // 2. SettlementChecklists
    await prisma.settlementChecklist.deleteMany({
      where: {
        campaign: {
          deal: {
            dealName: { startsWith: TEST_PREFIX },
          },
        },
      },
    });

    // 3. CampaignActivity
    await prisma.campaignActivity.deleteMany({
      where: {
        campaign: {
          deal: {
            dealName: { startsWith: TEST_PREFIX },
          },
        },
      },
    });

    // 4. CampaignNotes
    await prisma.campaignNote.deleteMany({
      where: {
        campaign: {
          deal: {
            dealName: { startsWith: TEST_PREFIX },
          },
        },
      },
    });

    // 5. SalesCampaigns
    await prisma.salesCampaign.deleteMany({
      where: {
        deal: {
          dealName: { startsWith: TEST_PREFIX },
        },
      },
    });

    // 6. SalesTasks (Outreach)
    await prisma.salesTask.deleteMany({
      where: {
        deal: {
          dealName: { startsWith: TEST_PREFIX },
        },
      },
    });

    // 6-1. Legacy SellerOutreach rows (compat cleanup)
    await prisma.sellerOutreach.deleteMany({
      where: {
        deal: {
          dealName: { startsWith: TEST_PREFIX },
        },
      },
    });

    // 7. Deals
    await prisma.deal.deleteMany({
      where: {
        dealName: { startsWith: TEST_PREFIX },
      },
    });

    // 8. Sellers
    await prisma.seller.deleteMany({
      where: {
        name: { startsWith: TEST_PREFIX },
      },
    });

    // 9. Partners
    await prisma.partner.deleteMany({
      where: {
        name: { startsWith: TEST_PREFIX },
      },
    });

    // ─── Delete ActivityLog entries for test entities ───────────────────────────
    const activityLogEntityIds = [
      ...testPartnerIds,
      ...testSellerIds,
      ...testDealIds,
      ...testCampaignIds,
    ];

    if (activityLogEntityIds.length > 0) {
      await prisma.activityLog.deleteMany({
        where: {
          entityId: { in: activityLogEntityIds },
        },
      });
    }

    // ─── Delete Notification entries for test entities ──────────────────────────
    const notificationEntityIds = [...testCampaignIds, ...testOutreachIds];

    if (notificationEntityIds.length > 0) {
      await prisma.notification.deleteMany({
        where: {
          entityId: { in: notificationEntityIds },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

export default globalTeardown;
