import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

// GET /api/campaigns/[id]/notes — 노트 목록 조회
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const prisma = getPrisma();
  const notes = await prisma.campaignNote.findMany({
    where: { campaignId: id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    notes: notes.map((note) => ({
      id: note.id,
      campaignId: note.campaignId,
      content: note.content,
      actor: note.actor,
      actorName: note.actorName,
      createdAt: note.createdAt.toISOString(),
    })),
  });
}

// POST /api/campaigns/[id]/notes — 노트 추가
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const { content, actor, actorName } = body as {
    content: string;
    actor: string;
    actorName?: string;
  };

  if (!content?.trim()) {
    return NextResponse.json({ error: "내용을 입력해주세요." }, { status: 400 });
  }
  if (!actor?.trim()) {
    return NextResponse.json({ error: "작성자 정보가 없습니다." }, { status: 400 });
  }

  const prisma = getPrisma();
  const note = await prisma.campaignNote.create({
    data: {
      campaignId: id,
      content: content.trim(),
      actor: actor.trim(),
      actorName: actorName?.trim() || null,
    },
  });

  return NextResponse.json({
    id: note.id,
    campaignId: note.campaignId,
    content: note.content,
    actor: note.actor,
    actorName: note.actorName,
    createdAt: note.createdAt.toISOString(),
  });
}

// DELETE /api/campaigns/[id]/notes?noteId=xxx — 노트 삭제
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const noteId = req.nextUrl.searchParams.get("noteId");

  if (!noteId) {
    return NextResponse.json({ error: "noteId가 필요합니다." }, { status: 400 });
  }

  const prisma = getPrisma();
  const existing = await prisma.campaignNote.findFirst({
    where: {
      id: noteId,
      campaignId: id,
    },
    select: {
      id: true,
    },
  });

  if (!existing) {
    return NextResponse.json({ error: "노트를 찾을 수 없습니다." }, { status: 404 });
  }

  await prisma.campaignNote.delete({
    where: {
      id: noteId,
    },
  });
  return NextResponse.json({ ok: true });
}
