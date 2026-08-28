import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { requireRole } from "@/lib/api-auth";
import { DealStatus } from "@prisma/client";

const ENTITY_TYPES = ["partners", "sellers", "deals"] as const;

const executeRequestSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  validRows: z.array(z.record(z.string(), z.unknown())),
});

export async function POST(request: Request) {
  // Import requires admin role
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  try {
    const body = await request.json();
    const parsed = executeRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { entityType, validRows } = parsed.data;
    const prisma = getPrisma();

    let createdCount = 0;
    let skippedCount = 0;

    const isSqlite = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.startsWith("file:");

    switch (entityType) {
      case "partners": {
        if (isSqlite) {
          for (const row of validRows) {
            try {
              await prisma.partner.create({
                data: {
                  name: row.name as string,
                  type: row.type as string,
                  contactInfo: (row.contactInfo as string) || null,
                  bankAccount: (row.bankAccount as string) || null,
                  companyStatus: (row.companyStatus as string) || null,
                  companyRole: (row.companyRole as string) || null,
                  notes: (row.notes as string) || null,
                },
              });
              createdCount++;
            } catch (error) {
              if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002") {
                skippedCount++;
              } else {
                skippedCount++;
                console.error("Partner import error:", error);
              }
            }
          }
        } else {
          const result = await prisma.partner.createMany({
            data: validRows.map((row) => ({
              name: row.name as string,
              type: row.type as string,
              contactInfo: (row.contactInfo as string) || null,
              bankAccount: (row.bankAccount as string) || null,
              companyStatus: (row.companyStatus as string) || null,
              companyRole: (row.companyRole as string) || null,
              notes: (row.notes as string) || null,
            })),
            skipDuplicates: true,
          });
          createdCount = result.count;
          skippedCount = validRows.length - result.count;
        }
        break;
      }

      case "sellers": {
        // Sellers have unique constraint on [snsType, snsHandle]
        // Process individually to handle duplicates gracefully
        for (const row of validRows) {
          try {
            await prisma.seller.create({
              data: {
                name: row.name as string,
                snsType: row.snsType as string,
                snsHandle: row.snsHandle as string,
                currentFollowers: (row.currentFollowers as number) || 0,
                category: (row.category as string) || null,
                notes: (row.notes as string) || null,
              },
            });
            createdCount++;
          } catch (error: unknown) {
            // Skip duplicates (P2002 = unique constraint violation)
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "P2002"
            ) {
              skippedCount++;
            } else {
              skippedCount++;
              console.error("Seller import error:", error);
            }
          }
        }
        break;
      }

      case "deals": {
        if (isSqlite) {
          for (const row of validRows) {
            try {
              await prisma.deal.create({
                data: {
                  dealName: row.dealName as string,
                  partnerId: row.partnerId as string,
                  costPrice: row.costPrice as number,
                  sellingPrice: row.sellingPrice as number,
                  brandName: (row.brandName as string) || null,
                  partnerCompanyName: (row.partnerCompanyName as string) || null,
                  status: ((row.status as string) || "SOURCING") as DealStatus,
                  sourcingMemo: (row.sourcingMemo as string) || null,
                  baseMarginPolicy: JSON.stringify({
                    byChannel: { default: { totalMarginRate: 0, sellerMarginRate: 0 } },
                  }),
                },
              });
              createdCount++;
            } catch (error) {
              if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002") {
                skippedCount++;
              } else {
                skippedCount++;
                console.error("Deal import error:", error);
              }
            }
          }
        } else {
          const result = await prisma.deal.createMany({
            data: validRows.map((row) => ({
              dealName: row.dealName as string,
              partnerId: row.partnerId as string,
              costPrice: row.costPrice as number,
              sellingPrice: row.sellingPrice as number,
              brandName: (row.brandName as string) || null,
              partnerCompanyName: (row.partnerCompanyName as string) || null,
              status: ((row.status as string) || "SOURCING") as DealStatus,
              sourcingMemo: (row.sourcingMemo as string) || null,
              baseMarginPolicy: JSON.stringify({
                byChannel: { default: { totalMarginRate: 0, sellerMarginRate: 0 } },
              }),
            })),
            skipDuplicates: true,
          });
          createdCount = result.count;
          skippedCount = validRows.length - result.count;
        }
        break;
      }
    }

    return NextResponse.json({
      entityType,
      createdCount,
      skippedCount,
      totalProcessed: validRows.length,
    });
  } catch (error) {
    console.error("Import execution error:", error);
    return NextResponse.json(
      { error: "Import execution failed" },
      { status: 500 }
    );
  }
}
