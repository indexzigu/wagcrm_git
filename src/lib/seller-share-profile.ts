import { getPrisma } from "@/lib/prisma";

const sellerShareSelect = {
  name: true,
  alias: true,
  snsHandle: true,
  currentFollowers: true,
  category: true,
  profileBio: true,
  profilePicUrl: true,
} as const;

export async function findSellerShareProfileById(id: string) {
  return getPrisma().seller.findUnique({
    where: { id },
    select: sellerShareSelect,
  });
}

export async function findSellerShareProfileByToken(portalToken: string) {
  return getPrisma().seller.findUnique({
    where: { portalToken },
    select: sellerShareSelect,
  });
}
