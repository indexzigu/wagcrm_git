/**
 * Test data constants matching the seeded database state.
 * All entities use the E2E_TEST_ prefix for easy identification and cleanup.
 * IDs are deterministic cuid-like strings so tests can reference them directly.
 */
import { DealStatus } from '@prisma/client';

export const TEST_PREFIX = 'E2E_TEST_';
export const DEFAULT_WORKER_NAMESPACE = 'W0';
const defaultMarginPolicy = JSON.stringify({
  byChannel: {
    OWN_MALL: { totalMarginRate: 0.2, sellerMarginRate: 0.1 },
    SELLER_MALL: { totalMarginRate: 0.2, sellerMarginRate: 0.1 },
    BRAND_MALL: { totalMarginRate: 0.2, sellerMarginRate: 0.1 },
  },
});

// ─── Partners ────────────────────────────────────────────────────────────────

export interface TestPartner {
  id: string;
  name: string;
  type: string;
  contactInfo: string;
}


// ─── Sellers ─────────────────────────────────────────────────────────────────

export interface TestSeller {
  id: string;
  name: string;
  snsType: string;
  snsHandle: string;
  currentFollowers: number;
}


// ─── Deals ───────────────────────────────────────────────────────────────────

export interface TestDeal {
  id: string;
  dealName: string;
  partnerId: string;
  status: DealStatus;
  baseMarginPolicy: string;
  costPrice: number;
  sellingPrice: number;
}


// ─── Outreaches ──────────────────────────────────────────────────────────────

export interface TestOutreach {
  id: string;
  dealId: string;
  sellerId: string;
  status: string;
}


// ─── Campaigns ───────────────────────────────────────────────────────────────

export interface TestCampaign {
  id: string;
  dealId: string;
  sellerId: string;
  status: string;
  salesChannel: string;
  startDate: string;
  endDate: string;
  hasSettlementChecklist: boolean;
}


// ─── Settlement Checklist ────────────────────────────────────────────────────

export interface TestSettlementChecklist {
  id: string;
  campaignId: string;
}


export interface TestChecklistItem {
  id: string;
  checklistId: string;
  label: string;
  sortOrder: number;
  isChecked: boolean;
}

export interface WorkerSeedData {
  testPartners: TestPartner[];
  testSellers: TestSeller[];
  testDeals: TestDeal[];
  testOutreach: TestOutreach[];
  testCampaigns: TestCampaign[];
  testSettlementChecklist: TestSettlementChecklist;
  testChecklistItems: TestChecklistItem[];
}

export function getWorkerNamespace(workerIndex: number): string {
  return `W${workerIndex}`;
}

export function getWorkerSeedData(workerIndex: number): WorkerSeedData {
  return buildSeedData(getWorkerNamespace(workerIndex));
}

export function buildSeedData(namespace: string = DEFAULT_WORKER_NAMESPACE): WorkerSeedData {
  const ns = namespace.toUpperCase();
  const nsSlug = namespace.toLowerCase();

  const testPartners: TestPartner[] = [
    {
      id: `clte2e_${nsSlug}_partner_brand01`,
      name: `${TEST_PREFIX}${ns}_Partner_BrandAlpha`,
      type: 'BRAND',
      contactInfo: 'brand-alpha@example.com',
    },
    {
      id: `clte2e_${nsSlug}_partner_vendor01`,
      name: `${TEST_PREFIX}${ns}_Partner_VendorBeta`,
      type: 'VENDOR',
      contactInfo: 'vendor-beta@example.com',
    },
    {
      id: `clte2e_${nsSlug}_partner_agency01`,
      name: `${TEST_PREFIX}${ns}_Partner_AgencyGamma`,
      type: 'AGENCY',
      contactInfo: 'agency-gamma@example.com',
    },
  ];

  const testSellers: TestSeller[] = [
    {
      id: `clte2e_${nsSlug}_seller_insta01`,
      name: `${TEST_PREFIX}${ns}_Seller_InstaAlpha`,
      snsType: 'INSTAGRAM',
      snsHandle: `e2e_${nsSlug}_insta_alpha`,
      currentFollowers: 85000,
    },
    {
      id: `clte2e_${nsSlug}_seller_yt01`,
      name: `${TEST_PREFIX}${ns}_Seller_YoutubeBeta`,
      snsType: 'YOUTUBE',
      snsHandle: `e2e_${nsSlug}_yt_beta`,
      currentFollowers: 120000,
    },
    {
      id: `clte2e_${nsSlug}_seller_insta02`,
      name: `${TEST_PREFIX}${ns}_Seller_InstaGamma`,
      snsType: 'INSTAGRAM',
      snsHandle: `e2e_${nsSlug}_insta_gamma`,
      currentFollowers: 45000,
    },
  ];

  const testDeals: TestDeal[] = [
    {
      id: `clte2e_${nsSlug}_deal_sourcing01`,
      dealName: `${TEST_PREFIX}${ns}_Deal_Sourcing`,
      partnerId: testPartners[0].id,
      status: 'SOURCING',
      baseMarginPolicy: defaultMarginPolicy,
      costPrice: 10000,
      sellingPrice: 25000,
    },
    {
      id: `clte2e_${nsSlug}_deal_negotiating01`,
      dealName: `${TEST_PREFIX}${ns}_Deal_Negotiating`,
      partnerId: testPartners[0].id,
      status: 'NEGOTIATING',
      baseMarginPolicy: defaultMarginPolicy,
      costPrice: 15000,
      sellingPrice: 35000,
    },
    {
      id: `clte2e_${nsSlug}_deal_archived01`,
      dealName: `${TEST_PREFIX}${ns}_Deal_Archived`,
      partnerId: testPartners[0].id,
      status: 'ARCHIVED',
      baseMarginPolicy: defaultMarginPolicy,
      costPrice: 20000,
      sellingPrice: 45000,
    },
    {
      id: `clte2e_${nsSlug}_deal_dropped01`,
      dealName: `${TEST_PREFIX}${ns}_Deal_Dropped`,
      partnerId: testPartners[1].id,
      status: 'DROPPED',
      baseMarginPolicy: defaultMarginPolicy,
      costPrice: 8000,
      sellingPrice: 18000,
    },
  ];

  const testOutreach: TestOutreach[] = [
    {
      id: `clte2e_${nsSlug}_outreach_01`,
      dealId: testDeals[2].id,
      sellerId: testSellers[0].id,
      status: 'PROPOSED',
    },
  ];

  const testCampaigns: TestCampaign[] = [
    {
      id: `clte2e_${nsSlug}_campaign_proposal01`,
      dealId: testDeals[2].id,
      sellerId: testSellers[0].id,
      status: 'PREPARATION',
      salesChannel: 'BRAND_MALL',
      startDate: '2025-07-01T00:00:00.000Z',
      endDate: '2025-07-31T00:00:00.000Z',
      hasSettlementChecklist: false,
    },
    {
      id: `clte2e_${nsSlug}_campaign_settle01`,
      dealId: testDeals[2].id,
      sellerId: testSellers[1].id,
      status: 'ACTIVE',
      salesChannel: 'SELLER_MALL',
      startDate: '2025-08-01T00:00:00.000Z',
      endDate: '2025-08-31T00:00:00.000Z',
      hasSettlementChecklist: true,
    },
    {
      id: `clte2e_${nsSlug}_campaign_settlement_inprogress01`,
      dealId: testDeals[1].id,
      sellerId: testSellers[0].id,
      status: 'SETTLEMENT_IN_PROGRESS',
      salesChannel: 'OWN_MALL',
      startDate: '2025-09-01T00:00:00.000Z',
      endDate: '2025-09-21T00:00:00.000Z',
      hasSettlementChecklist: true,
    },
    {
      id: `clte2e_${nsSlug}_campaign_settlement_completed01`,
      dealId: testDeals[0].id,
      sellerId: testSellers[2].id,
      status: 'COMPLETED',
      salesChannel: 'SELLER_MALL',
      startDate: '2025-09-01T00:00:00.000Z',
      endDate: '2025-09-18T00:00:00.000Z',
      hasSettlementChecklist: true,
    },
  ];

  const testSettlementChecklist: TestSettlementChecklist = {
    id: `clte2e_${nsSlug}_checklist_01`,
    campaignId: testCampaigns[2].id,
  };

  const testChecklistItems: TestChecklistItem[] = [
    {
      id: `clte2e_${nsSlug}_chkitem_01`,
      checklistId: testSettlementChecklist.id,
      label: '정산 금액 확인',
      sortOrder: 1,
      isChecked: false,
    },
    {
      id: `clte2e_${nsSlug}_chkitem_02`,
      checklistId: testSettlementChecklist.id,
      label: '입금 완료 확인',
      sortOrder: 2,
      isChecked: false,
    },
    {
      id: `clte2e_${nsSlug}_chkitem_03`,
      checklistId: testSettlementChecklist.id,
      label: '셀러 지급 완료',
      sortOrder: 3,
      isChecked: false,
    },
  ];

  return {
    testPartners,
    testSellers,
    testDeals,
    testOutreach,
    testCampaigns,
    testSettlementChecklist,
    testChecklistItems,
  };
}

const defaultSeed = buildSeedData();

export const testPartners: TestPartner[] = defaultSeed.testPartners;
export const testSellers: TestSeller[] = defaultSeed.testSellers;
export const testDeals: TestDeal[] = defaultSeed.testDeals;
export const testOutreach: TestOutreach[] = defaultSeed.testOutreach;
export const testCampaigns: TestCampaign[] = defaultSeed.testCampaigns;
export const testSettlementChecklist: TestSettlementChecklist = defaultSeed.testSettlementChecklist;
export const testChecklistItems: TestChecklistItem[] = defaultSeed.testChecklistItems;
