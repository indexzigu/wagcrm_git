-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('SOURCING', 'NEGOTIATING', 'CONFIRMED', 'SAMPLE_TESTING', 'ARCHIVED', 'DROPPED');

-- CreateTable
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT,
    "contactInfo" TEXT,
    "bankAccount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "referredById" TEXT,
    "companyRole" TEXT,
    "companyStatus" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "notes" TEXT,
    "businessNumber" TEXT,
    "address" TEXT,
    "bizSyncedAt" TIMESTAMP(3),
    "ceoName" TEXT,
    "businessType" TEXT,
    "businessItem" TEXT,
    "representativeEmail" TEXT,
    "orderTemplateSlug" TEXT,
    "orderDisplayName" TEXT,
    "orderEmailDomains" TEXT,
    "orderFormatAdapter" TEXT,
    "orderToEmail" TEXT,
    "orderCcEmail" TEXT,
    "orderExcelRules" JSONB,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seller" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "snsType" TEXT NOT NULL,
    "snsHandle" TEXT NOT NULL,
    "currentFollowers" INTEGER NOT NULL DEFAULT 0,
    "currentPostsCount" INTEGER,
    "profileBio" TEXT,
    "profilePicUrl" TEXT,
    "profileExternalUrls" TEXT,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "agencyId" TEXT,
    "accountNumber" TEXT,
    "residentNumber" TEXT,
    "activityFrequency" TEXT,
    "adResponseScore" TEXT,
    "channelUrl" TEXT,
    "collaborationScore" TEXT,
    "commentResponseScore" TEXT,
    "email" TEXT,
    "fitLevel" TEXT,
    "lastReviewedAt" TIMESTAMP(3),
    "mailingAddress" TEXT,
    "notes" TEXT,
    "personalCategory" TEXT,
    "phoneNumber" TEXT,
    "proposalProduct" TEXT,
    "proposalStatus" TEXT,
    "proposalWaitlist" TEXT,
    "reviewer" TEXT,
    "isMonitored" BOOLEAN NOT NULL DEFAULT false,
    "alias" TEXT,
    "portalToken" TEXT,
    "portalSlug" TEXT,
    "portalPasswordHash" TEXT,
    "portalAuthFailCount" INTEGER NOT NULL DEFAULT 0,
    "portalAuthLockedUntil" TIMESTAMP(3),
    "acquisitionChannel" TEXT,
    "referredById" TEXT,
    "acquisitionNote" TEXT,
    "availabilityNote" TEXT,
    "availabilityUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellersHistory" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL,
    "followersCount" INTEGER NOT NULL,
    "postsCount" INTEGER,
    "profileBio" TEXT,
    "profilePicUrl" TEXT,
    "profileExternalUrls" TEXT,
    "source" TEXT NOT NULL DEFAULT 'INTERNAL',
    "er" DOUBLE PRECISION,
    "avgLikes" DOUBLE PRECISION,
    "avgComments" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellersHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerProfileBioHistory" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousBio" TEXT,
    "bio" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'INTERNAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerProfileBioHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "dealName" TEXT NOT NULL,
    "costPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "baseMarginPolicy" TEXT NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'SOURCING',
    "partnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sellingPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "brandName" TEXT,
    "brokerageCommissionRate" DECIMAL(65,30),
    "candidateSellers" TEXT,
    "discountRate" DECIMAL(65,30),
    "floorPrice" DECIMAL(65,30),
    "listPrice" DECIMAL(65,30),
    "partnerCompanyName" TEXT,
    "sourcingMemo" TEXT,
    "totalCommissionRate" DECIMAL(65,30),
    "supplyPrice" DOUBLE PRECISION,
    "optionSortOrder" INTEGER NOT NULL DEFAULT 0,
    "dealType" TEXT NOT NULL DEFAULT 'MAIN',
    "parentDealId" TEXT,
    "unit" TEXT,
    "unitQuantity" INTEGER,
    "supplementaryInfo" TEXT,
    "shippingFee" DECIMAL(65,30),
    "freeShippingThreshold" DECIMAL(65,30),
    "monitorEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesCampaign" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "salesChannel" TEXT NOT NULL,
    "baseNaverLink" TEXT NOT NULL,
    "generatedTrackingLink" TEXT NOT NULL,
    "actualSales" DECIMAL(65,30),
    "totalMarginRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sellerMarginRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "netMarginRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PROPOSAL',
    "isManualMargin" BOOLEAN NOT NULL DEFAULT false,
    "isManualSettlementSales" BOOLEAN NOT NULL DEFAULT false,
    "isManualSellerExpense" BOOLEAN NOT NULL DEFAULT false,
    "isManualTaxExpense" BOOLEAN NOT NULL DEFAULT false,
    "assignedTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "itemCount" INTEGER,
    "nextAction" TEXT,
    "notesFromImport" TEXT,
    "operatingExpense" DECIMAL(65,30),
    "operatingProfit" DECIMAL(65,30),
    "orderCount" INTEGER,
    "rawSchedule" TEXT,
    "salesCode" TEXT,
    "sellerExpense" DECIMAL(65,30),
    "settlementDeposit" DECIMAL(65,30),
    "settlementPayout" DECIMAL(65,30),
    "settlementSales" DECIMAL(65,30),
    "sourceCreatedAt" TIMESTAMP(3),
    "actualPayoutAmount" DECIMAL(65,30),
    "commissionBasis" TEXT,
    "isDepositReceived" BOOLEAN NOT NULL DEFAULT false,
    "isPayoutCompleted" BOOLEAN NOT NULL DEFAULT false,
    "miscExpense" DECIMAL(65,30),
    "roundNumber" INTEGER,
    "sellerTaxType" TEXT,
    "taxExpense" DECIMAL(65,30),
    "depositReceivedAt" TIMESTAMP(3),
    "payoutCompletedAt" TIMESTAMP(3),
    "campaignName" TEXT,
    "accountingCompletedAt" TIMESTAMP(3),
    "expectedDepositDate" TIMESTAMP(3),
    "expectedPayoutDate" TIMESTAMP(3),
    "returnPeriodEndDate" TIMESTAMP(3),
    "sellerInvoiceIssuedAt" TIMESTAMP(3),
    "settlementSupplyCost" DECIMAL(65,30),
    "supplierInvoiceIssuedAt" TIMESTAMP(3),
    "shippingFee" DECIMAL(65,30),
    "freeShippingThreshold" DECIMAL(65,30),
    "calendarEventIds" TEXT,
    "groupId" TEXT,
    "orderCampaignId" TEXT,

    CONSTRAINT "SalesCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBuyerFingerprint" (
    "id" TEXT NOT NULL,
    "salesCampaignId" TEXT NOT NULL,
    "buyerHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignBuyerFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignGroup" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "name" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "expectedDepositDate" TIMESTAMP(3),
    "depositReceivedAt" TIMESTAMP(3),
    "isDepositReceived" BOOLEAN NOT NULL DEFAULT false,
    "expectedPayoutDate" TIMESTAMP(3),
    "payoutCompletedAt" TIMESTAMP(3),
    "isPayoutCompleted" BOOLEAN NOT NULL DEFAULT false,
    "supplierInvoiceIssuedAt" TIMESTAMP(3),
    "sellerInvoiceIssuedAt" TIMESTAMP(3),
    "accountingCompletedAt" TIMESTAMP(3),
    "returnPeriodEndDate" TIMESTAMP(3),
    "invoiceInfo" TEXT,
    "calendarEventIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignChecklistTemplate" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignChecklistItem" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "templateId" TEXT,
    "status" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "isChecked" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerContact" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phoneNumber" TEXT,
    "notes" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignActivity" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "details" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'SYSTEM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignNote" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "campaignId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "storagePath" TEXT,
    "externalFileId" TEXT,
    "externalUrl" TEXT,
    "thumbnailUrl" TEXT,
    "notes" TEXT,
    "likeCount" INTEGER,
    "commentCount" INTEGER,
    "likesHidden" BOOLEAN,
    "engagementSyncedAt" TIMESTAMP(3),
    "mediaType" TEXT,
    "videoUrl" TEXT,
    "postedAt" TIMESTAMP(3),
    "uploadedBy" TEXT,
    "archivedAt" TIMESTAMP(3),
    "driveShortcutId" TEXT,
    "driveParentFolderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageIntegration" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "accountEmail" TEXT,
    "rootFolderId" TEXT,
    "encryptedRefreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCallLog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "permissionScope" TEXT,
    "endpoint" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "requestId" TEXT,
    "errorMessage" TEXT,
    "calledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" TEXT,

    CONSTRAINT "ApiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingAttribution" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "ntSource" TEXT,
    "ntMedium" TEXT,
    "ntDetail" TEXT,
    "landingUrl" TEXT,
    "conversionEvent" TEXT NOT NULL,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fieldName" TEXT,
    "previousValue" TEXT,
    "newValue" TEXT,
    "content" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'SYSTEM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dealId" TEXT,
    "salesChannel" TEXT,
    "marginSettings" TEXT,
    "trackingPattern" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerOutreach" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "linkedCampaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerOutreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesTask" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "contactChannel" TEXT DEFAULT 'DM',
    "proposalMessage" TEXT,
    "negotiationMemo" TEXT,
    "testingMemo" TEXT,
    "proposalSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReminderAt" TIMESTAMP(3),
    "nextReminderAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "droppedAt" TIMESTAMP(3),
    "dropReason" TEXT,
    "linkedCampaignId" TEXT,
    "totalMarginRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sellerMarginRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementChecklist" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementChecklistItem" (
    "id" TEXT NOT NULL,
    "checklistId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isChecked" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mentions" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "isDismissed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageTemplate" TEXT,
    "stage" INTEGER,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderSettings" (
    "id" TEXT NOT NULL,
    "settings" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueGoal" (
    "id" TEXT NOT NULL,
    "periodType" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "revenueTarget" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'NOTION',
    "targetDatabase" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportSourceRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "rowHash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetEntity" TEXT,
    "targetId" TEXT,
    "reviewReason" TEXT,
    "rawPayload" TEXT NOT NULL,
    "normalizedData" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelFeeConfig" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "feeRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "paymentRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelFeeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerCategoryAssignment" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerCategoryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDeal" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "actualSales" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "feeRate" DECIMAL(65,30),
    "sellerMarginRate" DECIMAL(65,30),
    "costPrice" DECIMAL(65,30),
    "sellingPrice" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "discordWebhookUrl" TEXT,
    "smtpEmail" TEXT,
    "smtpPassword" TEXT,
    "alertEmails" TEXT,
    "notificationPreferences" TEXT,
    "instagramAccessToken" TEXT,
    "instagramTokenExpiresAt" TIMESTAMP(3),
    "instagramTokenRefreshedAt" TIMESTAMP(3),
    "instagramTokenLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template" TEXT,
    "sellerName" TEXT NOT NULL,
    "toEmail" TEXT,
    "ccEmail" TEXT,
    "thumbnailUrl" TEXT,
    "category" TEXT,
    "productStatus" TEXT,
    "salePeriod" TEXT,
    "productId" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "cachedNewOrderBeforeCount" INTEGER DEFAULT 0,
    "cachedNewOrderAfterCount" INTEGER DEFAULT 0,
    "cachedPendingCount" INTEGER DEFAULT 0,
    "cachedShippingCount" INTEGER DEFAULT 0,
    "cachedCompletedCount" INTEGER DEFAULT 0,
    "cachedTotalOrders" INTEGER DEFAULT 0,
    "cachedDistinctOrderCount" INTEGER DEFAULT 0,
    "cachedTotalQuantity" INTEGER DEFAULT 0,
    "cachedTotalRevenue" INTEGER DEFAULT 0,
    "cachedDailyStats" JSONB,
    "cachedProductOrderIds" JSONB,
    "cachedSettledAmount" INTEGER,
    "cachedSettleFeeAmount" INTEGER,
    "cachedSettleFeeBreakdown" JSONB,
    "cachedUnsettledAmount" INTEGER,
    "cachedSettledCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyOrderTask" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sentFileName" TEXT,
    "receivedFileName" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyOrderTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "optionName" TEXT NOT NULL,
    "brandCode" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "campaignDealId" TEXT,

    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NaverOrderSnapshot" (
    "id" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "orders" JSONB NOT NULL,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "newOrdersCount" INTEGER NOT NULL DEFAULT 0,
    "preparingCount" INTEGER NOT NULL DEFAULT 0,
    "deliveringCount" INTEGER NOT NULL DEFAULT 0,
    "isDirty" BOOLEAN NOT NULL DEFAULT false,
    "lastCallTime" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncType" TEXT DEFAULT 'FULL',
    "lastChangeStatusCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NaverOrderSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderFulfillmentState" (
    "id" TEXT NOT NULL,
    "productOrderId" TEXT NOT NULL,
    "campaignId" TEXT,
    "poRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderFulfillmentState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceMonitorSnapshot" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "campaignId" TEXT,
    "snapshotDate" TEXT NOT NULL,
    "searchQuery" TEXT NOT NULL,
    "ourUnitPrice" DOUBLE PRECISION,
    "minValidPrice" DOUBLE PRECISION,
    "verdict" TEXT NOT NULL,
    "validCount" INTEGER NOT NULL DEFAULT 0,
    "rawResults" JSONB NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceMonitorSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionProposal" (
    "id" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'READ',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "resultSummary" TEXT,
    "dataSources" JSONB,
    "assumptions" JSONB,
    "structuredResult" JSONB,
    "evidence" JSONB,
    "risks" JSONB,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "nextActions" JSONB,
    "payload" JSONB,
    "targetEntityType" TEXT,
    "targetEntityId" TEXT,
    "campaignId" TEXT,
    "executionResult" JSONB,
    "executedRefType" TEXT,
    "executedRefId" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'AGENT',
    "approvedBy" TEXT,
    "executedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "llmModel" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "latencyMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionProposalEvent" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'SYSTEM',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionProposalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantConversation" (
    "id" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "toolCalls" JSONB,
    "toolCallsTruncated" BOOLEAN NOT NULL DEFAULT false,
    "actionProposalIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkRecord" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "roomKey" TEXT,
    "sender" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "rawText" TEXT NOT NULL,
    "summary" TEXT,
    "actionItems" JSONB,
    "isMasked" BOOLEAN NOT NULL DEFAULT false,
    "entityType" TEXT,
    "entityId" TEXT,
    "campaignId" TEXT,
    "attributedBy" TEXT,
    "ingestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatRoomMapping" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'KAKAO',
    "roomKey" TEXT NOT NULL,
    "roomName" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "roomType" TEXT,
    "collectorType" TEXT NOT NULL DEFAULT 'KATOK_AUTO',
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "sourceFolderId" TEXT,
    "campaignId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatRoomMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSheet" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT,
    "sourceFormat" TEXT NOT NULL,
    "extractPath" TEXT NOT NULL DEFAULT 'A',
    "assetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "detectedTables" INTEGER NOT NULL DEFAULT 1,
    "policyText" TEXT,
    "columnMapping" JSONB,
    "reviewNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL DEFAULT 'AGENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSheetRow" (
    "id" TEXT NOT NULL,
    "priceSheetId" TEXT NOT NULL,
    "rowHash" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "tableSegment" INTEGER NOT NULL DEFAULT 0,
    "productName" TEXT,
    "optionName" TEXT,
    "sellingPrice" DECIMAL(65,30),
    "commissionRate" DECIMAL(65,30),
    "supplyPrice" DECIMAL(65,30),
    "listPrice" DECIMAL(65,30),
    "floorPrice" DECIMAL(65,30),
    "discountRate" DECIMAL(65,30),
    "note" TEXT,
    "flags" JSONB,
    "rawCells" JSONB NOT NULL,
    "mappingStatus" TEXT NOT NULL DEFAULT 'UNMAPPED',
    "mappedDealId" TEXT,
    "mappedCampaignDealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceSheetRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerAiProfile" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "aiTags" JSONB,
    "compositeScore" INTEGER,
    "confidence" TEXT,
    "sourceTier" TEXT,
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerAiProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceInboxItem" (
    "id" TEXT NOT NULL,
    "rawUrl" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "linkName" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceRoomKey" TEXT,
    "sourceRef" TEXT,
    "thumbnailUrl" TEXT,
    "videoUrl" TEXT,
    "igUsername" TEXT,
    "igProfilePicUrl" TEXT,
    "igFullName" TEXT,
    "igBio" TEXT,
    "igFollowerCount" INTEGER,
    "igPostCount" INTEGER,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceInboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NaverSettlementCase" (
    "id" TEXT NOT NULL,
    "productOrderId" TEXT NOT NULL,
    "orderId" TEXT,
    "productId" TEXT,
    "productOrderType" TEXT,
    "settleType" TEXT,
    "payDate" TIMESTAMP(3),
    "settleExpectDate" TIMESTAMP(3),
    "settleCompleteDate" TIMESTAMP(3),
    "paySettleAmount" INTEGER NOT NULL DEFAULT 0,
    "totalPayCommissionAmount" INTEGER NOT NULL DEFAULT 0,
    "sellingInterlockCommissionAmount" INTEGER NOT NULL DEFAULT 0,
    "freeInstallmentCommissionAmount" INTEGER NOT NULL DEFAULT 0,
    "benefitSettleAmount" INTEGER NOT NULL DEFAULT 0,
    "settleExpectAmount" INTEGER NOT NULL DEFAULT 0,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NaverSettlementCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderActionLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "details" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'SYSTEM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemTaskStatus" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "nextExpectedRunAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemTaskStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemTaskLog" (
    "id" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemTaskLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerStorySnapshot" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "storyPk" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "expiringAt" TIMESTAMP(3),
    "mediaType" INTEGER NOT NULL DEFAULT 1,
    "thumbnailUrl" TEXT,
    "sourceImageUrl" TEXT,
    "sourceVideoUrl" TEXT,
    "caption" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "classification" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "classifiedAt" TIMESTAMP(3),
    "salesCampaignId" TEXT,

    CONSTRAINT "SellerStorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Partner_orderTemplateSlug_key" ON "Partner"("orderTemplateSlug");

-- CreateIndex
CREATE INDEX "Partner_type_idx" ON "Partner"("type");

-- CreateIndex
CREATE INDEX "Partner_name_idx" ON "Partner"("name");

-- CreateIndex
CREATE INDEX "Partner_referredById_idx" ON "Partner"("referredById");

-- CreateIndex
CREATE UNIQUE INDEX "Seller_portalToken_key" ON "Seller"("portalToken");

-- CreateIndex
CREATE UNIQUE INDEX "Seller_portalSlug_key" ON "Seller"("portalSlug");

-- CreateIndex
CREATE INDEX "Seller_category_idx" ON "Seller"("category");

-- CreateIndex
CREATE INDEX "Seller_agencyId_idx" ON "Seller"("agencyId");

-- CreateIndex
CREATE INDEX "Seller_referredById_idx" ON "Seller"("referredById");

-- CreateIndex
CREATE UNIQUE INDEX "Seller_snsType_snsHandle_key" ON "Seller"("snsType", "snsHandle");

-- CreateIndex
CREATE INDEX "SellersHistory_snapshotDate_idx" ON "SellersHistory"("snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "SellersHistory_sellerId_snapshotDate_key" ON "SellersHistory"("sellerId", "snapshotDate");

-- CreateIndex
CREATE INDEX "SellerProfileBioHistory_sellerId_collectedAt_idx" ON "SellerProfileBioHistory"("sellerId", "collectedAt");

-- CreateIndex
CREATE INDEX "Deal_status_idx" ON "Deal"("status");

-- CreateIndex
CREATE INDEX "Deal_partnerId_idx" ON "Deal"("partnerId");

-- CreateIndex
CREATE INDEX "Deal_parentDealId_idx" ON "Deal"("parentDealId");

-- CreateIndex
CREATE INDEX "SalesCampaign_status_idx" ON "SalesCampaign"("status");

-- CreateIndex
CREATE INDEX "SalesCampaign_dealId_idx" ON "SalesCampaign"("dealId");

-- CreateIndex
CREATE INDEX "SalesCampaign_sellerId_idx" ON "SalesCampaign"("sellerId");

-- CreateIndex
CREATE INDEX "SalesCampaign_startDate_endDate_idx" ON "SalesCampaign"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "SalesCampaign_assignedTo_idx" ON "SalesCampaign"("assignedTo");

-- CreateIndex
CREATE INDEX "SalesCampaign_salesCode_idx" ON "SalesCampaign"("salesCode");

-- CreateIndex
CREATE INDEX "SalesCampaign_groupId_idx" ON "SalesCampaign"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesCampaign_dealId_sellerId_roundNumber_key" ON "SalesCampaign"("dealId", "sellerId", "roundNumber");

-- CreateIndex
CREATE INDEX "CampaignBuyerFingerprint_salesCampaignId_idx" ON "CampaignBuyerFingerprint"("salesCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignBuyerFingerprint_salesCampaignId_buyerHash_key" ON "CampaignBuyerFingerprint"("salesCampaignId", "buyerHash");

-- CreateIndex
CREATE INDEX "CampaignGroup_sellerId_idx" ON "CampaignGroup"("sellerId");

-- CreateIndex
CREATE INDEX "CampaignGroup_startDate_endDate_idx" ON "CampaignGroup"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "CampaignChecklistTemplate_status_sortOrder_idx" ON "CampaignChecklistTemplate"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "CampaignChecklistTemplate_isActive_idx" ON "CampaignChecklistTemplate"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignChecklistTemplate_status_label_key" ON "CampaignChecklistTemplate"("status", "label");

-- CreateIndex
CREATE INDEX "CampaignChecklistItem_campaignId_status_sortOrder_idx" ON "CampaignChecklistItem"("campaignId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "CampaignChecklistItem_templateId_idx" ON "CampaignChecklistItem"("templateId");

-- CreateIndex
CREATE INDEX "CampaignChecklistItem_status_isChecked_idx" ON "CampaignChecklistItem"("status", "isChecked");

-- CreateIndex
CREATE INDEX "PartnerContact_partnerId_name_idx" ON "PartnerContact"("partnerId", "name");

-- CreateIndex
CREATE INDEX "PartnerContact_lastContactAt_idx" ON "PartnerContact"("lastContactAt");

-- CreateIndex
CREATE INDEX "CampaignActivity_campaignId_createdAt_idx" ON "CampaignActivity"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignActivity_action_createdAt_idx" ON "CampaignActivity"("action", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignNote_campaignId_createdAt_idx" ON "CampaignNote"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_entityType_entityId_idx" ON "Asset"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Asset_campaignId_idx" ON "Asset"("campaignId");

-- CreateIndex
CREATE INDEX "Asset_provider_idx" ON "Asset"("provider");

-- CreateIndex
CREATE INDEX "Asset_section_idx" ON "Asset"("section");

-- CreateIndex
CREATE INDEX "Asset_archivedAt_idx" ON "Asset"("archivedAt");

-- CreateIndex
CREATE INDEX "Asset_createdAt_idx" ON "Asset"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StorageIntegration_provider_key" ON "StorageIntegration"("provider");

-- CreateIndex
CREATE INDEX "StorageIntegration_status_idx" ON "StorageIntegration"("status");

-- CreateIndex
CREATE INDEX "ApiCallLog_provider_calledAt_idx" ON "ApiCallLog"("provider", "calledAt");

-- CreateIndex
CREATE INDEX "ApiCallLog_permissionScope_calledAt_idx" ON "ApiCallLog"("permissionScope", "calledAt");

-- CreateIndex
CREATE INDEX "ApiCallLog_success_idx" ON "ApiCallLog"("success");

-- CreateIndex
CREATE INDEX "TrackingAttribution_campaignId_idx" ON "TrackingAttribution"("campaignId");

-- CreateIndex
CREATE INDEX "TrackingAttribution_ntSource_ntMedium_ntDetail_idx" ON "TrackingAttribution"("ntSource", "ntMedium", "ntDetail");

-- CreateIndex
CREATE INDEX "TrackingAttribution_createdAt_idx" ON "TrackingAttribution"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_entityId_createdAt_idx" ON "ActivityLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_type_idx" ON "ActivityLog"("type");

-- CreateIndex
CREATE INDEX "ActivityLog_actor_idx" ON "ActivityLog"("actor");

-- CreateIndex
CREATE INDEX "CampaignTemplate_name_idx" ON "CampaignTemplate"("name");

-- CreateIndex
CREATE INDEX "SellerOutreach_dealId_status_idx" ON "SellerOutreach"("dealId", "status");

-- CreateIndex
CREATE INDEX "SellerOutreach_sellerId_idx" ON "SellerOutreach"("sellerId");

-- CreateIndex
CREATE INDEX "SellerOutreach_status_idx" ON "SellerOutreach"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SellerOutreach_dealId_sellerId_key" ON "SellerOutreach"("dealId", "sellerId");

-- CreateIndex
CREATE INDEX "SalesTask_dealId_status_idx" ON "SalesTask"("dealId", "status");

-- CreateIndex
CREATE INDEX "SalesTask_sellerId_status_idx" ON "SalesTask"("sellerId", "status");

-- CreateIndex
CREATE INDEX "SalesTask_status_nextReminderAt_idx" ON "SalesTask"("status", "nextReminderAt");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementChecklist_campaignId_key" ON "SettlementChecklist"("campaignId");

-- CreateIndex
CREATE INDEX "SettlementChecklistItem_checklistId_sortOrder_idx" ON "SettlementChecklistItem"("checklistId", "sortOrder");

-- CreateIndex
CREATE INDEX "Comment_entityType_entityId_createdAt_idx" ON "Comment"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_authorId_idx" ON "Comment"("authorId");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_entityType_entityId_type_createdAt_idx" ON "Notification"("entityType", "entityId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueGoal_periodKey_key" ON "RevenueGoal"("periodKey");

-- CreateIndex
CREATE INDEX "RevenueGoal_periodType_periodKey_idx" ON "RevenueGoal"("periodType", "periodKey");

-- CreateIndex
CREATE INDEX "ImportBatch_sourceSystem_createdAt_idx" ON "ImportBatch"("sourceSystem", "createdAt");

-- CreateIndex
CREATE INDEX "ImportBatch_targetDatabase_status_idx" ON "ImportBatch"("targetDatabase", "status");

-- CreateIndex
CREATE INDEX "ImportSourceRecord_sourceTable_action_idx" ON "ImportSourceRecord"("sourceTable", "action");

-- CreateIndex
CREATE INDEX "ImportSourceRecord_targetEntity_targetId_idx" ON "ImportSourceRecord"("targetEntity", "targetId");

-- CreateIndex
CREATE INDEX "ImportSourceRecord_rowHash_idx" ON "ImportSourceRecord"("rowHash");

-- CreateIndex
CREATE UNIQUE INDEX "ImportSourceRecord_batchId_sourceTable_sourceKey_key" ON "ImportSourceRecord"("batchId", "sourceTable", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelFeeConfig_channel_key" ON "ChannelFeeConfig"("channel");

-- CreateIndex
CREATE UNIQUE INDEX "SellerCategory_name_key" ON "SellerCategory"("name");

-- CreateIndex
CREATE INDEX "SellerCategoryAssignment_sellerId_idx" ON "SellerCategoryAssignment"("sellerId");

-- CreateIndex
CREATE INDEX "SellerCategoryAssignment_categoryId_idx" ON "SellerCategoryAssignment"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerCategoryAssignment_sellerId_categoryId_key" ON "SellerCategoryAssignment"("sellerId", "categoryId");

-- CreateIndex
CREATE INDEX "CampaignDeal_campaignId_idx" ON "CampaignDeal"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignDeal_dealId_idx" ON "CampaignDeal"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDeal_campaignId_dealId_key" ON "CampaignDeal"("campaignId", "dealId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyOrderTask_campaignId_date_key" ON "DailyOrderTask"("campaignId", "date");

-- CreateIndex
CREATE INDEX "NaverOrderSnapshot_lastCallTime_idx" ON "NaverOrderSnapshot"("lastCallTime");

-- CreateIndex
CREATE UNIQUE INDEX "NaverOrderSnapshot_snapshotDate_key" ON "NaverOrderSnapshot"("snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFulfillmentState_productOrderId_key" ON "OrderFulfillmentState"("productOrderId");

-- CreateIndex
CREATE INDEX "OrderFulfillmentState_campaignId_idx" ON "OrderFulfillmentState"("campaignId");

-- CreateIndex
CREATE INDEX "OrderFulfillmentState_poRequestedAt_idx" ON "OrderFulfillmentState"("poRequestedAt");

-- CreateIndex
CREATE INDEX "PriceMonitorSnapshot_dealId_snapshotDate_idx" ON "PriceMonitorSnapshot"("dealId", "snapshotDate");

-- CreateIndex
CREATE INDEX "PriceMonitorSnapshot_campaignId_idx" ON "PriceMonitorSnapshot"("campaignId");

-- CreateIndex
CREATE INDEX "PriceMonitorSnapshot_verdict_snapshotDate_idx" ON "PriceMonitorSnapshot"("verdict", "snapshotDate");

-- CreateIndex
CREATE INDEX "ActionProposal_status_createdAt_idx" ON "ActionProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ActionProposal_kind_status_idx" ON "ActionProposal"("kind", "status");

-- CreateIndex
CREATE INDEX "ActionProposal_targetEntityType_targetEntityId_idx" ON "ActionProposal"("targetEntityType", "targetEntityId");

-- CreateIndex
CREATE INDEX "ActionProposal_campaignId_idx" ON "ActionProposal"("campaignId");

-- CreateIndex
CREATE INDEX "ActionProposal_createdBy_idx" ON "ActionProposal"("createdBy");

-- CreateIndex
CREATE INDEX "ActionProposalEvent_proposalId_createdAt_idx" ON "ActionProposalEvent"("proposalId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantConversation_createdBy_updatedAt_idx" ON "AssistantConversation"("createdBy", "updatedAt");

-- CreateIndex
CREATE INDEX "AssistantChatMessage_conversationId_createdAt_idx" ON "AssistantChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkRecord_entityType_entityId_idx" ON "WorkRecord"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "WorkRecord_campaignId_idx" ON "WorkRecord"("campaignId");

-- CreateIndex
CREATE INDEX "WorkRecord_roomKey_sentAt_idx" ON "WorkRecord"("roomKey", "sentAt");

-- CreateIndex
CREATE INDEX "WorkRecord_sentAt_idx" ON "WorkRecord"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkRecord_source_sourceHash_key" ON "WorkRecord"("source", "sourceHash");

-- CreateIndex
CREATE INDEX "ChatRoomMapping_entityType_entityId_idx" ON "ChatRoomMapping"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ChatRoomMapping_campaignId_idx" ON "ChatRoomMapping"("campaignId");

-- CreateIndex
CREATE INDEX "ChatRoomMapping_sourceFolderId_idx" ON "ChatRoomMapping"("sourceFolderId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatRoomMapping_source_roomKey_key" ON "ChatRoomMapping"("source", "roomKey");

-- CreateIndex
CREATE INDEX "PriceSheet_partnerId_idx" ON "PriceSheet"("partnerId");

-- CreateIndex
CREATE INDEX "PriceSheet_status_createdAt_idx" ON "PriceSheet"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PriceSheetRow_priceSheetId_tableSegment_rowIndex_idx" ON "PriceSheetRow"("priceSheetId", "tableSegment", "rowIndex");

-- CreateIndex
CREATE INDEX "PriceSheetRow_mappingStatus_idx" ON "PriceSheetRow"("mappingStatus");

-- CreateIndex
CREATE INDEX "PriceSheetRow_mappedDealId_idx" ON "PriceSheetRow"("mappedDealId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceSheetRow_priceSheetId_rowHash_key" ON "PriceSheetRow"("priceSheetId", "rowHash");

-- CreateIndex
CREATE UNIQUE INDEX "SellerAiProfile_sellerId_key" ON "SellerAiProfile"("sellerId");

-- CreateIndex
CREATE INDEX "SellerAiProfile_compositeScore_idx" ON "SellerAiProfile"("compositeScore");

-- CreateIndex
CREATE INDEX "SellerAiProfile_confidence_idx" ON "SellerAiProfile"("confidence");

-- CreateIndex
CREATE INDEX "ReferenceInboxItem_status_createdAt_idx" ON "ReferenceInboxItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReferenceInboxItem_normalizedUrl_idx" ON "ReferenceInboxItem"("normalizedUrl");

-- CreateIndex
CREATE INDEX "NaverSettlementCase_productOrderId_idx" ON "NaverSettlementCase"("productOrderId");

-- CreateIndex
CREATE INDEX "NaverSettlementCase_settleCompleteDate_idx" ON "NaverSettlementCase"("settleCompleteDate");

-- CreateIndex
CREATE INDEX "NaverSettlementCase_productId_idx" ON "NaverSettlementCase"("productId");

-- CreateIndex
CREATE INDEX "OrderActionLog_campaignId_createdAt_idx" ON "OrderActionLog"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderActionLog_action_createdAt_idx" ON "OrderActionLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "OrderActionLog_status_idx" ON "OrderActionLog"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SystemTaskStatus_jobKey_key" ON "SystemTaskStatus"("jobKey");

-- CreateIndex
CREATE INDEX "SystemTaskStatus_status_idx" ON "SystemTaskStatus"("status");

-- CreateIndex
CREATE INDEX "SystemTaskLog_jobKey_createdAt_idx" ON "SystemTaskLog"("jobKey", "createdAt");

-- CreateIndex
CREATE INDEX "SellerStorySnapshot_classification_capturedAt_idx" ON "SellerStorySnapshot"("classification", "capturedAt");

-- CreateIndex
CREATE INDEX "SellerStorySnapshot_sellerId_takenAt_idx" ON "SellerStorySnapshot"("sellerId", "takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "SellerStorySnapshot_sellerId_storyPk_key" ON "SellerStorySnapshot"("sellerId", "storyPk");

-- AddForeignKey
ALTER TABLE "Partner" ADD CONSTRAINT "Partner_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seller" ADD CONSTRAINT "Seller_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seller" ADD CONSTRAINT "Seller_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellersHistory" ADD CONSTRAINT "SellersHistory_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerProfileBioHistory" ADD CONSTRAINT "SellerProfileBioHistory_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_parentDealId_fkey" FOREIGN KEY ("parentDealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCampaign" ADD CONSTRAINT "SalesCampaign_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CampaignGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCampaign" ADD CONSTRAINT "SalesCampaign_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCampaign" ADD CONSTRAINT "SalesCampaign_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesCampaign" ADD CONSTRAINT "SalesCampaign_orderCampaignId_fkey" FOREIGN KEY ("orderCampaignId") REFERENCES "OrderCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBuyerFingerprint" ADD CONSTRAINT "CampaignBuyerFingerprint_salesCampaignId_fkey" FOREIGN KEY ("salesCampaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignGroup" ADD CONSTRAINT "CampaignGroup_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignChecklistItem" ADD CONSTRAINT "CampaignChecklistItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignChecklistItem" ADD CONSTRAINT "CampaignChecklistItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CampaignChecklistTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerContact" ADD CONSTRAINT "PartnerContact_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignActivity" ADD CONSTRAINT "CampaignActivity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNote" ADD CONSTRAINT "CampaignNote_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingAttribution" ADD CONSTRAINT "TrackingAttribution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTemplate" ADD CONSTRAINT "CampaignTemplate_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerOutreach" ADD CONSTRAINT "SellerOutreach_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerOutreach" ADD CONSTRAINT "SellerOutreach_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTask" ADD CONSTRAINT "SalesTask_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTask" ADD CONSTRAINT "SalesTask_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementChecklist" ADD CONSTRAINT "SettlementChecklist_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementChecklistItem" ADD CONSTRAINT "SettlementChecklistItem_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "SettlementChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportSourceRecord" ADD CONSTRAINT "ImportSourceRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerCategoryAssignment" ADD CONSTRAINT "SellerCategoryAssignment_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "SellerCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerCategoryAssignment" ADD CONSTRAINT "SellerCategoryAssignment_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDeal" ADD CONSTRAINT "CampaignDeal_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDeal" ADD CONSTRAINT "CampaignDeal_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyOrderTask" ADD CONSTRAINT "DailyOrderTask_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OrderCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskLog" ADD CONSTRAINT "TaskLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DailyOrderTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OrderCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_campaignDealId_fkey" FOREIGN KEY ("campaignDealId") REFERENCES "CampaignDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceMonitorSnapshot" ADD CONSTRAINT "PriceMonitorSnapshot_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionProposal" ADD CONSTRAINT "ActionProposal_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionProposalEvent" ADD CONSTRAINT "ActionProposalEvent_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ActionProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantChatMessage" ADD CONSTRAINT "AssistantChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkRecord" ADD CONSTRAINT "WorkRecord_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatRoomMapping" ADD CONSTRAINT "ChatRoomMapping_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSheet" ADD CONSTRAINT "PriceSheet_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSheetRow" ADD CONSTRAINT "PriceSheetRow_priceSheetId_fkey" FOREIGN KEY ("priceSheetId") REFERENCES "PriceSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSheetRow" ADD CONSTRAINT "PriceSheetRow_mappedDealId_fkey" FOREIGN KEY ("mappedDealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerStorySnapshot" ADD CONSTRAINT "SellerStorySnapshot_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

