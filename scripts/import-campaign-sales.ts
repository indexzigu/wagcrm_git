import { PrismaClient } from '@prisma/client';
import * as xlsx from 'xlsx';
import fs from 'fs';

const prisma = new PrismaClient();

const parseDecimal = (val: string | number | undefined | null) => {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return val;
  const num = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(num) ? null : num;
};

const parseIntOrNull = (val: string | number | undefined | null) => {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return Math.floor(val);
  const num = parseInt(String(val).replace(/,/g, ''), 10);
  return isNaN(num) ? null : num;
};

const parseBoolean = (val: string | boolean | undefined | null) => {
  if (typeof val === 'boolean') return val;
  if (!val) return false;
  return String(val).toUpperCase() === 'TRUE';
};

const parseDate = (val: string | number | undefined | null) => {
  if (!val || val === '') return undefined;
  if (typeof val === 'number') {
    const unixDate = (val - 25569) * 86400 * 1000;
    return new Date(unixDate);
  }
  const date = new Date(String(val).trim());
  return isNaN(date.getTime()) ? undefined : date;
};

const normalize = (val: any) => {
  if (!val) return val;
  return String(val).normalize('NFC').trim();
};

async function main() {
  const filename = process.argv[2] || 'campaign_sales_export.xlsx';
  if (!fs.existsSync(filename)) {
    console.error(`File not found: ${filename}`);
    console.log(`Usage: npm run data:sales:import [filename]`);
    process.exit(1);
  }

  console.log(`Reading from ${filename}...`);
  const workbook = xlsx.readFile(filename);
  const sheetName = workbook.SheetNames[0];
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]) as any[];
  
  console.log(`Found ${rows.length} rows to process.`);

  let updatedCount = 0;
  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const row of rows) {
    try {
      const rowId = row.id?.trim();
      const newDealName = normalize(row['딜이름']);
      const newSellerName = normalize(row['셀러명']);
      const newTaxType = normalize(row['세무유형']);

      // 1. 새 캠페인 생성 로직 (ID가 없는 경우)
      if (!rowId) {
        if (!newDealName || !newSellerName) {
          console.error(`Skipping new row: Missing dealName or sellerName`);
          errorCount++;
          continue;
        }

        // 딜과 셀러를 이름으로 찾기
        const deal = await prisma.deal.findFirst({ where: { dealName: newDealName } });
        const seller = await prisma.seller.findFirst({ where: { name: newSellerName } });

        if (!deal) {
          console.error(`Cannot create campaign: Deal '${newDealName}' not found`);
          errorCount++;
          continue;
        }
        if (!seller) {
          console.error(`Cannot create campaign: Seller '${newSellerName}' not found`);
          errorCount++;
          continue;
        }
        
        const startDate = parseDate(row['캠페인시작일']);
        const endDate = parseDate(row['캠페인마감일']);

        if (!startDate || !endDate) {
          console.error(`Cannot create campaign: Missing valid start or end date`);
          errorCount++;
          continue;
        }

        // 멱등성 보장: 같은 파일을 재실행해도 중복 생성되지 않도록 기존 캠페인 조회
        // (차수가 있으면 딜+셀러+차수, 없으면 딜+셀러+기간으로 판별)
        const roundNumber = parseIntOrNull(row['캠페인차수']);
        const duplicate = await prisma.salesCampaign.findFirst({
          where: {
            dealId: deal.id,
            sellerId: seller.id,
            ...(roundNumber !== null ? { roundNumber } : { startDate, endDate }),
          },
        });
        if (duplicate) {
          console.log(`[Skipped] 이미 존재: Deal '${newDealName}', Seller '${newSellerName}'${roundNumber !== null ? ` ${roundNumber}차` : ''} (id: ${duplicate.id})`);
          skippedCount++;
          continue;
        }

        await prisma.salesCampaign.create({
          data: {
            dealId: deal.id,
            sellerId: seller.id,
            startDate,
            endDate,
            roundNumber,
            sellerTaxType: newTaxType || 'UNKNOWN',
            salesChannel: 'UNKNOWN', // 필수값이므로 임시 지정 (추후 CRM에서 수정 필요)
            baseNaverLink: '-',      // 필수값이므로 임시 지정
            generatedTrackingLink: '-', // 필수값이므로 임시 지정
            actualSales: parseDecimal(row['실매출']),
            quantity: parseIntOrNull(row['주문수']),
            totalMarginRate: parseDecimal(row['전체수수료율']) ?? 0,
            sellerMarginRate: parseDecimal(row['셀러수수료율']) ?? 0,
            netMarginRate: parseDecimal(row['순수수료율']) ?? 0,
            sellerExpense: parseDecimal(row['셀러부담금']),
            taxExpense: parseDecimal(row['세금부담금']),
            shippingFee: parseDecimal(row['배송비']),
            freeShippingThreshold: parseDecimal(row['무료배송기준']),
            miscExpense: parseDecimal(row['기타비용']),
            isManualMargin: parseBoolean(row['수기 마진 여부']),
            isManualSettlementSales: parseBoolean(row['수기 정산매출 여부']),
            isManualSellerExpense: parseBoolean(row['수기 셀러부담 여부']),
            isManualTaxExpense: parseBoolean(row['수기 세금부담 여부']),
          }
        });

        console.log(`[Created] New campaign for Deal: ${newDealName}, Seller: ${newSellerName}`);
        createdCount++;
        continue;
      }

      // 2. 기존 캠페인 업데이트 로직 (ID가 있는 경우)
      const existing = await prisma.salesCampaign.findUnique({
        where: { id: rowId },
        include: { deal: true, seller: true }
      });

      if (!existing) {
        console.error(`Campaign not found: ${rowId}`);
        errorCount++;
        continue;
      }

      await prisma.salesCampaign.update({
        where: { id: rowId },
        data: {
          startDate: parseDate(row['캠페인시작일']) ?? existing.startDate,
          endDate: parseDate(row['캠페인마감일']) ?? existing.endDate,
          roundNumber: parseIntOrNull(row['캠페인차수']),
          sellerTaxType: newTaxType !== undefined ? newTaxType : existing.sellerTaxType,
          actualSales: parseDecimal(row['실매출']),
          quantity: parseIntOrNull(row['주문수']),
          totalMarginRate: parseDecimal(row['전체수수료율']) ?? 0,
          sellerMarginRate: parseDecimal(row['셀러수수료율']) ?? 0,
          netMarginRate: parseDecimal(row['순수수료율']) ?? 0,
          sellerExpense: parseDecimal(row['셀러부담금']),
          taxExpense: parseDecimal(row['세금부담금']),
          shippingFee: parseDecimal(row['배송비']),
          freeShippingThreshold: parseDecimal(row['무료배송기준']),
          miscExpense: parseDecimal(row['기타비용']),
          isManualMargin: parseBoolean(row['수기 마진 여부']),
          isManualSettlementSales: parseBoolean(row['수기 정산매출 여부']),
          isManualSellerExpense: parseBoolean(row['수기 셀러부담 여부']),
          isManualTaxExpense: parseBoolean(row['수기 세금부담 여부']),
        },
      });

      // 딜 이름 업데이트 (변경된 경우)
      if (newDealName && newDealName !== existing.deal.dealName) {
        await prisma.deal.update({
          where: { id: existing.dealId },
          data: { dealName: newDealName }
        });
        console.log(`[Deal Update] ${existing.deal.dealName} -> ${newDealName}`);
      }

      // 셀러 이름 업데이트 (변경된 경우)
      if (newSellerName && newSellerName !== existing.seller.name) {
        await prisma.seller.update({
          where: { id: existing.sellerId },
          data: { name: newSellerName }
        });
        console.log(`[Seller Update] ${existing.seller.name} -> ${newSellerName}`);
      }

      updatedCount++;
    } catch (e: any) {
      console.error(`Failed to process row (ID: ${row.id || 'NEW'}): ${e.message}`);
      errorCount++;
    }
  }

  console.log(`\nImport Summary:`);
  console.log(`- Successfully updated: ${updatedCount}`);
  console.log(`- Successfully created: ${createdCount}`);
  console.log(`- Skipped (already exists): ${skippedCount}`);
  console.log(`- Errors: ${errorCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
