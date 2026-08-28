import { getPrisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export const dealRepository = {
  findMany<T extends Prisma.DealFindManyArgs>(args: Prisma.SelectSubset<T, Prisma.DealFindManyArgs>) {
    return getPrisma().deal.findMany<T>(args);
  },

  findUnique<T extends Prisma.DealFindUniqueArgs>(args: Prisma.SelectSubset<T, Prisma.DealFindUniqueArgs>) {
    return getPrisma().deal.findUnique<T>(args);
  },

  findFirst<T extends Prisma.DealFindFirstArgs>(args: Prisma.SelectSubset<T, Prisma.DealFindFirstArgs>) {
    return getPrisma().deal.findFirst<T>(args);
  },

  create<T extends Prisma.DealCreateArgs>(args: Prisma.SelectSubset<T, Prisma.DealCreateArgs>) {
    return getPrisma().deal.create<T>(args);
  },

  update<T extends Prisma.DealUpdateArgs>(args: Prisma.SelectSubset<T, Prisma.DealUpdateArgs>) {
    return getPrisma().deal.update<T>(args);
  },

  delete(id: string) {
    return getPrisma().deal.delete({
      where: { id },
    });
  },

  countLinkedCampaigns(dealId: string) {
    return getPrisma().salesCampaign.count({
      where: { dealId },
    });
  },
};
