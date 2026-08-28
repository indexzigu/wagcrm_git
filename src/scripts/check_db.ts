import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const campaigns = await prisma.salesCampaign.findMany({
    include: {
      deal: { include: { partner: true } },
      seller: true,
    }
  });

  console.log(`Total campaigns in DB: ${campaigns.length}`);
  campaigns.forEach((c) => {
    console.log(`ID: ${c.id} | Deal: ${c.deal?.dealName} | Seller: ${c.seller?.name} | Round: ${c.roundNumber} | Status: ${c.status}`);
  });
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
