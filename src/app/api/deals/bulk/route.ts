import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { createDealSchema } from "@/lib/validations/deal";
import { requireAuth } from "@/lib/api-auth";
import { recordActivityCreate } from "@/lib/activity-log";
import { getAuthContext } from "@/lib/auth-context";

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const body = await request.json();
    const { deals } = body;
    
    if (!Array.isArray(deals) || deals.length === 0) {
      return NextResponse.json(
        { error: "Invalid deals array. Must be a non-empty array under key 'deals'." },
        { status: 400 }
      );
    }

    const authCtx = await getAuthContext();
    const actor = authCtx?.email ?? "SYSTEM";
    const createdDeals: unknown[] = [];

    // Transaction to ensure all or nothing
    await getPrisma().$transaction(async (tx) => {
      for (const d of deals) {
        const parsed = createDealSchema.safeParse(d);
        if (!parsed.success) {
          throw new Error(`Validation failed: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
        }

        const { baseMarginPolicy, ...rest } = parsed.data;

        const created = await tx.deal.create({
          data: {
            ...rest,
            baseMarginPolicy: JSON.stringify(baseMarginPolicy),
            status: "SOURCING",
          },
          select: {
            id: true,
            dealName: true,
            partnerId: true,
            costPrice: true,
            sellingPrice: true,
            baseMarginPolicy: true,
            status: true,
            dealType: true,
            parentDealId: true,
            createdAt: true,
            updatedAt: true,
          }
        });

        await recordActivityCreate("DEAL", created.id, actor);
        createdDeals.push(created);
      }
    });

    return NextResponse.json(
      { success: true, count: createdDeals.length, deals: createdDeals },
      { status: 201 }
    );
  } catch (error) {
    console.error("Bulk deal creation failed:", error);
    const message = error instanceof Error ? error.message : "Bulk deal creation failed due to database or validation error.";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
