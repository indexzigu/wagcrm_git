import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";

/**
 * POST /api/links/seller-partner
 * Creates or changes a seller-partner link.
 * Sets the seller's agencyId to the given partnerId.
 * If the seller was already linked to another partner, returns previousPartnerId.
 *
 * Requirements: 10.5, 10.6, 10.9, 10.10
 */
export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) {
    return auth.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "유효하지 않은 요청 본문입니다" },
      { status: 400 }
    );
  }

  const { sellerId, partnerId } = body as {
    sellerId?: string;
    partnerId?: string;
  };

  if (!sellerId || !partnerId) {
    return NextResponse.json(
      { error: "sellerId와 partnerId가 필요합니다" },
      { status: 400 }
    );
  }

  const prisma = getPrisma();

  try {
    // Verify both entities exist
    const [seller, partner] = await Promise.all([
      prisma.seller.findUnique({ where: { id: sellerId }, select: { id: true, agencyId: true } }),
      prisma.partner.findUnique({ where: { id: partnerId }, select: { id: true } }),
    ]);

    if (!seller || !partner) {
      return NextResponse.json(
        { error: "셀러 또는 거래처를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const previousPartnerId = seller.agencyId;

    // Update the seller's agencyId to the new partnerId
    await prisma.seller.update({
      where: { id: sellerId },
      data: { agencyId: partnerId },
    });

    return NextResponse.json({
      sellerId,
      partnerId,
      ...(previousPartnerId && previousPartnerId !== partnerId
        ? { previousPartnerId }
        : {}),
    });
  } catch (error: unknown) {
    console.error("[POST /api/links/seller-partner] Error:", error);
    return NextResponse.json(
      { error: "연결에 실패했습니다." },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/links/seller-partner
 * Removes the seller-partner link by setting the seller's agencyId to null.
 *
 * Requirements: 10.5, 10.6, 10.9, 10.10
 */
export async function DELETE(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) {
    return auth.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "유효하지 않은 요청 본문입니다" },
      { status: 400 }
    );
  }

  const { sellerId } = body as { sellerId?: string };

  if (!sellerId) {
    return NextResponse.json(
      { error: "sellerId가 필요합니다" },
      { status: 400 }
    );
  }

  const prisma = getPrisma();

  try {
    // Verify seller exists
    const seller = await prisma.seller.findUnique({
      where: { id: sellerId },
      select: { id: true, agencyId: true },
    });

    if (!seller) {
      return NextResponse.json(
        { error: "셀러 또는 거래처를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // Set agencyId to null to unlink
    await prisma.seller.update({
      where: { id: sellerId },
      data: { agencyId: null },
    });

    return NextResponse.json({
      sellerId,
      unlinked: true,
    });
  } catch (error: unknown) {
    console.error("[DELETE /api/links/seller-partner] Error:", error);
    return NextResponse.json(
      { error: "연결에 실패했습니다." },
      { status: 500 }
    );
  }
}
