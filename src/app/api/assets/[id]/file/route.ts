import { NextResponse } from "next/server";
import { readLocalAsset } from "@/lib/asset-storage";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const asset = await getPrisma().asset.findUnique({ where: { id } });
  if (!asset?.storagePath) {
    return NextResponse.json({ error: "Local asset not found" }, { status: 404 });
  }

  try {
    const file = await readLocalAsset(asset.storagePath);
    return new NextResponse(file, {
      headers: {
        "Content-Type": asset.mimeType ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${encodeURIComponent(asset.fileName)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Local asset file is missing" }, { status: 404 });
  }
}
