import { NextRequest, NextResponse } from "next/server";
import { PartnerRepository } from "@/repositories/partnerRepository";
import { PartnerService } from "@/services/partnerService";
import { createPartnerSchema } from "@/lib/validations/partner";
import { getAuthContext } from "@/lib/auth-context";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const type = searchParams.get("type");
  const sortBy = searchParams.get("sortBy");
  const sortDir = searchParams.get("sortDir") as "asc" | "desc" | null;

  // Build Prisma where clause
  const where: Record<string, unknown> = {};
  if (type) where.type = type;

  // Build Prisma orderBy
  const orderBy = sortBy
    ? { [sortBy]: sortDir || "asc" }
    : { updatedAt: "desc" as const };

  const partners = await PartnerRepository.findMany({
    where,
    orderBy,
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      contactInfo: true,
      bankAccount: true,
      businessNumber: true,
      companyStatus: true,
      companyRole: true,
      ceoName: true,
      address: true,
      representativeEmail: true,
      orderTemplateSlug: true,
      orderDisplayName: true,
      orderEmailDomains: true,
      orderFormatAdapter: true,
      orderToEmail: true,
      orderCcEmail: true,
      orderExcelRules: true,
      bizSyncedAt: true,
      referredById: true,
      referredBy: {
        select: { name: true },
      },
      _count: {
        select: { deals: true },
      },
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ partners });
}

export async function POST(request: Request) {
  const parsed = createPartnerSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const auth = await getAuthContext();
  const actor = auth?.email ?? "SYSTEM";

  try {
    const partner = await PartnerService.createPartner(parsed.data, actor);
    revalidateMasterDataCaches();
    return NextResponse.json(partner, { status: 201 });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json({ error: "이미 사용 중인 발주 코드입니다." }, { status: 409 });
    }
    console.error("Partner create failed:", error);
    return NextResponse.json({ error: error.message || "생성에 실패했습니다." }, { status: 500 });
  }
}
