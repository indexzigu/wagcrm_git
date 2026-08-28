import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { linkDealRequestSchema } from "@/lib/validations/link";
import { changeDealPartner, unlinkDealFromPartner } from "@/lib/link-manager";

type Context = {
  params: Promise<{ dealId: string }>;
};

/**
 * PATCH /api/links/deal/[dealId]
 * Changes the partner linked to a deal.
 *
 * Requirements: 5.4, 5.6, 9.3, 9.7, 11.1, 11.3, 11.5
 */
export async function PATCH(request: Request, context: Context) {
  // 1. Auth check
  const auth = await requireAuth();
  if (!auth.authenticated) {
    return auth.response;
  }

  // 2. Extract dealId from route params
  const { dealId } = await context.params;
  if (!dealId) {
    return NextResponse.json(
      { error: "딜 ID가 필요합니다" },
      { status: 400 }
    );
  }

  // 3. Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "유효하지 않은 요청 본문입니다" },
      { status: 400 }
    );
  }

  const parsed = linkDealRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { partnerId } = parsed.data;

  // 4. Call LinkManager service
  try {
    const result = await changeDealPartner(
      dealId,
      partnerId,
      auth.context.email
    );

    // 5. Return updated deal data + logWarning if any
    return NextResponse.json({
      ...result.data,
      ...(result.logWarning ? { logWarning: result.logWarning } : {}),
    });
  } catch (error: unknown) {
    // Handle Prisma "not found" errors
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "딜 또는 거래처를 찾을 수 없습니다" },
        { status: 404 }
      );
    }

    // Server error
    console.error("[PATCH /api/links/deal] Error:", error);
    return NextResponse.json(
      { error: "연결 변경에 실패했습니다. 다시 시도해주세요." },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/links/deal/[dealId]
 * Removes the partner link from a deal (sets partnerId to null).
 */
export async function DELETE(request: Request, context: Context) {
  // 1. Auth check
  const auth = await requireAuth();
  if (!auth.authenticated) {
    return auth.response;
  }

  // 2. Extract dealId from route params
  const { dealId } = await context.params;
  if (!dealId) {
    return NextResponse.json(
      { error: "딜 ID가 필요합니다" },
      { status: 400 }
    );
  }

  // 3. Call LinkManager service
  try {
    const result = await unlinkDealFromPartner(
      dealId,
      auth.context.email
    );

    return NextResponse.json({
      dealId: result.data.id,
      unlinked: true,
    });
  } catch (error: unknown) {
    // Handle Prisma "not found" errors
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "딜을 찾을 수 없습니다" },
        { status: 404 }
      );
    }

    // Server error
    console.error("[DELETE /api/links/deal] Error:", error);
    return NextResponse.json(
      { error: "연결 해제에 실패했습니다. 다시 시도해주세요." },
      { status: 500 }
    );
  }
}
