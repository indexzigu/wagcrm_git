import { getPrisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export const sellerRepository = {
  findMany<T extends Prisma.SellerFindManyArgs>(args: Prisma.SelectSubset<T, Prisma.SellerFindManyArgs>) {
    return getPrisma().seller.findMany<T>(args);
  },

  findUnique<T extends Prisma.SellerFindUniqueArgs>(args: Prisma.SelectSubset<T, Prisma.SellerFindUniqueArgs>) {
    return getPrisma().seller.findUnique<T>(args);
  },

  create<T extends Prisma.SellerCreateArgs>(args: Prisma.SelectSubset<T, Prisma.SellerCreateArgs>) {
    return getPrisma().seller.create<T>(args);
  },

  update<T extends Prisma.SellerUpdateArgs>(args: Prisma.SelectSubset<T, Prisma.SellerUpdateArgs>) {
    return getPrisma().seller.update<T>(args);
  },

  delete(id: string) {
    return getPrisma().seller.delete({
      where: { id },
    });
  },

  countCampaigns(sellerId: string) {
    return getPrisma().salesCampaign.count({
      where: { sellerId },
    });
  },
};
