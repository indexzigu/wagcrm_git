import { connection, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

export type DealProfitabilityRow = {
  dealId: string;
  dealName: string;
  partnerName: string;
  totalRevenue: number;
  totalMargin: number;
  campaignCount: number;
  bestSeller: { id: string; name: string; sales: number } | null;
};

type ProfitabilityResponse = {
  deals: DealProfitabilityRow[];
  sortBy: string;
  sortOrder: "asc" | "desc";
};

const VALID_SORT_FIELDS = ["totalRevenue", "totalMargin", "campaignCount"] as const;
type SortField = (typeof VALID_SORT_FIELDS)[number];

export async function GET(request: Request) {
  await connection();

  try {
    const url = new URL(request.url);
    const sortByParam = url.searchParams.get("sortBy") ?? "totalRevenue";
    const sortOrderParam = url.searchParams.get("sortOrder") ?? "desc";

    const sortBy: SortField = VALID_SORT_FIELDS.includes(sortByParam as SortField)
      ? (sortByParam as SortField)
      : "totalRevenue";
    const sortOrder: "asc" | "desc" = sortOrderParam === "asc" ? "asc" : "desc";

    const prisma = getPrisma();

    // Query deals that have at least one campaign with non-null actualSales
    const deals = await prisma.deal.findMany({
      where: {
        campaigns: {
          some: {
            actualSales: { not: null },
          },
        },
      },
      include: {
        partner: {
          select: { name: true },
        },
        campaigns: {
          select: {
            id: true,
            actualSales: true,
            netMarginRate: true,
            sellerId: true,
            createdAt: true,
            seller: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });

    // Compute profitability metrics for each deal
    const rows: DealProfitabilityRow[] = deals.map((deal) => {
      let totalRevenue = 0;
      let totalMargin = 0;
      let campaignCount = 0;
      let bestSeller: { id: string; name: string; sales: number } | null = null;
      let bestCreatedAt: Date | null = null;

      for (const campaign of deal.campaigns) {
        if (campaign.actualSales == null) continue;

        const sales = Number(campaign.actualSales.toString());
        campaignCount++;
        totalRevenue += sales;

        // Margin: actualSales × netMarginRate / 100 (only if both are non-null)
        if (campaign.netMarginRate != null) {
          const marginRate = Number(campaign.netMarginRate.toString());
          totalMargin += sales * marginRate / 100;
        }

        // Best seller: highest actualSales, tie-break by earliest createdAt
        if (
          bestSeller === null ||
          sales > bestSeller.sales ||
          (sales === bestSeller.sales && campaign.createdAt < bestCreatedAt!)
        ) {
          bestSeller = {
            id: campaign.seller.id,
            name: campaign.seller.name,
            sales,
          };
          bestCreatedAt = campaign.createdAt;
        }
      }

      return {
        dealId: deal.id,
        dealName: deal.dealName,
        partnerName: deal.partner?.name ?? "거래처 없음",
        totalRevenue,
        totalMargin,
        campaignCount,
        bestSeller,
      };
    });

    // Sort the results
    rows.sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });

    const response: ProfitabilityResponse = { deals: rows, sortBy, sortOrder };
    return NextResponse.json(response);
  } catch (error) {
    console.error("Deal profitability API error:", error);
    return NextResponse.json(
      { error: "Failed to compute deal profitability" },
      { status: 500 },
    );
  }
}
