import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { getAuthContext } from "@/lib/auth-context";
import { parseMentions, resolveMentions } from "@/lib/mention-parser";
import { getCrmUsers } from "@/lib/user-registry";

const VALID_ENTITY_TYPES = ["PARTNER", "DEAL", "CAMPAIGN", "SELLER"] as const;

const createCommentSchema = z.object({
  entityType: z.enum(VALID_ENTITY_TYPES),
  entityId: z.string().min(1),
  content: z.string(),
});

export async function POST(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = createCommentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { entityType, entityId, content } = parsed.data;

  // Reject empty or whitespace-only content
  if (!content.trim()) {
    return NextResponse.json(
      { error: "Comment content cannot be empty" },
      { status: 400 },
    );
  }

  try {
    const prisma = getPrisma();

    // Parse mentions from content
    const mentionedUsernames = parseMentions(content);

    // Resolve mentions against user registry
    const users = await getCrmUsers();
    const resolvedUserIds = resolveMentions(mentionedUsernames, users);

    // Get author display name from user registry
    const authorUser = users.find((u) => u.id === auth.userId);
    const authorName =
      authorUser?.displayName ?? auth.email.split("@")[0] ?? "Unknown";

    // Persist the comment
    const comment = await prisma.comment.create({
      data: {
        entityType,
        entityId,
        authorId: auth.userId,
        authorName,
        content,
        mentions: JSON.stringify(resolvedUserIds),
      },
    });

    // 멘션은 comment.mentions에 저장만 한다 — MENTION 알림 생성은 알림센터
    // 해체와 함께 제거(2026-07-24). 1인 운영 체제에서 수신자가 본인뿐이었다.

    return NextResponse.json(comment, { status: 201 });
  } catch (error) {
    console.error("[api/comments] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const entityType = searchParams.get("entityType");
  const entityId = searchParams.get("entityId");

  if (!entityType || !entityId) {
    return NextResponse.json(
      { error: "entityType and entityId query params are required" },
      { status: 400 },
    );
  }

  if (!VALID_ENTITY_TYPES.includes(entityType as (typeof VALID_ENTITY_TYPES)[number])) {
    return NextResponse.json(
      { error: "Invalid entity type" },
      { status: 400 },
    );
  }

  try {
    const prisma = getPrisma();
    const comments = await prisma.comment.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(comments);
  } catch (error) {
    console.error("[api/comments] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
