import { PrismaClient } from '@prisma/client';
import * as xlsx from 'xlsx';

const prisma = new PrismaClient();

async function main() {
  const campaigns = await prisma.salesCampaign.findMany({
    include: {
      deal: true,
      seller: true,
    },
    orderBy: {
      startDate: 'desc',
    },
  });

  const data = campaigns.map((c, index) => ({
    'No.': index + 1,
    id: c.id,
    '딜이름': c.deal.dealName ? c.deal.dealName.normalize('NFC') : '',
    '셀러명': c.seller.name ? c.seller.name.normalize('NFC') : '',
    '캠페인차수': c.roundNumber || '',
    '캠페인시작일': c.startDate.toISOString().split('T')[0],
    '캠페인마감일': c.endDate.toISOString().split('T')[0],
    '세무유형': c.sellerTaxType ? c.sellerTaxType.normalize('NFC') : '',
    '실매출': c.actualSales?.toNumber() || '',
    '주문수': c.quantity || '',
    '전체수수료율': c.totalMarginRate?.toNumber() || '',
    '셀러수수료율': c.sellerMarginRate?.toNumber() || '',
    '순수수료율': c.netMarginRate?.toNumber() || '',
    '셀러부담금': c.sellerExpense?.toNumber() || '',
    '세금부담금': c.taxExpense?.toNumber() || '',
    '배송비': c.shippingFee?.toNumber() || '',
    '무료배송기준': c.freeShippingThreshold?.toNumber() || '',
    '기타비용': c.miscExpense?.toNumber() || '',
    '수기 마진 여부': c.isManualMargin ? 'TRUE' : 'FALSE',
    '수기 정산매출 여부': c.isManualSettlementSales ? 'TRUE' : 'FALSE',
    '수기 셀러부담 여부': c.isManualSellerExpense ? 'TRUE' : 'FALSE',
    '수기 세금부담 여부': c.isManualTaxExpense ? 'TRUE' : 'FALSE',
  }));

  const worksheet = xlsx.utils.json_to_sheet(data);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "CampaignSales");

  const filename = 'campaign_sales_export.xlsx';
  xlsx.writeFile(workbook, filename);
  console.log(`Successfully exported ${data.length} campaigns to ${filename}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
