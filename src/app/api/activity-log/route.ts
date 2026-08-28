import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { createMemoSchema } from "@/lib/validations/activity-log";
import { recordActivityMemo } from "@/lib/activity-log";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const entityType = searchParams.get("entityType");
  const entityId = searchParams.get("entityId");
  const typeFilter = searchParams.get("type");
  const limit = parseInt(searchParams.get("limit") || "50", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  if (!entityType || !entityId) {
    return NextResponse.json(
      { error: "entityType and entityId are required query parameters" },
      { status: 400 },
    );
  }

  const where: Record<string, unknown> = { entityType, entityId };
  if (typeFilter) {
    where.type = typeFilter;
  }

  const [entries, total] = await Promise.all([
    getPrisma().activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    getPrisma().activityLog.count({
      where,
    }),
  ]);

  return NextResponse.json({ entries, total });
}

export async function POST(request: Request) {
  const parsed = createMemoSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { entityType, entityId, content, actor } = parsed.data;
  const entry = await recordActivityMemo(entityType, entityId, content, actor);
  return NextResponse.json(entry, { status: 201 });
}
