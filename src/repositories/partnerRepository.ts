import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export class PartnerRepository {
  /**
   * `take` 는 순수 추가다 — 넘기지 않으면 예전처럼 전량을 돌려준다. 조회 도구가
   * 상한(+1로 truncated 판정)을 걸 수 있어야 해서 열었다.
   */
  static async findMany(params: {
    where?: Prisma.PartnerWhereInput;
    orderBy?: Prisma.PartnerOrderByWithRelationInput;
    select?: Prisma.PartnerSelect;
    take?: number;
  }) {
    return getPrisma().partner.findMany({
      where: params.where,
      orderBy: params.orderBy,
      select: params.select,
      take: params.take,
    });
  }

  static async findById(id: string, select?: Prisma.PartnerSelect) {
    return getPrisma().partner.findUnique({
      where: { id },
      select,
    });
  }

  static async findByIdOrThrow(id: string, select?: Prisma.PartnerSelect) {
    const partner = await this.findById(id, select);
    if (!partner) {
      throw new Error("해당 거래처를 찾을 수 없습니다.");
    }
    return partner;
  }

  static async create(data: Prisma.PartnerCreateInput) {
    return getPrisma().partner.create({
      data,
    });
  }

  static async update(id: string, data: Prisma.PartnerUpdateInput) {
    return getPrisma().partner.update({
      where: { id },
      data,
    });
  }

  static async delete(id: string) {
    return getPrisma().partner.delete({
      where: { id },
    });
  }

  static async findContactById(contactId: string) {
    return getPrisma().partnerContact.findUnique({
      where: { id: contactId },
    });
  }

  static async createContact(data: Prisma.PartnerContactUncheckedCreateInput) {
    return getPrisma().partnerContact.create({
      data,
    });
  }

  static async updateContact(contactId: string, data: Prisma.PartnerContactUpdateInput) {
    return getPrisma().partnerContact.update({
      where: { id: contactId },
      data,
    });
  }

  static async deleteContact(contactId: string) {
    return getPrisma().partnerContact.delete({
      where: { id: contactId },
    });
  }
}
